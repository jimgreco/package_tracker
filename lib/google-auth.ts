import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { query, transaction } from "./db";
import { requestCookie } from "./auth";
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

const cookieName = "doorstep_google_signin";
const redirectUri = () => `${origin()}/api/auth/google/callback`;
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 10000 },
);
export function googleSigninConfigured() {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}
export function googleSigninCookie(value = "") {
  return `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value ? 600 : 0}${origin().startsWith("https:") ? "; Secure" : ""}`;
}
export async function googleSigninStart(
  req: Request,
  input: unknown,
  nativeAttemptId?: string,
) {
  if (!googleSigninConfigured())
    throw new AppError(
      "Google sign-in needs to be configured by the person hosting Doorstep. Please ask them to connect the Google OAuth client.",
      503,
    );
  z.object({}).strict().parse(input);
  await rateLimit("google-signin:global", 100, 900);
  const state = randomToken(),
    browser = randomToken(),
    nonce = randomToken();
  const verifier = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO google_signin_states(state_hash,browser_hash,verifier,nonce_hash,expires_at,native_attempt_id)
    VALUES($1,$2,$3,$4,now()+interval '10 minutes',$5)`,
    [
      hash(state),
      hash(browser),
      encrypt(verifier),
      hash(nonce),
      nativeAttemptId || null,
    ],
  );
  if (nativeAttemptId)
    await query(
      "UPDATE native_login_attempts SET browser_hash=$2 WHERE id=$1",
      [nativeAttemptId, hash(browser)],
    );
  const params = new URLSearchParams({
    client_id: configured("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookie: googleSigninCookie(browser),
  };
}

export async function googleSigninCallback(req: Request) {
  const url = new URL(req.url),
    state = url.searchParams.get("state"),
    browser = requestCookie(req, cookieName);
  if (!state || !browser)
    throw new AppError(
      "Google sign-in expired or started in another browser. Please try again.",
    );
  const [attempt] = await query(
    `DELETE FROM google_signin_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *`,
    [hash(state), hash(browser)],
  );
  if (!attempt)
    throw new AppError(
      "Google sign-in expired or was already used. Please try again.",
    );
  if (url.searchParams.has("error"))
    throw new AppError(
      "Google sign-in was cancelled. Please try again when you’re ready.",
    );
  const code = url.searchParams.get("code");
  if (!code)
    throw new AppError(
      "Google did not return a sign-in code. Please try again.",
    );
  let idToken: string;
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: configured("GOOGLE_CLIENT_ID"),
        client_secret: configured("GOOGLE_CLIENT_SECRET"),
        code_verifier: decrypt(attempt.verifier),
      }),
      signal: AbortSignal.timeout(25000),
    });
    const tokens = await response.json();
    if (!response.ok || typeof tokens.id_token !== "string")
      throw new Error("Missing ID token");
    idToken = tokens.id_token;
  } catch {
    throw new AppError(
      "Google could not complete sign-in. Please try again.",
      502,
    );
  }
  // Verify the signed identity against Google's fixed keys, then bind it to this attempt.
  let identity: { sub: string; email: string; name: string };
  let authoritativeEmail = false;
  try {
    const clientId = configured("GOOGLE_CLIENT_ID");
    const { payload } = await jwtVerify(idToken, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iat", "exp", "nonce"],
      maxTokenAge: "10 minutes",
    });
    if (
      typeof payload.nonce !== "string" ||
      !equal(hash(payload.nonce), attempt.nonce_hash) ||
      payload.email_verified !== true ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== clientId)
    )
      throw new Error("Invalid identity claims");
    authoritativeEmail =
      (typeof payload.email === "string" &&
        payload.email.toLowerCase().endsWith("@gmail.com")) ||
      (typeof payload.hd === "string" && payload.hd.length > 0);
    identity = z
      .object({
        sub: z.string().min(1).max(255),
        email: z
          .email()
          .max(250)
          .transform((x) => x.toLowerCase()),
        name: z.string().trim().min(1).max(100),
      })
      .parse({
        sub: payload.sub,
        email: payload.email,
        name:
          typeof payload.name === "string"
            ? payload.name.slice(0, 100)
            : "Household member",
      });
  } catch {
    throw new AppError(
      "Google’s sign-in response could not be verified. Please try again.",
      401,
    );
  }
  const userId = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4317004)");
    let [user] = (
      await c.query("SELECT * FROM users WHERE google_subject=$1", [
        identity.sub,
      ])
    ).rows;
    const invitations = authoritativeEmail
      ? (
          await c.query(
            "SELECT household_id FROM household_invitations WHERE email=$1 ORDER BY created_at,household_id FOR UPDATE",
            [identity.email],
          )
        ).rows
      : [];
    if (!user) {
      const [legacy] = (
        await c.query(
          "SELECT u.*,h.is_demo FROM users u JOIN households h ON h.id=u.household_id WHERE u.email=$1",
          [identity.email],
        )
      ).rows;
      if (legacy) {
        if (legacy.google_subject || legacy.is_demo || !authoritativeEmail)
          throw new AppError(
            "This email is associated with another account. Please use the Google account you originally signed in with.",
            409,
          );
        user = legacy;
        await c.query("UPDATE users SET google_subject=$2 WHERE id=$1", [
          user.id,
          identity.sub,
        ]);
      } else {
        const householdId =
          invitations[0]?.household_id ||
          (
            await c.query(
              "INSERT INTO households(name,forwarding_token,feed_token) VALUES($1,$2,$3) RETURNING id",
              [
                `${identity.name.split(" ")[0]}’s household`,
                randomToken(),
                randomToken(),
              ],
            )
          ).rows[0].id;
        user = (
          await c.query(
            "INSERT INTO users(household_id,email,name,google_subject,google_email) VALUES($1,$2,$3,$4,$2) RETURNING *",
            [householdId, identity.email, identity.name, identity.sub],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,$3)",
          [householdId, user.id, invitations.length ? "member" : "owner"],
        );
      }
    }
    await c.query("UPDATE users SET google_email=$2 WHERE id=$1", [
      user.id,
      identity.email,
    ]);
    for (const invitation of invitations) {
      await c.query(
        "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
        [invitation.household_id, user.id],
      );
    }
    if (authoritativeEmail)
      await c.query("DELETE FROM household_invitations WHERE email=$1", [
        identity.email,
      ]);
    return user.id as string;
  });
  return { userId };
}
