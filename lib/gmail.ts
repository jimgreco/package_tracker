import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { pool, query, transaction, enqueue } from "./db";
import { requireReal, requestCookie, type Context } from "./auth";
import {
  AppError,
  configured,
  decrypt,
  encrypt,
  equal,
  hash,
  origin,
  randomToken,
  rateLimit,
} from "./security";
import { receiveEmail } from "./email";
import {
  bodyParts,
  decodeMessage,
  shippingQuery,
  type GmailMessage,
} from "./gmail-message";

export const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const cookieName = "doorstep_gmail";
const redirectUri = () => `${origin()}/api/gmail/callback`;
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 10000 },
);
export function gmailConfigured() {
  return (
    process.env.GMAIL_ENABLED === "true" &&
    !!process.env.GOOGLE_CLIENT_ID &&
    !!process.env.GOOGLE_CLIENT_SECRET
  );
}
export function gmailAvailable(ctx: Context) {
  return (
    gmailConfigured() &&
    (!process.env.GMAIL_HOUSEHOLD_ID ||
      process.env.GMAIL_HOUSEHOLD_ID === ctx.householdId)
  );
}
export function gmailCookie(value = "") {
  return `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value ? 600 : 0}${origin().startsWith("https:") ? "; Secure" : ""}`;
}
export async function gmailStart(ctx: Context, input: unknown) {
  requireReal(ctx);
  if (!gmailAvailable(ctx))
    throw new AppError(
      "Gmail connection is not enabled for this household.",
      503,
    );
  const { importRecent } = z
    .object({ importRecent: z.boolean() })
    .strict()
    .parse(input);
  await rateLimit(`gmail-connect:${ctx.userId}`, 10, 900);
  const [existing] = await query(
    "SELECT household_id FROM gmail_connections WHERE user_id=$1",
    [ctx.userId],
  );
  if (existing && existing.household_id !== ctx.householdId)
    throw new AppError(
      "Disconnect Gmail from your other household before connecting it here.",
      409,
    );
  const state = randomToken(),
    browser = randomToken(),
    nonce = randomToken();
  const verifier = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO gmail_oauth_states(state_hash,browser_hash,verifier,nonce_hash,user_id,household_id,import_since,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now()-$7*interval '1 day',now()+interval '10 minutes')`,
    [
      hash(state),
      hash(browser),
      encrypt(verifier),
      hash(nonce),
      ctx.userId,
      ctx.householdId,
      importRecent ? 30 : 0,
    ],
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: configured("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: `openid email ${gmailScope}`,
    access_type: "offline",
    prompt: "consent",
    login_hint: ctx.email,
    state,
    nonce,
    code_challenge: Buffer.from(hash(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), cookie: gmailCookie(browser) };
}
class GmailAccessError extends AppError {}
class GmailPageExpiredError extends AppError {}
async function tokens(params: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: configured("GOOGLE_CLIENT_ID"),
      client_secret: configured("GOOGLE_CLIENT_SECRET"),
      ...params,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok || typeof data.access_token !== "string") {
    if (data.error === "invalid_grant")
      throw new GmailAccessError(
        "Gmail access expired or was revoked. Reconnect Gmail in Settings.",
      );
    throw new AppError(
      "Google could not authorize Gmail. Please try again.",
      502,
    );
  }
  return data as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
  };
}
export async function gmailCallback(ctx: Context, req: Request) {
  requireReal(ctx);
  if (!gmailAvailable(ctx))
    throw new AppError("Gmail is not enabled for this household.", 503);
  const url = new URL(req.url),
    state = url.searchParams.get("state"),
    browser = requestCookie(req, cookieName);
  if (!state || !browser)
    throw new AppError(
      "Gmail connection expired or started in another browser. Please try again.",
    );
  const [attempt] = await query(
    `DELETE FROM gmail_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND user_id=$3 AND household_id=$4 AND expires_at>now() RETURNING *`,
    [hash(state), hash(browser), ctx.userId, ctx.householdId],
  );
  if (!attempt)
    throw new AppError(
      "Gmail connection expired, was already used, or belongs to another household.",
    );
  if (url.searchParams.has("error"))
    throw new AppError(
      "Gmail connection was cancelled. No inbox was connected.",
    );
  const code = url.searchParams.get("code");
  if (!code) throw new AppError("Google did not return an authorization code.");
  const result = await tokens({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code_verifier: decrypt(attempt.verifier),
  });
  if (!result.refresh_token || !result.scope?.split(" ").includes(gmailScope))
    throw new AppError(
      "Allow read-only Gmail access to connect your inbox for background updates.",
    );
  let subject: string, email: string;
  try {
    const client = configured("GOOGLE_CLIENT_ID");
    const { payload } = await jwtVerify(result.id_token || "", googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: client,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iat", "exp", "nonce"],
      maxTokenAge: "10 minutes",
    });
    if (
      typeof payload.nonce !== "string" ||
      !equal(hash(payload.nonce), attempt.nonce_hash) ||
      payload.email_verified !== true ||
      (payload.azp !== undefined && payload.azp !== client) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== client)
    )
      throw new Error("Invalid identity");
    subject = z.string().min(1).max(255).parse(payload.sub);
    email = z.email().parse(payload.email).toLowerCase();
  } catch {
    throw new AppError(
      "Google’s Gmail identity could not be verified. Please reconnect.",
      401,
    );
  }
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `gmail-account:${ctx.userId}`,
    ]);
    const [user] = (
      await c.query(
        `SELECT u.google_subject FROM users u JOIN household_members m ON m.user_id=u.id WHERE u.id=$1 AND m.household_id=$2 FOR SHARE OF m`,
        [ctx.userId, ctx.householdId],
      )
    ).rows;
    if (!user || user.google_subject !== subject)
      throw new AppError(
        "Connect the same Google account you use to sign in to PorchPong.",
        403,
      );
    const [existing] = (
      await c.query(
        "SELECT * FROM gmail_connections WHERE user_id=$1 FOR UPDATE",
        [ctx.userId],
      )
    ).rows;
    if (existing && existing.household_id !== ctx.householdId)
      throw new AppError(
        "Gmail is connected to another household. Disconnect it there first.",
        409,
      );
    const [connection] = (
      await c.query(
        `INSERT INTO gmail_connections(user_id,household_id,google_subject,email,refresh_token,generation,import_since,scan_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(user_id) DO UPDATE SET refresh_token=EXCLUDED.refresh_token,email=EXCLUDED.email,
      generation=EXCLUDED.generation,enabled=true,needs_reconnect=false,error=NULL,next_sync_at=now() RETURNING *`,
        [
          ctx.userId,
          ctx.householdId,
          subject,
          email,
          encrypt(result.refresh_token!),
          randomToken(),
          attempt.import_since,
        ],
      )
    ).rows;
    await enqueue(
      "gmail_sync",
      {
        connectionId: connection.id,
        householdId: ctx.householdId,
        generation: connection.generation,
      },
      `gmail-connect:${randomToken()}`,
      c,
    );
  });
}
export async function gmailAction(
  ctx: Context,
  action: "pause" | "resume" | "disconnect" | "sync",
) {
  requireReal(ctx);
  await rateLimit(`gmail-action:${ctx.userId}`, 20, 3600);
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `gmail-account:${ctx.userId}`,
    ]);
    const [g] = (
      await c.query(
        "SELECT * FROM gmail_connections WHERE user_id=$1 AND household_id=$2 FOR UPDATE",
        [ctx.userId, ctx.householdId],
      )
    ).rows;
    if (!g)
      throw new AppError("Your Gmail is not connected to this household.", 404);
    if (action === "disconnect" || action === "pause") {
      await c.query("DELETE FROM gmail_oauth_states WHERE user_id=$1", [
        ctx.userId,
      ]);
      await c.query(
        "UPDATE jobs SET status='done',error=NULL WHERE kind='gmail_sync' AND payload->>'connectionId'=$1 AND status IN ('pending','dead')",
        [g.id],
      );
      if (action === "disconnect")
        await c.query("DELETE FROM gmail_connections WHERE id=$1", [g.id]);
      else
        await c.query(
          "UPDATE gmail_connections SET enabled=false,generation=$2 WHERE id=$1",
          [g.id, randomToken()],
        );
    } else {
      if (g.needs_reconnect)
        throw new AppError("Reconnect Gmail to restore access.");
      if (action === "sync" && !g.enabled)
        throw new AppError("Resume Gmail before checking for new packages.");
      await c.query(
        "UPDATE gmail_connections SET enabled=true,next_sync_at=now() WHERE id=$1",
        [g.id],
      );
      await enqueue(
        "gmail_sync",
        {
          connectionId: g.id,
          householdId: ctx.householdId,
          generation: g.generation,
        },
        `gmail-manual:${randomToken()}`,
        c,
      );
    }
  });
}
async function gmailRequest(token: string, path: string) {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (response.status === 401)
    throw new GmailAccessError(
      "Gmail access expired. Reconnect Gmail in Settings.",
    );
  if (
    response.status === 400 &&
    path.startsWith("messages?") &&
    path.includes("pageToken=")
  )
    throw new GmailPageExpiredError(
      "Gmail’s message list changed. Restarting this check safely.",
      502,
    );
  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    if (
      data.error?.errors?.some((e: { reason?: string }) =>
        /rateLimit|quota/i.test(e.reason || ""),
      )
    )
      throw new AppError(
        "Gmail is busy. PorchPong will retry automatically.",
        502,
      );
    throw new GmailAccessError(
      "Gmail access is unavailable. Check that Gmail is enabled for this Google account, then reconnect.",
    );
  }
  if (response.status === 404) return null; // Deleted between listing and fetching.
  if (!response.ok)
    throw new AppError(
      `Gmail is temporarily unavailable (${response.status}). PorchPong will retry.`,
      502,
    );
  return response.json();
}
export async function syncGmail(connectionId: string, generation: string) {
  if (!gmailConfigured()) return;
  const lock = await pool().connect();
  let acquired = false;
  try {
    acquired = (
      await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
        `gmail-sync:${connectionId}`,
      ])
    ).rows[0].locked;
    if (!acquired) return;
    let [g] = await query(
      "SELECT * FROM gmail_connections WHERE id=$1 AND generation=$2 AND enabled=true AND needs_reconnect=false",
      [connectionId, generation],
    );
    if (
      !g ||
      (process.env.GMAIL_HOUSEHOLD_ID &&
        g.household_id !== process.env.GMAIL_HOUSEHOLD_ID)
    )
      return;
    if (!g.scan_before) {
      [g] = await query(
        "UPDATE gmail_connections SET scan_before=date_trunc('second',now()) WHERE id=$1 AND generation=$2 AND enabled=true RETURNING *",
        [connectionId, generation],
      );
      if (!g) return;
    }
    const token = (
      await tokens({
        grant_type: "refresh_token",
        refresh_token: decrypt(g.refresh_token),
      })
    ).access_token;
    const q = `${shippingQuery} after:${Math.floor(new Date(g.scan_after).getTime() / 1000) - 1} before:${Math.floor(new Date(g.scan_before).getTime() / 1000)}`;
    const params = new URLSearchParams({
      q,
      maxResults: "20",
      includeSpamTrash: "false",
    });
    if (g.page_token) params.set("pageToken", g.page_token);
    const page = await gmailRequest(token, `messages?${params}`);
    if (!page) throw new AppError("Gmail could not list messages.", 502);
    const deadline = Date.now() + 120_000;
    let partialPage = false;
    for (const item of page.messages || []) {
      if (Date.now() > deadline) {
        partialPage = true;
        break;
      }
      if (typeof item.id !== "string")
        throw new AppError("Gmail returned an invalid message.", 502);
      const key = `gmail:${hash(g.google_subject)}:${item.id}`;
      const [active] = await query(
        "SELECT 1 FROM gmail_connections WHERE id=$1 AND generation=$2 AND enabled=true",
        [connectionId, generation],
      );
      if (!active) return;
      if (
        (
          await query(
            "SELECT 1 FROM source_emails WHERE household_id=$1 AND message_key=$2",
            [g.household_id, key],
          )
        ).length
      )
        continue;
      const message: GmailMessage | null = await gmailRequest(
        token,
        `messages/${encodeURIComponent(item.id)}?format=full`,
      );
      if (!message) continue;
      const received = Number(message.internalDate);
      if (!Number.isFinite(received))
        throw new AppError(
          "Gmail returned a message without a valid date.",
          502,
        );
      if (
        received < new Date(g.import_since).getTime() ||
        received >= new Date(g.scan_before).getTime() ||
        message.labelIds?.some((x) =>
          ["SPAM", "TRASH", "SENT", "DRAFT"].includes(x),
        )
      )
        continue;
      // Gmail can return large text parts as attachments. Fetch only the text body, never arbitrary files.
      for (const part of bodyParts(message.payload)) {
        if (
          !part.body?.data &&
          part.body?.attachmentId &&
          (part.body.size || 0) <= 1_000_000
        ) {
          const body = await gmailRequest(
            token,
            `messages/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
          );
          if (!body)
            throw new AppError(
              "A Gmail message body is unavailable. PorchPong will retry.",
              502,
            );
          part.body.data = body.data;
        }
      }
      const input = decodeMessage(message);
      if (!input.text.trim() && !input.html.trim()) continue;
      await transaction(async (c) => {
        // Pause, disconnect, reconnection, and membership removal serialize with ingestion.
        const [current] = (
          await c.query(
            "SELECT 1 FROM gmail_connections WHERE id=$1 AND generation=$2 AND enabled=true FOR UPDATE",
            [connectionId, generation],
          )
        ).rows;
        if (!current) return;
        const received = await receiveEmail(
          g.household_id,
          { ...input, messageId: key, source: "Gmail" },
          c,
        );
        if (!received.duplicate)
          await c.query(
            "UPDATE gmail_connections SET imported_count=imported_count+1 WHERE id=$1",
            [connectionId],
          );
      });
    }
    await transaction(async (c) => {
      const [current] = (
        await c.query(
          "SELECT 1 FROM gmail_connections WHERE id=$1 AND generation=$2 AND enabled=true FOR UPDATE",
          [connectionId, generation],
        )
      ).rows;
      if (!current) return;
      if (partialPage || page.nextPageToken) {
        await c.query(
          "UPDATE gmail_connections SET page_token=$2,error=NULL,next_sync_at=now() WHERE id=$1",
          [connectionId, partialPage ? g.page_token : page.nextPageToken],
        );
        await enqueue(
          "gmail_sync",
          { connectionId, generation, householdId: g.household_id },
          `gmail-page:${randomToken()}`,
          c,
        );
      } else {
        // A one-day overlap catches delayed indexing without duplicate ingestion.
        await c.query(
          `UPDATE gmail_connections SET scan_after=greatest(import_since,scan_before-interval '1 day'),scan_before=NULL,page_token=NULL,
          last_synced_at=now(),error=NULL,next_sync_at=now()+interval '5 minutes' WHERE id=$1`,
          [connectionId],
        );
      }
    });
  } catch (e) {
    if (e instanceof GmailPageExpiredError)
      await query(
        "UPDATE gmail_connections SET page_token=NULL WHERE id=$1 AND generation=$2",
        [connectionId, generation],
      );
    const permanent = e instanceof GmailAccessError;
    const message =
      e instanceof AppError
        ? e.message
        : "Gmail check failed. PorchPong will retry automatically.";
    await query(
      "UPDATE gmail_connections SET error=$3,needs_reconnect=$4,next_sync_at=now()+interval '5 minutes' WHERE id=$1 AND generation=$2",
      [connectionId, generation, message, permanent],
    );
    if (!permanent) throw new AppError(message, 502);
  } finally {
    if (acquired)
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
        `gmail-sync:${connectionId}`,
      ]);
    lock.release();
  }
}
