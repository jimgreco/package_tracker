import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { pool, query } from "../lib/db";
import { encrypt, decrypt, hash, randomToken } from "../lib/security";
import { sessionCookie, type Context } from "../lib/auth";
import {
  gmailStart,
  gmailCallback,
  gmailAction,
  gmailScope,
  syncGmail,
} from "../lib/gmail";
import { schedule, runOne } from "../lib/jobs";
import { emails, settings } from "../lib/shipments";
import { GET, POST } from "../app/api/[...path]/route";
const appUrl = "http://127.0.0.1:4317";
const dbUrl = new URL(process.env.DATABASE_URL!);
const dbName = `doorstep_gmail_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(dbUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
const originalFetch = globalThis.fetch;
let created = false;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let ctx: Context, other: Context;
let gmailFetch: (url: URL) => Promise<Response>;
let refreshError = false;
const codes = new Map<
  string,
  { idToken: string; verifier: string; scope: string }
>();
before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(dbUrl.hostname));
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  dbUrl.pathname = "/" + dbName;
  Object.assign(process.env, {
    DATABASE_URL: dbUrl.toString(),
    APP_URL: appUrl,
    DEMO_MODE: "false",
    ENCRYPTION_KEY: "c".repeat(64),
    GOOGLE_CLIENT_ID: "gmail-fixture",
    GOOGLE_CLIENT_SECRET: "gmail-secret",
    GMAIL_ENABLED: "true",
  });
  delete process.env.EASYPOST_API_KEY;
  delete process.env.FEDEX_CLIENT_ID;
  delete process.env.FEDEX_CLIENT_SECRET;
  for (const file of (await readdir("db"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await query(await readFile("db/" + file, "utf8"));
  keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "gmail-fixture",
    alg: "RS256",
    use: "sig",
  };
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [jwk] });
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(options?.body as URLSearchParams);
      assert.equal(params.get("client_id"), "gmail-fixture");
      if (params.get("grant_type") === "refresh_token")
        return refreshError
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({ access_token: "gmail-access" });
      const entry = codes.get(params.get("code")!);
      assert.ok(entry);
      assert.equal(params.get("code_verifier"), entry.verifier);
      assert.equal(params.get("redirect_uri"), appUrl + "/api/gmail/callback");
      return Response.json({
        access_token: "gmail-access",
        refresh_token: "gmail-refresh-private",
        id_token: entry.idToken,
        scope: entry.scope,
      });
    }
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/")) {
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer gmail-access",
      );
      return gmailFetch(new URL(url));
    }
    throw new Error("Unexpected provider request in Gmail test");
  };
  async function account(name: string) {
    const [h] = await query(
      "INSERT INTO households(name,forwarding_token,feed_token,plan) VALUES($1,$2,$3,'paid') RETURNING *",
      [name, randomToken(), randomToken()],
    );
    const [u] = await query(
      "INSERT INTO users(household_id,email,name,google_subject) VALUES($1,$2,$3,$4) RETURNING id",
      [h.id, name + "@gmail.com", name, name],
    );
    await query(
      "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'owner')",
      [h.id, u.id],
    );
    return {
      userId: u.id,
      householdId: h.id,
      email: name + "@gmail.com",
      name,
      householdName: name,
      timeZone: h.time_zone,
      forwardingToken: h.forwarding_token,
      feedToken: h.feed_token,
      demo: false,
      plan: "paid" as const,
    };
  }
  ctx = await account("gmail-owner");
  other = await account("gmail-other");
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (created) {
    await pool().end();
    await admin.query(`DROP DATABASE "${dbName}"`);
  }
  await admin.end();
});
async function attempt(importRecent = true, account = ctx) {
  const start = await gmailStart(account, { importRecent });
  const url = new URL(start.url);
  assert.equal(url.searchParams.get("scope"), `openid email ${gmailScope}`);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), null);
  const [state] = await query(
    "SELECT * FROM gmail_oauth_states WHERE state_hash=$1",
    [hash(url.searchParams.get("state")!)],
  );
  return { start, url, state };
}
async function callback(
  a: Awaited<ReturnType<typeof attempt>>,
  subject = "gmail-owner",
  scope = gmailScope,
  overrides: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    sub: subject,
    email: `${subject}@gmail.com`,
    email_verified: true,
    nonce: a.url.searchParams.get("nonce"),
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "gmail-fixture" })
    .setIssuer("https://accounts.google.com")
    .setAudience("gmail-fixture")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
  const code = randomToken();
  codes.set(code, { idToken, verifier: decrypt(a.state.verifier), scope });
  return new Request(
    `${appUrl}/api/gmail/callback?state=${a.url.searchParams.get("state")}&code=${code}`,
    { headers: { cookie: a.start.cookie.split(";")[0] } },
  );
}
async function connection(account = ctx) {
  return (
    await query("SELECT * FROM gmail_connections WHERE user_id=$1", [
      account.userId,
    ])
  )[0];
}
const message = (id: string, extra = {}) => ({
  id,
  internalDate: String(Date.now() - 10000),
  labelIds: ["INBOX", "UNREAD"],
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "subject", value: "Your order shipped" },
      { name: "from", value: "store@example.invalid" },
      { name: "Message-ID", value: `<${id}@store.example.invalid>` },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Track your package ABC123 ordered today").toString(
            "base64url",
          ),
        },
      },
      {
        mimeType: "text/html",
        body: {
          data: Buffer.from(
            '<a href="https://carrier.example/ABC123">Track</a><img src="https://store.example/product.jpg">',
          ).toString("base64url"),
        },
      },
    ],
  },
  ...extra,
});

test("Gmail OAuth binds browser, user, household, identity, scope, and one-time state", async () => {
  const a = await attempt();
  const req = await callback(a);
  await assert.rejects(
    () => gmailCallback(ctx, new Request(req.url)),
    /another browser/,
  );
  await assert.rejects(() => gmailCallback(other, req), /another household/);
  const sameMemberElsewhere = { ...ctx, householdId: other.householdId };
  await assert.rejects(
    () => gmailCallback(sameMemberElsewhere, req),
    /another household/,
  );
  await gmailCallback(ctx, req);
  const g = await connection();
  assert.equal(g.household_id, ctx.householdId);
  assert.notEqual(g.refresh_token, "gmail-refresh-private");
  assert.equal(decrypt(g.refresh_token), "gmail-refresh-private");
  assert.ok(new Date(g.import_since).getTime() < Date.now() - 29 * 86400000);
  await assert.rejects(() => gmailCallback(ctx, req), /already used/);
  for (const [sub, scope, claims, pattern] of [
    ["gmail-other", gmailScope, {}, /same Google account/],
    ["gmail-owner", "openid email", {}, /read-only Gmail/],
    ["gmail-owner", gmailScope, { nonce: "wrong" }, /could not be verified/],
    [
      "gmail-owner",
      gmailScope,
      { email_verified: false },
      /could not be verified/,
    ],
  ] as const) {
    const bad = await attempt();
    await assert.rejects(
      () =>
        callback(bad, sub, scope, claims).then((r) => gmailCallback(ctx, r)),
      pattern,
    );
  }
  const fresh = await attempt(false, other);
  assert.ok(Date.now() - new Date(fresh.state.import_since).getTime() < 10000);
  await gmailCallback(other, await callback(fresh, "gmail-other"));
});

test("Gmail imports pages durably with preserved body and source, rejects pre-consent mail, and deduplicates retries", async () => {
  const g = await connection();
  let requests = 0;
  gmailFetch = async (url) => {
    requests++;
    if (url.pathname.endsWith("/messages")) {
      assert.match(url.searchParams.get("q")!, /after:\d+ before:\d+/);
      assert.match(url.searchParams.get("q")!, /-in:spam/);
      return Response.json(
        url.searchParams.has("pageToken")
          ? { messages: [{ id: "m2" }, { id: "old" }, { id: "sent" }] }
          : { messages: [{ id: "m1" }], nextPageToken: "page2" },
      );
    }
    const id = url.pathname.split("/").pop()!;
    return Response.json(
      message(
        id,
        id === "old"
          ? { internalDate: String(Date.now() - 40 * 86400000) }
          : id === "sent"
            ? { labelIds: ["SENT"] }
            : {},
      ),
    );
  };
  await syncGmail(g.id, g.generation);
  assert.equal((await connection()).page_token, "page2");
  await syncGmail(g.id, g.generation);
  let sources = await query(
    "SELECT * FROM source_emails WHERE household_id=$1",
    [ctx.householdId],
  );
  assert.equal(sources.length, 2);
  assert.equal(sources[0].source, "Gmail");
  assert.equal(sources[0].gmail_account_email, ctx.email);
  assert.match(
    sources[0].rfc822_message_id,
    /^<m[12]@store\.example\.invalid>$/,
  );
  const imported = await emails(ctx.householdId);
  assert.equal(imported.length, 2);
  for (const email of imported) {
    const url = new URL(email.gmailUrl!);
    assert.equal(url.origin, "https://mail.google.com");
    assert.equal(url.searchParams.get("authuser"), ctx.email);
    assert.match(
      email.appleMailUrl!,
      /^message:\/\/%3Cm[12]%40store\.example\.invalid%3E$/,
    );
    assert.match(
      decodeURIComponent(url.hash),
      /^#search\/rfc822msgid:m[12]@store\.example\.invalid$/,
    );
  }
  await query(
    "UPDATE source_emails SET gmail_account_email=NULL,rfc822_message_id=NULL WHERE id=$1",
    [sources[0].id],
  );
  const historical = (await emails(ctx.householdId)).find(
    (e) => e.id === sources[0].id,
  )!;
  assert.equal(
    new URL(historical.gmailUrl!).searchParams.get("authuser"),
    ctx.email,
  );
  assert.match(historical.gmailUrl!, /#all\/m[12]$/);
  assert.equal(historical.appleMailUrl, null);
  assert.match(sources[0].body_text, /ABC123/);
  assert.equal(sources[0].images[0].url, "https://store.example/product.jpg");
  assert.ok((await connection()).last_synced_at);
  assert.equal((await connection()).imported_count, 2);
  await syncGmail(g.id, g.generation);
  const restored = (await emails(ctx.householdId)).find(
    (e) => e.id === sources[0].id,
  )!;
  assert.match(
    restored.appleMailUrl!,
    /^message:\/\/%3Cm[12]%40store\.example\.invalid%3E$/,
  );
  await syncGmail(g.id, g.generation);
  sources = await query("SELECT * FROM source_emails WHERE household_id=$1", [
    ctx.householdId,
  ]);
  assert.equal(sources.length, 2);
  assert.equal(
    (await query("SELECT * FROM jobs WHERE kind='parse_email'")).length,
    2,
  );
  assert.ok(requests > 0);
  const own = await settings(ctx),
    theirs = await settings(other);
  assert.equal(own.gmail.importedCount, 2);
  assert.equal(theirs.gmail.importedCount, 0);
  assert.doesNotMatch(
    JSON.stringify(own),
    /gmail-refresh-private|refresh_token/,
  );
});

test("Pause invalidates in-flight import; resume catches up; revoked access requires reconnect", async () => {
  const g = await connection();
  gmailFetch = async (url) => {
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [{ id: "paused" }] });
    await gmailAction(ctx, "pause");
    return Response.json(message("paused"));
  };
  await syncGmail(g.id, g.generation);
  assert.equal((await connection()).enabled, false);
  assert.equal(
    (
      await query(
        "SELECT * FROM source_emails WHERE message_key LIKE '%:paused'",
      )
    ).length,
    0,
  );
  gmailFetch = async () => {
    throw new Error("Paused sync must not call Gmail");
  };
  await syncGmail(g.id, g.generation);
  await gmailAction(ctx, "resume");
  refreshError = true;
  const resumed = await connection();
  await syncGmail(resumed.id, resumed.generation);
  refreshError = false;
  assert.equal((await connection()).needs_reconnect, true);
  await assert.rejects(() => gmailAction(ctx, "resume"), /Reconnect Gmail/);
  const reconnect = await attempt(false);
  await gmailCallback(ctx, await callback(reconnect));
  const reconnected = await connection();
  assert.equal(reconnected.needs_reconnect, false);
  assert.equal(
    new Date(reconnected.import_since).getTime(),
    new Date(g.import_since).getTime(),
  );
  assert.notEqual(reconnected.generation, resumed.generation);
});

test("Disconnect blocks in-flight saves and leaves saved packages; removal cascades credentials", async () => {
  const g = await connection();
  gmailFetch = async (url) => {
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [{ id: "disconnected" }] });
    await gmailAction(ctx, "disconnect");
    return Response.json(message("disconnected"));
  };
  await syncGmail(g.id, g.generation);
  assert.equal(await connection(), undefined);
  assert.equal(
    (
      await query(
        "SELECT * FROM source_emails WHERE message_key LIKE '%:disconnected'",
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await query("SELECT * FROM source_emails WHERE household_id=$1", [
        ctx.householdId,
      ])
    ).length,
    2,
  );
  const oldOther = await connection(other);
  await query(
    "DELETE FROM household_members WHERE household_id=$1 AND user_id=$2",
    [other.householdId, other.userId],
  );
  assert.equal(await connection(other), undefined);
  gmailFetch = async () => {
    throw new Error("Removed member must not call Gmail");
  };
  await syncGmail(oldOther.id, oldOther.generation);
});

test("Routes require authentication, same-origin requests, and expose callback errors without secrets", async () => {
  const call = (path: string, cookie = "", origin = "") =>
    POST(
      new Request(`${appUrl}/api/${path}`, {
        method: "POST",
        headers: { cookie, origin, "Content-Type": "application/json" },
        body: JSON.stringify({ importRecent: false }),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
  assert.equal((await call("gmail/connect", "", appUrl)).status, 401);
  const session = (await sessionCookie(ctx.userId)).split(";")[0];
  assert.equal(
    (await call("gmail/connect", session, "https://evil.example")).status,
    403,
  );
  const result = await call("gmail/connect", session, appUrl);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  const bad = await GET(
    new Request(`${appUrl}/api/gmail/callback?state=bad`, {
      headers: { cookie: session },
    }),
    { params: Promise.resolve({ path: ["gmail", "callback"] }) },
  );
  assert.equal(bad.status, 307);
  assert.match(bad.headers.get("location")!, /gmailError=/);
  assert.equal(bad.headers.get("referrer-policy"), "no-referrer");
});

test("Scheduler enqueues due Gmail work once and worker runs it without external email/calendar writes", async () => {
  const a = await attempt();
  await gmailCallback(ctx, await callback(a));
  const g = await connection();
  await query("UPDATE jobs SET status='done'");
  gmailFetch = async () => Response.json({ messages: [] });
  await schedule();
  await schedule();
  const pending = await query(
    "SELECT * FROM jobs WHERE kind='gmail_sync' AND status='pending'",
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.connectionId, g.id);
  assert.equal(await runOne(), true);
  assert.equal(
    (await query("SELECT status FROM jobs WHERE id=$1", [pending[0].id]))[0]
      .status,
    "done",
  );
  assert.ok((await connection()).last_synced_at);
});

test("Expired pagination restarts the same window; temporary errors retain the cursor", async () => {
  const g = await connection();
  const before = new Date(Date.now() - 1000).toISOString();
  await query(
    "UPDATE gmail_connections SET page_token='expired',scan_before=$2 WHERE id=$1",
    [g.id, before],
  );
  gmailFetch = async () =>
    Response.json(
      { error: { message: "Invalid page token" } },
      { status: 400 },
    );
  await assert.rejects(
    () => syncGmail(g.id, g.generation),
    /Restarting this check/,
  );
  let current = await connection();
  assert.equal(current.page_token, null);
  assert.equal(current.scan_before.toISOString(), before);
  gmailFetch = async () =>
    Response.json(
      { error: { errors: [{ reason: "rateLimitExceeded" }] } },
      { status: 403 },
    );
  await assert.rejects(
    () => syncGmail(g.id, g.generation),
    /retry automatically/,
  );
  current = await connection();
  assert.equal(current.needs_reconnect, false);
  assert.equal(current.scan_before.toISOString(), before);
  gmailFetch = async () => Response.json({ messages: [] });
  await syncGmail(g.id, g.generation);
  assert.equal((await connection()).error, null);
});

test("Household switching does not redirect a member’s connected inbox", async () => {
  await query(
    "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'member')",
    [other.householdId, ctx.userId],
  );
  const elsewhere = { ...ctx, householdId: other.householdId };
  await assert.rejects(
    () => gmailStart(elsewhere, { importRecent: false }),
    /other household/,
  );
  await assert.rejects(
    () => gmailAction(elsewhere, "disconnect"),
    /not connected to this household/,
  );
  const visible = await settings(elsewhere);
  assert.equal(visible.gmail.connected, false);
  assert.equal(visible.gmail.email, null);
  assert.equal(visible.gmail.otherHouseholdName, ctx.householdName);
  assert.equal((await connection()).household_id, ctx.householdId);
});

test("Free household plan blocks Gmail connection and background ingestion", async () => {
  const g = await connection();
  await query("UPDATE households SET plan='free' WHERE id=$1", [
    ctx.householdId,
  ]);
  try {
    await assert.rejects(
      () => gmailStart(ctx, { importRecent: false }),
      /eligible households/,
    );
    assert.equal(
      (await settings({ ...ctx, plan: "free" })).services.gmail,
      false,
    );
    gmailFetch = async () => {
      throw new Error("Free household must not read Gmail");
    };
    await syncGmail(g.id, g.generation);
  } finally {
    await query("UPDATE households SET plan='paid' WHERE id=$1", [
      ctx.householdId,
    ]);
  }
});
