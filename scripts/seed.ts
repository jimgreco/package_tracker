import { pool, transaction } from "../lib/db";
import { demoShipments, DEMO_HOUSEHOLD, DEMO_USER } from "../lib/demo";
import { randomToken } from "../lib/security";
if (process.env.DEMO_MODE !== "true")
  throw new Error("Demo seeding requires DEMO_MODE=true.");
await transaction(async (c) => {
  await c.query("SELECT pg_advisory_xact_lock(4317002)");
  await c.query(
    `INSERT INTO households(id,name,forwarding_token,feed_token,is_demo) VALUES($1,'Our household',$2,$3,true) ON CONFLICT DO NOTHING`,
    [DEMO_HOUSEHOLD, randomToken(), randomToken()],
  );
  await c.query(
    `INSERT INTO users(id,household_id,email,name) VALUES($1,$2,'preview@example.invalid','Preview') ON CONFLICT DO NOTHING`,
    [DEMO_USER, DEMO_HOUSEHOLD],
  );
  await c.query(
    "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",
    [DEMO_HOUSEHOLD, DEMO_USER],
  );
  for (const s of demoShipments()) {
    await c.query(
      `INSERT INTO orders(id,household_id,merchant,merchant_key,order_number,ordered_at,items) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET ordered_at=EXCLUDED.ordered_at`,
      [
        s.orderId,
        DEMO_HOUSEHOLD,
        s.merchant,
        s.merchant.toLowerCase(),
        s.orderNumber,
        s.orderedAt,
        JSON.stringify(s.items),
      ],
    );
    await c.query(
      `INSERT INTO shipments(id,household_id,order_id,items,carrier,tracking_number,status,shipped_at,estimate,delivered_at,status_at,last_checked_at,tracking_state,is_demo,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14) ON CONFLICT(id) DO UPDATE SET shipped_at=EXCLUDED.shipped_at,estimate=EXCLUDED.estimate,delivered_at=EXCLUDED.delivered_at,status_at=EXCLUDED.status_at,last_checked_at=EXCLUDED.last_checked_at,created_at=EXCLUDED.created_at WHERE shipments.is_demo=true`,
      [
        s.id,
        DEMO_HOUSEHOLD,
        s.orderId,
        JSON.stringify(s.items),
        s.carrier,
        s.trackingNumber,
        s.status,
        s.shippedAt,
        JSON.stringify(s.estimate),
        s.deliveredAt,
        s.statusAt,
        s.lastCheckedAt,
        s.trackingState,
        s.createdAt,
      ],
    );
    await c.query(
      `INSERT INTO tracking_events(shipment_id,event_key,status,message,occurred_at,source) VALUES($1,'sample',$2,$3,$4,'Sample update') ON CONFLICT(shipment_id,event_key) DO UPDATE SET status=EXCLUDED.status,message=EXCLUDED.message,occurred_at=EXCLUDED.occurred_at`,
      [
        s.id,
        s.status === "ordered" ? "ordered" : "in_transit",
        s.status === "ordered"
          ? "Order confirmed by the shop."
          : "Package received by the carrier.",
        s.shippedAt || s.createdAt,
      ],
    );
    if (s.status !== "ordered")
      await c.query(
        `INSERT INTO tracking_events(shipment_id,event_key,status,message,occurred_at,source) VALUES($1,'sample-current',$2,$3,$4,'Sample carrier update') ON CONFLICT(shipment_id,event_key) DO UPDATE SET occurred_at=EXCLUDED.occurred_at`,
        [
          s.id,
          s.status,
          s.status === "out_for_delivery"
            ? "On the delivery vehicle. Estimated arrival between 2 PM and 6 PM."
            : s.status === "delivered"
              ? "Delivered at the front door."
              : "Departed the regional sorting facility.",
          s.statusAt,
        ],
      );
  }
});
console.log("Sample household ready. No external services were called.");
await pool().end();
