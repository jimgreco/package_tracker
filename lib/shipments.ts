import { query, transaction, enqueue } from "./db";
import type {
  Shipment,
  DashboardData,
  Email,
  Settings,
  TrackingEvent,
} from "./types";
import type { Context } from "./auth";
import { AppError, origin, safeUrl } from "./security";
import { manualSchema } from "./validation";
import { normalizeEstimate, validZone } from "./calendar";
const iso = (d: unknown) =>
  d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null;
export function mapShipment(r: Record<string, unknown>): Shipment {
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    merchant: r.merchant as string,
    orderNumber: r.order_number as string | null,
    orderedAt: iso(r.ordered_at)?.slice(0, 10) || null,
    items: r.items as Shipment["items"],
    carrier: r.carrier as string | null,
    trackingNumber: r.tracking_number as string | null,
    trackingUrl: r.tracking_url as string | null,
    status: r.status as Shipment["status"],
    shippedAt: iso(r.shipped_at),
    estimate: r.estimate as Shipment["estimate"],
    deliveredAt: iso(r.delivered_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    statusAt: iso(r.status_at)!,
    lastCheckedAt: iso(r.last_checked_at),
    trackingState: r.tracking_state as Shipment["trackingState"],
    needsReview: r.needs_review as boolean,
    reviewReason: r.review_reason as string | null,
    manualOverride: r.manual_override as boolean,
    isDemo: r.is_demo as boolean,
  };
}
export async function shipments(householdId: string, includeArchived = false) {
  return (
    await query(
      "SELECT s.*,o.merchant,o.order_number,o.ordered_at FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.household_id=$1 AND ($2 OR s.archived_at IS NULL) ORDER BY coalesce(s.shipped_at,s.created_at) DESC",
      [householdId, includeArchived],
    )
  ).map(mapShipment);
}
export async function shipment(id: string, householdId?: string) {
  const rows = await query(
    "SELECT s.*,o.merchant,o.order_number,o.ordered_at,h.time_zone FROM shipments s JOIN orders o ON o.id=s.order_id JOIN households h ON h.id=s.household_id WHERE s.id=$1" +
      (householdId ? " AND s.household_id=$2" : ""),
    householdId ? [id, householdId] : [id],
  );
  if (!rows[0]) throw new AppError("Package not found.", 404);
  return { shipment: mapShipment(rows[0]), row: rows[0] };
}
export async function settings(ctx: Context): Promise<Settings> {
  const [account] = await query(
    "SELECT google_email FROM users WHERE id=$1 AND household_id=$2",
    [ctx.userId, ctx.householdId],
  );
  const households = await query(
    "SELECT h.id,h.name,m.role FROM household_members m JOIN households h ON h.id=m.household_id WHERE m.user_id=$1 ORDER BY h.name",
    [ctx.userId],
  );
  const members = await query(
    `SELECT u.id AS "userId",u.name,COALESCE(u.google_email,u.email) AS email,m.role,false AS pending FROM household_members m JOIN users u ON u.id=m.user_id WHERE m.household_id=$1
    UNION ALL SELECT NULL,NULL,email,'member',true FROM household_invitations WHERE household_id=$1 ORDER BY pending,name,email`,
    [ctx.householdId],
  );
  const [g] = await query(
    "SELECT calendar_id,last_synced_at,error FROM google_connections WHERE household_id=$1",
    [ctx.householdId],
  );
  const [w] = await query(
    "SELECT last_seen_at FROM service_health WHERE name='worker'",
  );
  const [dead] = await query(
    "SELECT count(*)::int count FROM jobs WHERE status='dead' AND payload->>'householdId'=$1",
    [ctx.householdId],
  );
  return {
    householdName: ctx.householdName,
    timeZone: ctx.timeZone,
    forwardingAddress:
      process.env.INBOUND_DOMAIN && !ctx.demo
        ? `packages+${ctx.forwardingToken}@${process.env.INBOUND_DOMAIN}`
        : null,
    calendarFeedUrl: `${origin()}/api/calendar/${ctx.feedToken}.ics`,
    demo: ctx.demo,
    services: {
      openai: !!process.env.OPENAI_API_KEY,
      easypost: !!process.env.EASYPOST_API_KEY,
      postmark:
        !!process.env.POSTMARK_WEBHOOK_PASSWORD && !!process.env.INBOUND_DOMAIN,
      google:
        !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
      storage: !!process.env.S3_BUCKET,
    },
    google: {
      connected: !!g,
      calendarId: g?.calendar_id || null,
      lastSyncedAt: iso(g?.last_synced_at),
      error: g?.error || null,
    },
    worker: { lastSeenAt: iso(w?.last_seen_at), failedJobs: dead?.count || 0 },
    userName: ctx.name,
    account: { email: account?.google_email || ctx.email },
    householdId: ctx.householdId,
    role: households.find((h) => h.id === ctx.householdId)?.role || "member",
    households: households as Settings["households"],
    members: members as Settings["members"],
  };
}
export async function emails(householdId: string): Promise<Email[]> {
  const rows = await query(
    "SELECT id,subject,sender,received_at,status,error FROM source_emails WHERE household_id=$1 ORDER BY received_at DESC LIMIT 100",
    [householdId],
  );
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    from: r.sender,
    receivedAt: iso(r.received_at)!,
    status: r.status,
    error: r.error,
  }));
}
export async function dashboard(ctx: Context): Promise<DashboardData> {
  const [s, e, settingsData] = await Promise.all([
    shipments(ctx.householdId),
    emails(ctx.householdId),
    settings(ctx),
  ]);
  return { shipments: s, emails: e, settings: settingsData };
}
export async function detail(id: string, ctx: Context) {
  const { shipment: s } = await shipment(id, ctx.householdId);
  const rows = await query(
    "SELECT * FROM tracking_events WHERE shipment_id=$1 ORDER BY occurred_at DESC",
    [id],
  );
  const events: TrackingEvent[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    message: r.message,
    location: r.location,
    occurredAt: iso(r.occurred_at)!,
    source: r.source,
  }));
  const sources = await query(
    "SELECT e.id,e.subject,e.sender,e.body_text,e.received_at,e.extraction FROM source_emails e JOIN shipment_emails se ON se.email_id=e.id WHERE se.shipment_id=$1 ORDER BY received_at DESC",
    [id],
  );
  return {
    shipment: s,
    events,
    emails: sources.map((r) => ({
      id: r.id,
      subject: r.subject,
      from: r.sender,
      text: r.body_text,
      receivedAt: iso(r.received_at)!,
      extraction: r.extraction,
    })),
  };
}
export async function saveManual(input: unknown, ctx: Context, id?: string) {
  const v = manualSchema.parse(input);
  v.estimate = normalizeEstimate(v.estimate);
  if (v.trackingUrl && !safeUrl(v.trackingUrl))
    throw new AppError("Tracking links must use HTTPS.");
  // User-provided images are only references to already-stored household assets.
  for (const item of v.items) {
    if (item.imageUrl && !/^\/api\/assets\/[0-9a-f-]{36}$/.test(item.imageUrl))
      item.imageUrl = null;
    else if (item.imageUrl) {
      const [asset] = await query(
        "SELECT 1 FROM assets WHERE id=$1 AND household_id=$2",
        [item.imageUrl.split("/").pop(), ctx.householdId],
      );
      if (!asset) item.imageUrl = null;
    }
  }
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.householdId,
    ]);
    let existing;
    if (id) {
      existing = (
        await c.query(
          "SELECT * FROM shipments WHERE id=$1 AND household_id=$2 FOR UPDATE",
          [id, ctx.householdId],
        )
      ).rows[0];
      if (!existing) throw new AppError("Package not found.", 404);
    }
    const duplicate = v.trackingNumber
      ? (
          await c.query(
            "SELECT id FROM shipments WHERE household_id=$1 AND lower(regexp_replace(tracking_number,'[^a-zA-Z0-9]','','g'))=lower(regexp_replace($2,'[^a-zA-Z0-9]','','g')) AND coalesce(lower(carrier),'')=coalesce(lower($3),'') AND created_at>now()-interval '120 days' AND ($4::uuid IS NULL OR id<>$4) LIMIT 1",
            [ctx.householdId, v.trackingNumber, v.carrier, id || null],
          )
        ).rows[0]
      : null;
    if (duplicate)
      throw new AppError(
        "This tracking number is already in your household. Open that package to edit it.",
        409,
      );
    let orderId = existing?.order_id;
    if (orderId)
      await c.query(
        "UPDATE orders SET merchant=$1,merchant_key=$2,order_number=$3,ordered_at=$4 WHERE id=$5",
        [
          v.merchant,
          v.merchant.toLowerCase(),
          v.orderNumber || null,
          v.orderedAt,
          orderId,
        ],
      );
    else {
      const row = (
        await c.query(
          `INSERT INTO orders(household_id,merchant,merchant_key,order_number,ordered_at,items) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(household_id,merchant_key,order_number) DO UPDATE SET ordered_at=coalesce(EXCLUDED.ordered_at,orders.ordered_at) RETURNING id`,
          [
            ctx.householdId,
            v.merchant,
            v.merchant.toLowerCase(),
            v.orderNumber || null,
            v.orderedAt,
            JSON.stringify(v.items),
          ],
        )
      ).rows[0];
      orderId = row.id;
    }
    const trackingChanged =
      existing &&
      (existing.tracking_number !== v.trackingNumber ||
        existing.carrier !== v.carrier);
    const state = v.trackingNumber
      ? ctx.demo
        ? "none"
        : process.env.EASYPOST_API_KEY
          ? "pending"
          : "unconfigured"
      : "none";
    const params = [
      JSON.stringify(v.items),
      v.carrier || null,
      v.trackingNumber || null,
      v.trackingUrl || null,
      v.status,
      v.shippedAt,
      JSON.stringify(v.estimate),
      v.deliveredAt,
      !!v.manualOverride,
      state,
    ];
    let saved;
    if (id) {
      saved = (
        await c.query(
          `UPDATE shipments SET items=$1,carrier=$2,tracking_number=$3,tracking_url=$4,status=$5,shipped_at=$6,estimate=$7,delivered_at=$8,manual_override=$9,tracking_state=CASE WHEN $12 THEN $10 ELSE tracking_state END,tracker_id=CASE WHEN $12 THEN NULL ELSE tracker_id END,needs_review=false,review_reason=NULL,updated_at=now(),status_at=now(),estimate_at=now(),version=version+1 WHERE id=$11 RETURNING *`,
          [...params, id, !!trackingChanged],
        )
      ).rows[0];
    } else {
      saved = (
        await c.query(
          `INSERT INTO shipments(items,carrier,tracking_number,tracking_url,status,shipped_at,estimate,delivered_at,manual_override,tracking_state,household_id,order_id,is_demo,estimate_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) RETURNING *`,
          [...params, ctx.householdId, orderId, ctx.demo],
        )
      ).rows[0];
    }
    await c.query(
      `INSERT INTO tracking_events(shipment_id,event_key,status,message,occurred_at,source) VALUES($1,$2,$3,$4,now(),'Manual edit') ON CONFLICT DO NOTHING`,
      [
        saved.id,
        `manual:${saved.version}`,
        v.status,
        id
          ? "Package details updated by your household."
          : "Package added by your household.",
      ],
    );
    if (!ctx.demo) {
      if (v.trackingNumber && (!existing || trackingChanged))
        await enqueue(
          "track_register",
          { shipmentId: saved.id, householdId: ctx.householdId },
          `register:${saved.id}:${saved.version}`,
          c,
        );
      await enqueue(
        "google_sync",
        { shipmentId: saved.id, householdId: ctx.householdId },
        `calendar:${saved.id}:${saved.version}`,
        c,
      );
    }
    return saved.id as string;
  });
}
export async function updateHousehold(
  ctx: Context,
  input: { name: string; timeZone: string },
) {
  if (
    !input.name?.trim() ||
    input.name.length > 120 ||
    !validZone(input.timeZone)
  )
    throw new AppError("Enter a household name and valid time zone.");
  await query("UPDATE households SET name=$1,time_zone=$2 WHERE id=$3", [
    input.name.trim(),
    input.timeZone,
    ctx.householdId,
  ]);
  const all = await query(
    "UPDATE shipments SET version=version+1,updated_at=now() WHERE household_id=$1 RETURNING id,version",
    [ctx.householdId],
  );
  if (!ctx.demo)
    for (const s of all)
      await enqueue(
        "google_sync",
        { shipmentId: s.id, householdId: ctx.householdId },
        `calendar:${s.id}:${s.version}`,
      );
}
