import { z } from "zod";
import { query, transaction, enqueue } from "./db";
import { shipment } from "./shipments";
import { AppError, hash } from "./security";
import type { Estimate, Status } from "./types";
import { STATUSES } from "./types";
export const trackerSchema = z.object({
  id: z.string().startsWith("trk_"),
  tracking_code: z.string(),
  carrier: z.string().nullable().optional(),
  status: z.string(),
  status_detail: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  est_delivery_date: z.string().nullable().optional(),
  carrier_detail: z
    .object({
      est_delivery_date_local: z.string().nullable().optional(),
      est_delivery_time_local: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  tracking_details: z
    .array(
      z.object({
        status: z.string(),
        message: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        datetime: z.string(),
        source: z.string().nullable().optional(),
        tracking_location: z
          .object({
            city: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
            country: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
});
export type Tracker = z.infer<typeof trackerSchema>;
async function easy(path: string, method = "GET", body?: unknown) {
  if (!process.env.EASYPOST_API_KEY)
    throw new AppError("Tracking service is not configured.", 503);
  const res = await fetch(`https://api.easypost.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(process.env.EASYPOST_API_KEY + ":").toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new AppError(
      data.error?.message || `Tracking service returned ${res.status}.`,
      res.status,
    );
    throw error;
  }
  return data;
}
export function trackerStatus(status: string, detail?: string | null): Status {
  if (detail === "delayed") return "delayed";
  return (STATUSES as readonly string[]).includes(status)
    ? (status as Status)
    : "unknown";
}
export async function registerTracking(id: string) {
  const { shipment: s, row } = await shipment(id);
  if (s.isDemo || s.dismissedAt || s.archivedAt) return;
  if (!s.trackingNumber) return;
  if (!process.env.EASYPOST_API_KEY) {
    await query(
      "UPDATE shipments SET tracking_state='unconfigured' WHERE id=$1",
      [id],
    );
    return;
  }
  if (row.tracker_id) {
    await refreshTracking(id);
    return;
  }
  try {
    const tracker = trackerSchema.parse(
      await easy("/trackers", "POST", {
        tracker: {
          tracking_code: s.trackingNumber,
          ...(s.carrier ? { carrier: s.carrier } : {}),
        },
      }),
    );
    const updated = await query(
      "UPDATE shipments SET tracker_id=$1,tracking_state='active',tracking_error=NULL WHERE id=$2 AND tracking_number=$3 AND carrier IS NOT DISTINCT FROM $4 RETURNING id",
      [tracker.id, id, s.trackingNumber, s.carrier],
    );
    if (updated.length) await applyTracker(id, tracker);
  } catch (e) {
    if (e instanceof AppError && [400, 404, 422].includes(e.status)) {
      await query(
        "UPDATE shipments SET tracking_state='unsupported',tracking_error=$2,last_checked_at=now() WHERE id=$1",
        [id, e.message],
      );
      return;
    }
    await query(
      "UPDATE shipments SET tracking_state='error',tracking_error='Tracking service could not be reached.' WHERE id=$1",
      [id],
    );
    throw e;
  }
}
export async function refreshTracking(id: string) {
  const { shipment: s, row } = await shipment(id);
  if (s.isDemo || s.dismissedAt || s.archivedAt) return;
  if (!row.tracker_id) return registerTracking(id);
  try {
    await applyTracker(
      id,
      trackerSchema.parse(
        await easy(`/trackers/${encodeURIComponent(row.tracker_id)}`),
      ),
    );
  } catch (e) {
    await query(
      "UPDATE shipments SET tracking_state='error',tracking_error='Could not refresh tracking. We will retry.' WHERE id=$1",
      [id],
    );
    throw e;
  }
}
export function carrierEstimate(t: Tracker, timeZone: string): Estimate | null {
  // A timestamp in est_delivery_date is commonly a date placeholder. Never invent a time window.
  const local = t.carrier_detail?.est_delivery_date_local;
  const raw = local || t.est_delivery_date;
  const day = raw?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!day) return null;
  return {
    kind: "date",
    start: day,
    end: null,
    timeZone,
    label: "Estimated by the carrier",
  };
}
export async function applyTracker(id: string, tracker: Tracker) {
  await transaction(async (c) => {
    const [s] = (
      await c.query(
        "SELECT s.*,h.time_zone FROM shipments s JOIN households h ON h.id=s.household_id WHERE s.id=$1 FOR UPDATE OF s",
        [id],
      )
    ).rows;
    if (
      !s ||
      s.is_demo ||
      s.dismissed_at ||
      s.archived_at ||
      s.tracker_id !== tracker.id
    )
      return;
    const history = [...tracker.tracking_details]
      .filter((d) => Number.isFinite(Date.parse(d.datetime)))
      .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    for (const d of history) {
      const message = d.message || d.description || d.status;
      const loc =
        [
          d.tracking_location?.city,
          d.tracking_location?.state,
          d.tracking_location?.country,
        ]
          .filter(Boolean)
          .join(", ") || null;
      await c.query(
        `INSERT INTO tracking_events(shipment_id,event_key,status,message,location,occurred_at,source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          id,
          hash(`${tracker.id}:${d.datetime}:${d.status}:${message}`),
          trackerStatus(d.status),
          message,
          loc,
          d.datetime,
          d.source || tracker.carrier || "Carrier",
        ],
      );
    }
    const last = history.at(-1);
    const at = last?.datetime || tracker.updated_at;
    if (!at || !Number.isFinite(Date.parse(at))) {
      await c.query(
        "UPDATE shipments SET last_checked_at=now(),tracking_state='active',tracking_error=NULL WHERE id=$1",
        [id],
      );
      return;
    }
    let nextStatus = trackerStatus(tracker.status, tracker.status_detail);
    if (
      last &&
      Date.parse(last.datetime) >
        Date.parse(tracker.updated_at || last.datetime)
    )
      nextStatus = trackerStatus(last.status);
    const estimate = carrierEstimate(tracker, s.time_zone);
    let merged = s.estimate as Estimate | null;
    // Retain a narrower email window when the carrier confirms that same date.
    if (
      estimate &&
      (!merged ||
        merged.start.slice(0, 10) !== estimate.start ||
        merged.kind === "date" ||
        merged.kind === "date_range")
    )
      merged = estimate;
    const fresh =
      !s.last_checked_at || Date.parse(at) >= new Date(s.status_at).getTime();
    const final = ["delivered", "cancelled", "return_to_sender"].includes(
      s.status,
    );
    const canUpdate =
      fresh && !s.manual_override && (!final || s.status === nextStatus);
    const estimateAt =
      tracker.updated_at && Number.isFinite(Date.parse(tracker.updated_at))
        ? tracker.updated_at
        : at;
    const canEstimate =
      !s.manual_override &&
      !final &&
      !!estimate &&
      (!s.estimate_at ||
        Date.parse(estimateAt) >= new Date(s.estimate_at).getTime());
    const delivered =
      [...history].reverse().find((d) => d.status === "delivered")?.datetime ||
      null;
    const changed =
      (canUpdate &&
        (s.status !== nextStatus || (!s.delivered_at && delivered))) ||
      (canEstimate && JSON.stringify(s.estimate) !== JSON.stringify(merged));
    const [saved] = (
      await c.query(
        `UPDATE shipments SET status=CASE WHEN $2 THEN $3 ELSE status END,status_at=CASE WHEN $2 THEN $4::timestamptz ELSE status_at END,delivered_at=CASE WHEN $2 AND $3='delivered' THEN coalesce($5,delivered_at) ELSE delivered_at END,estimate=CASE WHEN $6 THEN $7::jsonb ELSE estimate END,estimate_at=CASE WHEN $6 THEN $8::timestamptz ELSE estimate_at END,last_checked_at=now(),tracking_state='active',tracking_error=NULL,version=version+CASE WHEN $9 THEN 1 ELSE 0 END,updated_at=CASE WHEN $9 THEN now() ELSE updated_at END WHERE id=$1 RETURNING *`,
        [
          id,
          canUpdate,
          nextStatus,
          at,
          delivered,
          canEstimate,
          JSON.stringify(merged),
          estimateAt,
          !!changed,
        ],
      )
    ).rows;
    if (changed)
      await enqueue(
        "google_sync",
        { shipmentId: id, householdId: s.household_id },
        `calendar:${id}:${saved.version}`,
        c,
      );
  });
}
export async function trackingWebhook(data: unknown) {
  const payload = z
    .object({ id: z.string(), description: z.string(), result: z.unknown() })
    .parse(data);
  if (payload.description !== "tracker.updated") return;
  const tracker = trackerSchema.parse(payload.result);
  const found = await query(
    "SELECT id,household_id FROM shipments WHERE tracker_id=$1 AND is_demo=false",
    [tracker.id],
  );
  for (const s of found)
    await enqueue(
      "track_webhook",
      { shipmentId: s.id, householdId: s.household_id, tracker },
      `webhook:${payload.id}:${s.id}`,
    );
}
