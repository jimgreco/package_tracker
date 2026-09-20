import { z } from "zod";
import { query } from "./db";
import { requestCookie, requireReal, type Context } from "./auth";
import { AppError, hash, origin, randomToken, rateLimit } from "./security";
import { googleStart, googleCallback } from "./google";

const callback = "com.jimgreco.doorstep:/calendar/callback";
const cookieName = "doorstep_native_calendar";
export function calendarBrowserCookie(value = "") {
  return `${cookieName}=${value}; Path=/api/google/callback; HttpOnly; SameSite=Lax; Max-Age=${value ? 600 : 0}${new URL(origin()).protocol === "https:" ? "; Secure" : ""}`;
}
export async function nativeCalendarStart(ctx: Context, input: unknown) {
  requireReal(ctx);
  if (!ctx.nativeSessionHash)
    throw new AppError("Use the PorchPong iPhone app to connect Calendar.", 403);
  const { state } = z
    .object({ state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) })
    .strict()
    .parse(input);
  await rateLimit(`native-calendar:${ctx.userId}`, 10, 600);
  await query(
    "DELETE FROM native_calendar_attempts WHERE expires_at<now() OR (session_hash=$1 AND household_id=$2)",
    [ctx.nativeSessionHash, ctx.householdId],
  );
  const launch = randomToken();
  await query(
    "INSERT INTO native_calendar_attempts(launch_hash,user_id,household_id,session_hash,app_state,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
    [hash(launch), ctx.userId, ctx.householdId, ctx.nativeSessionHash, state],
  );
  return { url: `${origin()}/api/native/calendar/authorize?attempt=${launch}` };
}
async function attemptContext(id: string): Promise<Context> {
  const [r] = await query(
    `SELECT u.id,u.name,u.email,h.id household_id,h.name household_name,h.time_zone,h.forwarding_token,h.feed_token,n.session_hash
    FROM native_calendar_attempts n JOIN native_sessions s ON s.token_hash=n.session_hash AND s.expires_at>now()
    JOIN users u ON u.id=n.user_id AND u.id=s.user_id AND u.household_id=n.household_id
    JOIN household_members m ON m.user_id=u.id AND m.household_id=n.household_id
    JOIN households h ON h.id=n.household_id WHERE n.id=$1 AND n.expires_at>now()`,
    [id],
  );
  if (!r)
    throw new AppError(
      "Your sign-in or household changed. Return to PorchPong and connect again.",
      403,
    );
  return {
    userId: r.id,
    name: r.name,
    email: r.email,
    householdId: r.household_id,
    householdName: r.household_name,
    timeZone: r.time_zone,
    forwardingToken: r.forwarding_token,
    feedToken: r.feed_token,
    nativeSessionHash: r.session_hash,
    demo: false,
  };
}
export async function nativeCalendarAuthorize(req: Request) {
  const launch = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(new URL(req.url).searchParams.get("attempt"));
  const browser = randomToken();
  const [n] = await query(
    "UPDATE native_calendar_attempts SET started_at=now(),browser_hash=$2 WHERE launch_hash=$1 AND started_at IS NULL AND expires_at>now() RETURNING id",
    [hash(launch), hash(browser)],
  );
  if (!n)
    throw new AppError(
      "Calendar authorization expired. Return to PorchPong and connect again.",
      400,
    );
  const ctx = await attemptContext(n.id);
  const result = await googleStart(ctx, n.id);
  return { ...result, cookie: calendarBrowserCookie(browser) };
}
export async function nativeCalendarCallback(
  req: Request,
): Promise<string | undefined> {
  const url = new URL(req.url),
    state = url.searchParams.get("state");
  if (!state) return;
  const [n] = await query(
    `SELECT n.* FROM oauth_states o JOIN native_calendar_attempts n ON n.id=o.native_calendar_attempt_id WHERE o.state_hash=$1`,
    [hash(state)],
  );
  if (!n) return;
  const browser = requestCookie(req, cookieName);
  if (!browser || n.browser_hash !== hash(browser))
    throw new AppError(
      "Calendar authorization could not be verified. Return to PorchPong and try again.",
      403,
    );
  const [claimed] = await query(
    "UPDATE native_calendar_attempts SET completed_at=now() WHERE id=$1 AND completed_at IS NULL AND expires_at>now() RETURNING id",
    [n.id],
  );
  if (!claimed)
    throw new AppError(
      "Calendar authorization expired. Return to PorchPong and try again.",
      400,
    );
  let result = "connected";
  try {
    await googleCallback(await attemptContext(n.id), url, n.id);
  } catch {
    result =
      url.searchParams.get("error") === "access_denied" ? "cancelled" : "error";
  }
  return `${callback}?${new URLSearchParams({ state: n.app_state, result })}`;
}
