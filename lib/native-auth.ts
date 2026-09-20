import { createHash } from "node:crypto";
import { z } from "zod";
import { query, transaction } from "./db";
import { requestCookie } from "./auth";
import { googleSigninConfigured, googleSigninStart } from "./google-auth";
import {
  AppError,
  checkOrigin,
  hash,
  origin,
  randomToken,
  rateLimit,
} from "./security";

// Fixed server-owned destination: neither callers nor Google can supply a URL.
export const nativeCallback = "com.jimgreco.doorstep:/auth/callback";
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
export function checkNativePublicRequest(req: Request) {
  if (req.headers.has("cookie") || req.headers.has("authorization"))
    throw new AppError("Start sign-in without existing credentials.", 400);
  if (req.headers.has("origin")) checkOrigin(req);
}
export async function nativeStart(input: unknown) {
  const v = z
    .object({
      state: opaque,
      challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict()
    .parse(input);
  if (!googleSigninConfigured())
    throw new AppError(
      "Google sign-in is temporarily unavailable. Please try again later.",
      503,
    );
  await rateLimit("native-start:global", 100, 900);
  const launch = randomToken();
  await query(
    "DELETE FROM native_login_attempts WHERE expires_at<now()-interval '1 day'",
  );
  await query(
    `INSERT INTO native_login_attempts(launch_hash,app_state,challenge,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`,
    [hash(launch), v.state, v.challenge],
  );
  return { url: `${origin()}/api/native/auth/authorize?attempt=${launch}` };
}
export async function nativeAuthorize(req: Request) {
  const launch = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(new URL(req.url).searchParams.get("attempt"));
  const [attempt] = await query(
    `UPDATE native_login_attempts SET started_at=now() WHERE launch_hash=$1 AND started_at IS NULL AND expires_at>now() RETURNING id`,
    [hash(launch)],
  );
  if (!attempt)
    throw new AppError("Sign-in expired. Return to PorchPong and try again.");
  return googleSigninStart(req, {}, attempt.id);
}
export async function nativeCallbackAttempt(req: Request) {
  const state = new URL(req.url).searchParams.get("state");
  const browser = requestCookie(req, "doorstep_google_signin");
  if (!state || !browser) return undefined;
  const [attempt] = await query(
    `SELECT n.id,n.app_state FROM google_signin_states g JOIN native_login_attempts n ON n.id=g.native_attempt_id WHERE g.state_hash=$1 AND g.browser_hash=$2 AND n.browser_hash=$2`,
    [hash(state), hash(browser)],
  );
  return attempt as { id: string; app_state: string } | undefined;
}
export function nativeReturn(
  state: string,
  values: { code: string } | { error: string },
) {
  return `${nativeCallback}?${new URLSearchParams({ state, ...values })}`;
}
export async function nativeComplete(
  attemptId: string,
  userId: string,
  state: string,
) {
  const code = randomToken();
  const rows = await query(
    `UPDATE native_login_attempts SET user_id=$2,code_hash=$3,code_expires_at=now()+interval '2 minutes' WHERE id=$1 AND expires_at>now() AND user_id IS NULL AND consumed_at IS NULL RETURNING id`,
    [attemptId, userId, hash(code)],
  );
  if (!rows.length) throw new AppError("Sign-in expired. Please try again.");
  return nativeReturn(state, { code });
}
export async function nativeExchange(input: unknown) {
  const v = z
    .object({
      code: z.string().regex(/^[a-f0-9]{64}$/),
      verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
      state: opaque,
    })
    .strict()
    .parse(input);
  await rateLimit("native-exchange:global", 300, 900);
  const challenge = createHash("sha256").update(v.verifier).digest("base64url");
  return transaction(async (c) => {
    const [attempt] = (
      await c.query(
        `UPDATE native_login_attempts SET consumed_at=now() WHERE code_hash=$1 AND challenge=$2 AND app_state=$3 AND consumed_at IS NULL AND code_expires_at>now() AND expires_at>now() AND user_id IS NOT NULL RETURNING user_id`,
        [hash(v.code), challenge, v.state],
      )
    ).rows;
    if (!attempt)
      throw new AppError(
        "Sign-in expired or could not be verified. Please sign in again.",
        401,
      );
    const [user] = (
      await c.query(
        `SELECT u.id,u.household_id FROM users u JOIN household_members m ON m.user_id=u.id AND m.household_id=u.household_id WHERE u.id=$1`,
        [attempt.user_id],
      )
    ).rows;
    if (!user)
      throw new AppError(
        "Your household access changed. Please sign in again.",
        401,
      );
    const token = randomToken();
    const [session] = (
      await c.query(
        `INSERT INTO native_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING expires_at`,
        [hash(token), user.id],
      )
    ).rows;
    return {
      token,
      expiresAt: session.expires_at,
      userId: user.id,
      householdId: user.household_id,
    };
  });
}
