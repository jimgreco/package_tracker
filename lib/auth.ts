import { query } from "./db";
import { AppError, hash, randomToken, origin } from "./security";
import { DEMO_USER } from "./demo";
export function requestCookie(req: Request, name: string) {
  return req.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
}
export type Context = {
  userId: string;
  householdId: string;
  name: string;
  email: string;
  householdName: string;
  timeZone: string;
  forwardingToken: string;
  feedToken: string;
  demo: boolean;
  plan: "free" | "paid";
  nativeSessionHash?: string;
};
export async function context(
  req: Request,
  allowDemo = true,
): Promise<Context> {
  const token = req.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("doorstep_session="))
    ?.slice("doorstep_session=".length);
  const authorization = req.headers.get("authorization");
  if (authorization && token)
    throw new AppError("Use one sign-in method per request.", 400);
  if (authorization && !/^Bearer [a-f0-9]{64}$/.test(authorization))
    throw new AppError("Please sign in again.", 401);
  const nativeToken = authorization?.slice(7);
  let rows = nativeToken
    ? await query(
        `SELECT u.*,h.name household_name,h.time_zone,h.forwarding_token,h.feed_token,h.is_demo,h.plan FROM native_sessions s JOIN users u ON u.id=s.user_id JOIN households h ON h.id=u.household_id JOIN household_members m ON m.household_id=h.id AND m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()`,
        [hash(nativeToken)],
      )
    : token
      ? await query(
          `SELECT u.*,h.name household_name,h.time_zone,h.forwarding_token,h.feed_token,h.is_demo,h.plan FROM sessions s JOIN users u ON u.id=s.user_id JOIN households h ON h.id=u.household_id JOIN household_members m ON m.household_id=h.id AND m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()`,
          [hash(token)],
        )
      : [];
  if (
    !rows.length &&
    allowDemo &&
    !authorization &&
    process.env.DEMO_MODE === "true" &&
    ["localhost", "127.0.0.1"].includes(new URL(origin()).hostname)
  )
    rows = await query(
      `SELECT u.*,h.name household_name,h.time_zone,h.forwarding_token,h.feed_token,h.is_demo,h.plan FROM users u JOIN households h ON h.id=u.household_id WHERE u.id=$1`,
      [DEMO_USER],
    );
  const u = rows[0];
  if (!u) throw new AppError("Sign in to your household.", 401);
  const expectedHousehold = req.headers.get("x-doorstep-household");
  if (nativeToken && expectedHousehold && expectedHousehold !== u.household_id)
    throw new AppError("Your household changed. Refresh to continue.", 409);
  return {
    ...(nativeToken ? { nativeSessionHash: hash(nativeToken) } : {}),
    userId: u.id,
    householdId: u.household_id,
    name: u.name,
    email: u.email,
    householdName: u.household_name,
    timeZone: u.time_zone,
    forwardingToken: u.forwarding_token,
    feedToken: u.feed_token,
    demo: u.is_demo,
    plan: u.plan,
  };
}
export async function sessionCookie(userId: string) {
  const token = randomToken();
  await query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
    [hash(token), userId],
  );
  return `doorstep_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${origin().startsWith("https:") ? "; Secure" : ""}`;
}
export function requireReal(ctx: Context) {
  if (ctx.demo)
    throw new AppError(
      "Create your household before connecting live services. Sample packages stay in this preview.",
      400,
    );
}
