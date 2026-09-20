import { connect } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { query, transaction, enqueue } from "./db";
import type { Context } from "./auth";
import { AppError } from "./security";
import { mapShipment } from "./shipments";

export const notificationSchema = z.object({
  enabled: z.boolean(),
  outForDelivery: z.boolean(),
  delivered: z.boolean(),
  pickup: z.boolean(),
  problems: z.boolean(),
});
export function pushConfigured() {
  return !!(
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    process.env.APNS_PRIVATE_KEY
  );
}
export async function notificationSettings(ctx: Context) {
  const [p] = await query(
    "SELECT * FROM notification_preferences WHERE user_id=$1 AND household_id=$2",
    [ctx.userId, ctx.householdId],
  );
  return {
    configured: pushConfigured(),
    enabled: p?.enabled ?? false,
    outForDelivery: p?.out_for_delivery ?? true,
    delivered: p?.delivered ?? true,
    pickup: p?.pickup ?? true,
    problems: p?.problems ?? true,
  };
}
export async function saveNotificationSettings(ctx: Context, input: unknown) {
  const p = notificationSchema.parse(input);
  await query(
    `INSERT INTO notification_preferences(user_id,household_id,enabled,out_for_delivery,delivered,pickup,problems) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(user_id,household_id) DO UPDATE SET enabled=$3,out_for_delivery=$4,delivered=$5,pickup=$6,problems=$7`,
    [
      ctx.userId,
      ctx.householdId,
      p.enabled,
      p.outForDelivery,
      p.delivered,
      p.pickup,
      p.problems,
    ],
  );
  return notificationSettings(ctx);
}
export async function registerDevice(ctx: Context, input: unknown) {
  if (!ctx.nativeSessionHash)
    throw new AppError("Sign in through the iPhone app first.", 403);
  const d = z
    .object({
      token: z.string().regex(/^[a-f0-9]{32,512}$/),
      environment: z.enum(["sandbox", "production"]),
    })
    .parse(input);
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      d.environment + d.token,
    ]);
    // Reassignment discards queued messages belonging to a previous login.
    await c.query(
      "DELETE FROM push_devices WHERE token=$1 AND environment=$2 AND session_hash<>$3",
      [d.token, d.environment, ctx.nativeSessionHash],
    );
    await c.query(
      `INSERT INTO push_devices(user_id,session_hash,token,environment) VALUES($1,$2,$3,$4)
      ON CONFLICT(token,environment) DO UPDATE SET updated_at=now()`,
      [ctx.userId, ctx.nativeSessionHash, d.token, d.environment],
    );
  });
}
export async function disableDevice(ctx: Context) {
  if (!ctx.nativeSessionHash)
    throw new AppError("Sign in through the iPhone app first.", 403);
  await query("DELETE FROM push_devices WHERE session_hash=$1", [
    ctx.nativeSessionHash,
  ]);
}

export async function scheduleNotifications() {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4317010)");
    // Recalculate time-based problems even when no carrier update arrives.
    const rows = (
      await c.query(`SELECT s.*,o.merchant,o.order_number,o.ordered_at FROM shipments s JOIN orders o ON o.id=s.order_id
      WHERE s.is_demo=false AND s.archived_at IS NULL AND s.dismissed_at IS NULL AND s.status NOT IN ('delivered','cancelled','return_to_sender')`)
    ).rows;
    for (const row of rows) {
      const reasons = mapShipment(row).attentionReasons || [];
      const [previous] = (
        await c.query(
          "SELECT reasons,generation FROM shipment_attention_state WHERE shipment_id=$1",
          [row.id],
        )
      ).rows;
      const added = reasons.filter(
        (r) => !(previous?.reasons || []).includes(r),
      );
      const generation =
        Number(previous?.generation || 0) + (added.length ? 1 : 0);
      await c.query(
        `INSERT INTO shipment_attention_state(shipment_id,reasons,generation) VALUES($1,$2,$3)
        ON CONFLICT(shipment_id) DO UPDATE SET reasons=$2,generation=$3`,
        [row.id, reasons, generation],
      );
      // Explicit carrier status problems already have a transactional transition alert.
      if (added.length && !["failure", "delayed"].includes(row.status))
        await c.query(
          `INSERT INTO push_deliveries(device_id,household_id,shipment_id,category,event_key,message)
          SELECT d.id,$1,$2,'problems',$3,'A package needs attention. Open Doorstep to review it.' FROM push_devices d
          JOIN native_sessions n ON n.token_hash=d.session_hash AND n.expires_at>now()
          JOIN notification_preferences p ON p.user_id=d.user_id AND p.household_id=$1
          WHERE p.enabled AND p.problems ON CONFLICT DO NOTHING`,
          [row.household_id, row.id, `${row.id}:attention:${generation}`],
        );
    }
    const due = (
      await c.query(
        "SELECT d.id,d.household_id FROM push_deliveries d WHERE d.status='pending' AND d.created_at>now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key='push:'||d.id::text) ORDER BY d.created_at LIMIT 200",
      )
    ).rows;
    if (pushConfigured())
      for (const d of due)
        await enqueue(
          "push_send",
          { deliveryId: d.id, householdId: d.household_id },
          `push:${d.id}`,
          c,
        );
    await c.query(
      "UPDATE push_deliveries SET status='expired' WHERE status='pending' AND created_at<now()-interval '24 hours'",
    );
    await c.query(
      "DELETE FROM push_deliveries WHERE created_at<now()-interval '30 days'",
    );
  });
}

type PushRequest = {
  id: string;
  token: string;
  environment: string;
  shipment_id: string;
  household_id: string;
  message: string;
};
let cachedJWT: { token: string; until: number } | undefined;
export async function sendAPNs(
  d: PushRequest,
): Promise<{ status: number; reason?: string }> {
  if (!pushConfigured())
    throw new Error("Apple push notifications are not configured.");
  if (!cachedJWT || cachedJWT.until < Date.now()) {
    const key = await importPKCS8(
      process.env.APNS_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      "ES256",
    );
    cachedJWT = {
      token: await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: process.env.APNS_KEY_ID! })
        .setIssuer(process.env.APNS_TEAM_ID!)
        .setIssuedAt()
        .sign(key),
      until: Date.now() + 45 * 60_000,
    };
  }
  const bearer = cachedJWT.token;
  return new Promise((resolve, reject) => {
    const client = connect(
      d.environment === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com",
    );
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Apple push request timed out."));
    }, 15_000);
    client.on("error", () => {
      clearTimeout(timer);
      client.destroy();
      reject(new Error("Apple push connection failed."));
    });
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${d.token}`,
      authorization: `bearer ${bearer}`,
      "apns-topic": "com.jimgreco.doorstep",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-id": d.id,
      "apns-collapse-id": d.id,
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
    });
    let status = 0,
      body = "";
    request.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("error", () => {
      clearTimeout(timer);
      client.destroy();
      reject(new Error("Apple push request failed."));
    });
    request.on("end", () => {
      clearTimeout(timer);
      client.close();
      let reason: string | undefined;
      try {
        reason = JSON.parse(body).reason;
      } catch {}
      resolve({ status, reason });
    });
    // Keep merchant, item names, email content and tracking numbers off the lock screen.
    request.end(
      JSON.stringify({
        aps: {
          alert: { title: "Doorstep", body: d.message },
          sound: "default",
          "thread-id": d.shipment_id,
        },
        shipmentId: d.shipment_id,
        householdId: d.household_id,
      }),
    );
  });
}
export async function deliverPush(id: string, sender = sendAPNs) {
  // Serialize retries. Recheck membership, session, preferences and current package state immediately before sending.
  await transaction(async (c) => {
    const [d] = (
      await c.query(
        `SELECT q.*,d.token,d.environment,to_jsonb(s) AS shipment,o.ordered_at FROM push_deliveries q JOIN push_devices d ON d.id=q.device_id
      JOIN native_sessions n ON n.token_hash=d.session_hash AND n.expires_at>now()
      JOIN household_members m ON m.user_id=d.user_id AND m.household_id=q.household_id
      JOIN notification_preferences p ON p.user_id=d.user_id AND p.household_id=q.household_id
      JOIN shipments s ON s.id=q.shipment_id AND s.household_id=q.household_id
      JOIN orders o ON o.id=s.order_id
      WHERE q.id=$1 AND q.status='pending' AND q.created_at>now()-interval '24 hours' AND p.enabled
      AND s.dismissed_at IS NULL AND s.archived_at IS NULL AND s.collected_at IS NULL
      AND CASE q.category WHEN 'out_for_delivery' THEN p.out_for_delivery AND s.status='out_for_delivery' WHEN 'delivered' THEN p.delivered AND s.status='delivered' WHEN 'pickup' THEN p.pickup AND s.status='available_for_pickup' ELSE p.problems AND s.status NOT IN ('delivered','cancelled') END
      FOR UPDATE OF q`,
        [id],
      )
    ).rows;
    if (!d) {
      await c.query(
        "UPDATE push_deliveries SET status='skipped' WHERE id=$1 AND status='pending'",
        [id],
      );
      return;
    }
    if (d.category === "problems") {
      const eventStatus = String(d.event_key).split(":")[1];
      const resolved =
        eventStatus === "attention"
          ? !mapShipment({ ...d.shipment, ordered_at: d.ordered_at })
              .attentionReasons?.length
          : d.shipment.status !== eventStatus;
      if (resolved) {
        await c.query(
          "UPDATE push_deliveries SET status='skipped' WHERE id=$1",
          [id],
        );
        return;
      }
    }
    const result = await sender(d as PushRequest);
    if (
      result.status === 410 ||
      ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(
        result.reason || "",
      )
    ) {
      await c.query("DELETE FROM push_devices WHERE id=$1", [d.device_id]);
      return;
    }
    if (result.status !== 200)
      throw new Error(`Apple push request rejected (${result.status}).`);
    await c.query("UPDATE push_deliveries SET status='sent' WHERE id=$1", [id]);
  });
}
