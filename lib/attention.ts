import { Temporal } from "@js-temporal/polyfill";
import { instant } from "./calendar";
import type { Shipment } from "./types";

// Computed from current facts, without changing carrier status or protected estimates.
export function attentionReasons(s: Shipment, now = new Date()): string[] {
  if (
    s.dismissedAt ||
    s.archivedAt ||
    s.collectedAt ||
    ["delivered", "cancelled", "return_to_sender"].includes(s.status)
  )
    return [];
  const reasons: string[] = [];
  if (s.needsReview)
    reasons.push(s.reviewReason || "Package details need review.");
  if (["failure", "delayed", "unknown"].includes(s.status))
    reasons.push(
      s.status === "failure"
        ? "The carrier reported a delivery problem."
        : s.status === "delayed"
          ? "The carrier reported a delay."
          : "Delivery status is unknown.",
    );
  const e = s.estimate;
  if (e) {
    try {
      const past =
        e.kind === "date" || e.kind === "date_range"
          ? Temporal.PlainDate.compare(
              Temporal.Instant.from(now.toISOString())
                .toZonedDateTimeISO(e.timeZone)
                .toPlainDate(),
              Temporal.PlainDate.from(e.end || e.start),
            ) > 0
          : now.getTime() >
            Number(instant(e.end || e.start, e.timeZone).epochMilliseconds) +
              (e.kind === "point" ? 2 * 3600_000 : 0);
      if (past) reasons.push("The expected delivery time has passed.");
    } catch {
      reasons.push("The delivery estimate needs review.");
    }
  }
  const age = now.getTime() - Date.parse(s.orderedAt || s.createdAt);
  if (
    ["ordered", "pre_transit"].includes(s.status) &&
    age >= 7 * 86400_000 &&
    !s.shippedAt
  )
    reasons.push("No shipment confirmed after seven days.");
  if (
    ["error", "unconfigured", "unsupported"].includes(s.trackingState) &&
    s.trackingNumber
  )
    reasons.push(
      s.trackingState === "error"
        ? "Tracking could not be refreshed."
        : s.trackingState === "unsupported"
          ? "Automatic tracking is unavailable for this carrier."
          : "Tracking is not connected for this carrier.",
    );
  else if (
    s.trackingNumber &&
    ["active", "pending"].includes(s.trackingState)
  ) {
    const elapsed = now.getTime() - Date.parse(s.lastCheckedAt || s.createdAt);
    const limit = s.status === "out_for_delivery" ? 60 * 60_000 : 12 * 3600_000;
    if (elapsed >= limit)
      reasons.push("Tracking is overdue for a fresh check.");
  }
  return [...new Set(reasons)];
}
