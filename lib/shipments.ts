import { query, transaction, enqueue } from "./db";
import type {
  Shipment,
  DashboardData,
  Email,
  Settings,
  TrackingEvent,
} from "./types";
import type { Context } from "./auth";
import { AppError, origin, safeUrl, hash } from "./security";
import { manualSchema } from "./validation";
import { normalizeEstimate, validZone } from "./calendar";
import { gmailAvailable } from "./gmail";
import { trackingConfigured } from "./tracking-config";
import { attentionReasons } from "./attention";
const iso = (d: unknown) =>
  d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null;
export function mapShipment(r: Record<string, unknown>): Shipment {
  const mapped: Shipment = {
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
    collectedAt: iso(r.collected_at),
    collectedByName: r.collected_by_name as string | null,
    createdAt: iso(r.created_at)!,
    timelineAt: iso(r.timeline_at || r.created_at)!,
    firstEmailAt: iso(r.first_email_at),
    dismissedAt: iso(r.dismissed_at),
    snoozedAt: iso(r.snoozed_at),
    archivedAt: iso(r.archived_at),
    updatedAt: iso(r.updated_at)!,
    statusAt: iso(r.status_at)!,
    lastCheckedAt: iso(r.last_checked_at),
    trackingState: r.tracking_state as Shipment["trackingState"],
    needsReview: r.needs_review as boolean,
    reviewReason: r.review_reason as string | null,
    manualOverride: r.manual_override as boolean,
    isDemo: r.is_demo as boolean,
  };
  return { ...mapped, attentionReasons: attentionReasons(mapped) };
}
export async function shipments(
  householdId: string,
  includeArchived = false,
  includeDismissed = false,
) {
  return (
    await query(
      `SELECT s.*,o.merchant,o.order_number,o.ordered_at,source.first_email_at,
       least(s.created_at,coalesce(source.first_email_at,s.created_at)) AS timeline_at
       FROM shipments s JOIN orders o ON o.id=s.order_id
       LEFT JOIN LATERAL (SELECT min(coalesce(e.sent_at,e.received_at)) AS first_email_at
         FROM shipment_emails se JOIN source_emails e ON e.id=se.email_id
         WHERE se.shipment_id=s.id AND e.household_id=s.household_id) source ON true
       WHERE s.household_id=$1 AND ($2 OR s.archived_at IS NULL) AND ($3 OR s.dismissed_at IS NULL)
       ORDER BY timeline_at DESC,s.created_at DESC,s.id DESC`,
      [householdId, includeArchived, includeDismissed],
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
  const [gmail] = await query(
    "SELECT g.*,h.name AS household_name FROM gmail_connections g JOIN households h ON h.id=g.household_id WHERE g.user_id=$1",
    [ctx.userId],
  );
  const ownGmail = gmail?.household_id === ctx.householdId ? gmail : null;
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
      gmail: gmailAvailable(ctx),
    },
    google: {
      connected: !!g,
      calendarId: g?.calendar_id || null,
      lastSyncedAt: iso(g?.last_synced_at),
      error: g?.error || null,
    },
    gmail: {
      connected: !!ownGmail,
      email: ownGmail?.email || null,
      enabled: !!ownGmail?.enabled,
      needsReconnect: !!ownGmail?.needs_reconnect,
      lastSyncedAt: iso(ownGmail?.last_synced_at),
      importedCount: ownGmail?.imported_count || 0,
      importing:
        !!ownGmail && (!ownGmail.last_synced_at || !!ownGmail.page_token),
      error: ownGmail?.error || null,
      otherHouseholdName: gmail && !ownGmail ? gmail.household_name : null,
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
    "SELECT id,subject,sender,sent_at,received_at,status,error FROM source_emails WHERE household_id=$1 AND status<>'ignored' ORDER BY coalesce(sent_at,received_at) DESC,id DESC LIMIT 100",
    [householdId],
  );
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    from: r.sender,
    receivedAt: iso(r.received_at)!,
    sentAt: iso(r.sent_at),
    status: r.status,
    error: r.error,
  }));
}
export async function dashboard(ctx: Context): Promise<DashboardData> {
  const [s, e, settingsData] = await Promise.all([
    shipments(ctx.householdId, false, true),
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
    "SELECT e.id,e.subject,e.sender,e.body_text,e.sent_at,e.received_at,e.extraction FROM source_emails e JOIN shipment_emails se ON se.email_id=e.id WHERE se.shipment_id=$1 ORDER BY coalesce(e.sent_at,e.received_at) DESC,e.id DESC",
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
      sentAt: iso(r.sent_at),
      extraction: r.extraction,
    })),
  };
}
export async function quickShipmentAction(
  id: string,
  ctx: Context,
  action:
    | "deliver"
    | "dismiss"
    | "restore"
    | "collect"
    | "uncollect"
    | "snooze"
    | "unsnooze",
) {
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      ctx.householdId,
    ]);
    const [existing] = (
      await c.query(
        "SELECT * FROM shipments WHERE id=$1 AND household_id=$2 AND archived_at IS NULL FOR UPDATE",
        [id, ctx.householdId],
      )
    ).rows;
    if (!existing) throw new AppError("Package not found.", 404);
    if (action === "snooze" || action === "unsnooze") {
      if (existing.dismissed_at)
        throw new AppError("Restore this package before snoozing it.");
      if ((action === "snooze") === !!existing.snoozed_at) return;
      await c.query(
        `UPDATE shipments SET snoozed_at=${action === "snooze" ? "now()" : "NULL"},updated_at=now() WHERE id=$1`,
        [id],
      );
      return;
    }
    if (action === "collect" || action === "uncollect") {
      if (existing.status !== "delivered" || existing.dismissed_at)
        throw new AppError(
          "Only delivered, visible packages can be marked collected.",
        );
      if ((action === "collect") === !!existing.collected_at) return;
      const [saved] = (
        await c.query(
          "UPDATE shipments SET collected_at=CASE WHEN $2 THEN now() ELSE NULL END,collected_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,collected_by_name=CASE WHEN $2 THEN $4 ELSE NULL END,updated_at=now(),version=version+1 WHERE id=$1 RETURNING version",
          [id, action === "collect", ctx.userId, ctx.name],
        )
      ).rows;
      await c.query(
        "INSERT INTO tracking_events(shipment_id,event_key,status,message,occurred_at,source) VALUES($1,$2,'delivered',$3,now(),'Household')",
        [
          id,
          `collection:${saved.version}`,
          action === "collect"
            ? `Collected by ${ctx.name}.`
            : `Collection undone by ${ctx.name}.`,
        ],
      );
      return;
    }
    if (
      (action === "dismiss" && existing.dismissed_at) ||
      (action === "restore" && !existing.dismissed_at) ||
      (action === "deliver" && existing.status === "delivered")
    )
      return;
    if (
      action === "deliver" &&
      (existing.dismissed_at ||
        ["cancelled", "return_to_sender"].includes(existing.status))
    )
      throw new AppError(
        "Restore or edit this package before marking it delivered.",
      );
    const [saved] = (
      await c.query(
        action === "deliver"
          ? "UPDATE shipments SET status='delivered',status_at=now(),manual_override=true,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *"
          : `UPDATE shipments SET dismissed_at=${action === "dismiss" ? "now()" : "NULL"},snoozed_at=NULL,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
        [id],
      )
    ).rows;
    // A quick confirmation does not assert that delivery happened today.
    await c.query(
      "INSERT INTO tracking_events(shipment_id,event_key,status,message,occurred_at,source) VALUES($1,$2,$3,$4,now(),'Household')",
      [
        id,
        `manual:${action}:${saved.version}`,
        saved.status,
        action === "deliver"
          ? "Marked delivered by your household; delivery date not specified."
          : action === "dismiss"
            ? "Dismissed by your household."
            : "Restored by your household.",
      ],
    );
    if (!ctx.demo) {
      await enqueue(
        "google_sync",
        { shipmentId: id, householdId: ctx.householdId },
        `calendar:${id}:${saved.version}`,
        c,
      );
      if (
        action === "restore" &&
        saved.tracking_number &&
        !["delivered", "cancelled", "return_to_sender"].includes(saved.status)
      )
        await enqueue(
          saved.tracker_id ? "track_refresh" : "track_register",
          { shipmentId: id, householdId: ctx.householdId },
          `restore:${id}:${saved.version}`,
          c,
        );
    }
  });
}
export async function saveManual(
  input: unknown,
  ctx: Context,
  id?: string,
  idempotencyKey?: string,
) {
  const v = manualSchema.parse(input);
  if (idempotencyKey && !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))
    throw new AppError("Invalid save attempt key.");
  const bodyHash = hash(JSON.stringify(v));
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
    if (!id && idempotencyKey) {
      const [previous] = (
        await c.query(
          "SELECT * FROM manual_create_attempts WHERE user_id=$1 AND household_id=$2 AND route='shipments' AND key=$3",
          [ctx.userId, ctx.householdId, idempotencyKey],
        )
      ).rows;
      if (previous) {
        if (previous.body_hash !== bodyHash)
          throw new AppError(
            "This save attempt was already used with different details. Start a new save.",
            409,
          );
        return previous.shipment_id as string;
      }
    }
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
        : trackingConfigured(v.carrier)
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
          `UPDATE shipments SET collected_at=CASE WHEN $5='delivered' THEN collected_at ELSE NULL END,collected_by=CASE WHEN $5='delivered' THEN collected_by ELSE NULL END,collected_by_name=CASE WHEN $5='delivered' THEN collected_by_name ELSE NULL END,items=$1,carrier=$2,tracking_number=$3,tracking_url=$4,status=$5,shipped_at=$6,estimate=$7,delivered_at=$8,manual_override=$9,tracking_state=CASE WHEN $12 THEN $10 ELSE tracking_state END,tracker_id=CASE WHEN $12 THEN NULL ELSE tracker_id END,needs_review=false,review_reason=NULL,updated_at=now(),status_at=now(),estimate_at=now(),version=version+1 WHERE id=$11 RETURNING *`,
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
    if (!id && idempotencyKey)
      await c.query(
        "INSERT INTO manual_create_attempts(user_id,household_id,route,key,body_hash,shipment_id) VALUES($1,$2,'shipments',$3,$4,$5)",
        [ctx.userId, ctx.householdId, idempotencyKey, bodyHash, saved.id],
      );
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
