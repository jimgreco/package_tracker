import { randomBytes } from "node:crypto";
import { query, transaction, enqueue } from "./db";
import {
  hash,
  randomToken,
  encrypt,
  decrypt,
  configured,
  origin,
  AppError,
} from "./security";
import type { Context } from "./auth";
import { requireReal } from "./auth";
import { shipment, mapShipment } from "./shipments";
import { calendarFields } from "./calendar";
const scope = "https://www.googleapis.com/auth/calendar.app.created";
function redirectUri() {
  return `${origin()}/api/google/callback`;
}
export async function googleStart(ctx: Context, nativeAttemptId?: string) {
  requireReal(ctx);
  const clientId = configured("GOOGLE_CLIENT_ID");
  configured("GOOGLE_CLIENT_SECRET");
  const state = randomToken();
  const verifier = randomBytes(32).toString("base64url");
  await query(
    "INSERT INTO oauth_states(state_hash,user_id,verifier,household_id,expires_at,native_calendar_attempt_id) VALUES($1,$2,$3,$4,now()+interval '10 minutes',$5)",
    [
      hash(state),
      ctx.userId,
      encrypt(verifier),
      ctx.householdId,
      nativeAttemptId || null,
    ],
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: Buffer.from(hash(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString() };
}
export async function googleCallback(
  ctx: Context,
  url: URL,
  nativeAttemptId?: string,
) {
  requireReal(ctx);
  const state = url.searchParams.get("state");
  if (!state) throw new AppError("Missing Google authorization state.");
  const [saved] = await query(
    "DELETE FROM oauth_states WHERE state_hash=$1 AND user_id=$2 AND household_id=$3 AND expires_at>now() RETURNING verifier",
    [hash(state), ctx.userId, ctx.householdId],
  );
  if (!saved)
    throw new AppError("Google authorization expired. Connect again.");
  if (url.searchParams.has("error"))
    throw new AppError("Google Calendar connection was cancelled.");
  const code = url.searchParams.get("code");
  if (!code) throw new AppError("Google did not return an authorization code.");
  const result = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code_verifier: decrypt(saved.verifier),
  });
  if (!result.refresh_token)
    throw new AppError(
      "Google did not grant background access. Please reconnect and allow calendar access.",
    );
  if (!result.scope?.split(" ").includes(scope))
    throw new AppError("Calendar access was not granted.");
  // Preserve an existing connection instead of silently orphaning its calendar on reconnect.
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `google:${ctx.householdId}`,
    ]);
    if (nativeAttemptId) {
      const valid = await c.query(
        `SELECT n.id FROM native_calendar_attempts n JOIN native_sessions s ON s.token_hash=n.session_hash AND s.expires_at>now()
        JOIN users u ON u.id=n.user_id AND u.household_id=n.household_id
        JOIN household_members m ON m.user_id=n.user_id AND m.household_id=n.household_id
        WHERE n.id=$1 AND n.session_hash=$2 AND n.expires_at>now() FOR SHARE OF n,s,u,m`,
        [nativeAttemptId, ctx.nativeSessionHash],
      );
      if (!valid.rows.length)
        throw new AppError(
          "Your sign-in or household changed. Connect again.",
          403,
        );
    }
    const [existing] = (
      await c.query(
        "SELECT calendar_id FROM google_connections WHERE household_id=$1",
        [ctx.householdId],
      )
    ).rows;
    if (existing?.calendar_id) {
      const check = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(existing.calendar_id)}`,
        {
          headers: { Authorization: `Bearer ${result.access_token}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!check.ok)
        throw new AppError(
          "Reconnect using the Google account that owns your existing Package Deliveries calendar. Disconnect first to switch accounts.",
        );
    }
    await c.query(
      `INSERT INTO google_connections(household_id,refresh_token,generation) VALUES($1,$2,$3) ON CONFLICT(household_id) DO UPDATE SET refresh_token=EXCLUDED.refresh_token,error=NULL`,
      [ctx.householdId, encrypt(result.refresh_token!), randomToken()],
    );
    await enqueue(
      "google_all",
      { householdId: ctx.householdId },
      `google-connect:${ctx.householdId}:${randomToken()}`,
      c,
    );
  });
}
async function tokenRequest(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: configured("GOOGLE_CLIENT_ID"),
      client_secret: configured("GOOGLE_CLIENT_SECRET"),
      ...params,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await res.json();
  if (!res.ok)
    throw new AppError(
      data.error === "invalid_grant"
        ? "Google access expired. Reconnect Google Calendar in Settings."
        : "Google authorization failed. Try connecting again.",
      502,
    );
  return data as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
  };
}
async function accessToken(refreshToken: string) {
  return (
    await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: decrypt(refreshToken),
    })
  ).access_token;
}
async function calendarRequest(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
}
async function ensureCalendar(householdId: string) {
  return transaction(async (c) => {
    const [g] = (
      await c.query(
        "SELECT g.*,h.time_zone FROM google_connections g JOIN households h ON h.id=g.household_id WHERE g.household_id=$1 FOR UPDATE OF g",
        [householdId],
      )
    ).rows;
    if (!g) return null;
    const token = await accessToken(g.refresh_token);
    if (!g.calendar_id) {
      const res = await calendarRequest(token, "/calendars", "POST", {
        summary: "Package Deliveries",
        description: "Delivery estimates and updates maintained by Doorstep.",
        timeZone: g.time_zone,
      });
      if (!res.ok)
        throw new AppError(
          `Could not create your delivery calendar (${res.status}).`,
          502,
        );
      const cal = await res.json();
      await c.query(
        "UPDATE google_connections SET calendar_id=$2 WHERE household_id=$1",
        [householdId, cal.id],
      );
      g.calendar_id = cal.id;
    }
    return { ...g, token };
  });
}
export async function syncAll(householdId: string) {
  const connection = await ensureCalendar(householdId);
  if (!connection) return;
  for (const s of await query(
    "SELECT id,version FROM shipments WHERE household_id=$1 AND is_demo=false",
    [householdId],
  ))
    await enqueue(
      "google_sync",
      { shipmentId: s.id, householdId },
      `calendar-connect:${connection.generation}:${s.id}:${s.version}:${Date.now()}`,
    );
}
export async function syncShipment(id: string) {
  const initial = await shipment(id);
  if (initial.shipment.isDemo) return;
  const connection = await ensureCalendar(initial.row.household_id);
  if (!connection) return;
  // Serialize updates for this shipment so delayed jobs cannot overwrite newer calendar data.
  await transaction(async (c) => {
    const [row] = (
      await c.query(
        "SELECT s.*,o.merchant,o.order_number,o.ordered_at,h.time_zone FROM shipments s JOIN orders o ON o.id=s.order_id JOIN households h ON h.id=s.household_id WHERE s.id=$1 FOR UPDATE OF s",
        [id],
      )
    ).rows;
    if (!row) return;
    const s = mapShipment(row);
    const event = calendarFields(s, origin(), row.time_zone);
    let eventId = `ds${id.replaceAll("-", "")}`;
    const base = `/calendars/${encodeURIComponent(connection.calendar_id)}/events`;
    const [previous] = (
      await c.query(
        "SELECT * FROM calendar_events WHERE shipment_id=$1 AND calendar_id=$2",
        [id, connection.calendar_id],
      )
    ).rows;
    if (previous)
      eventId = previous.is_deleted
        ? previous.event_id + "a"
        : previous.event_id;
    if (!event || s.status === "cancelled") {
      if (previous && !previous.is_deleted) {
        const res = await calendarRequest(
          connection.token,
          `${base}/${previous.event_id}`,
          "DELETE",
        );
        if (!res.ok && ![404, 410].includes(res.status))
          throw new AppError(
            `Google Calendar could not remove the event (${res.status}).`,
            502,
          );
        await c.query(
          "UPDATE calendar_events SET is_deleted=true WHERE shipment_id=$1 AND calendar_id=$2",
          [id, connection.calendar_id],
        );
      }
    } else {
      const body = {
        ...event,
        reminders: { useDefault: false },
        extendedProperties: { private: { doorstepShipmentId: id } },
        source: {
          title: "View in Doorstep",
          url: `${origin()}/?shipment=${id}`,
        },
      };
      let res = await calendarRequest(
        connection.token,
        `${base}/${eventId}`,
        "PUT",
        body,
      );
      if ([404, 410].includes(res.status)) {
        res = await calendarRequest(connection.token, base, "POST", {
          id: eventId,
          ...body,
        });
        if (res.status === 409)
          res = await calendarRequest(
            connection.token,
            `${base}/${eventId}`,
            "PUT",
            body,
          );
      }
      if (!res.ok)
        throw new AppError(
          `Google Calendar could not save the event (${res.status}). Reconnect if access was revoked.`,
          502,
        );
      await c.query(
        `INSERT INTO calendar_events(shipment_id,calendar_id,event_id,synced_version) VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id,calendar_id) DO UPDATE SET event_id=EXCLUDED.event_id,synced_version=EXCLUDED.synced_version,is_deleted=false`,
        [id, connection.calendar_id, eventId, row.version],
      );
    }
    await c.query(
      "UPDATE google_connections SET last_synced_at=now(),error=NULL WHERE household_id=$1 AND generation=$2",
      [row.household_id, connection.generation],
    );
  });
}
export async function disconnectGoogle(ctx: Context) {
  requireReal(ctx);
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `google:${ctx.householdId}`,
    ]);
    await c.query(
      "DELETE FROM native_calendar_attempts WHERE household_id=$1",
      [ctx.householdId],
    );
    await c.query("DELETE FROM google_connections WHERE household_id=$1", [
      ctx.householdId,
    ]);
  }); // Keep the user-owned calendar and its existing events in Google.
}
