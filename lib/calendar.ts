import { Temporal } from "@js-temporal/polyfill";
import type { Estimate, Shipment } from "./types";
import { STATUS_LABEL } from "./types";
export function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}
export function dateInZone(value: string, zone: string) {
  return Temporal.Instant.from(value)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .toString();
}
export function instant(value: string, zone: string) {
  return /(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Temporal.Instant.from(value)
    : Temporal.PlainDateTime.from(value)
        .toZonedDateTime(zone, { disambiguation: "reject" })
        .toInstant();
}
export function normalizeEstimate(e: Estimate | null): Estimate | null {
  if (!e) return null;
  if (!validZone(e.timeZone)) throw new Error("Choose a valid time zone.");
  if (e.kind === "date" || e.kind === "date_range") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.start))
      throw new Error("Delivery date must use YYYY-MM-DD.");
    const start = Temporal.PlainDate.from(e.start);
    if (e.kind === "date_range") {
      if (!e.end || !/^\d{4}-\d{2}-\d{2}$/.test(e.end))
        throw new Error("A date range needs an end date.");
      if (Temporal.PlainDate.compare(start, Temporal.PlainDate.from(e.end)) > 0)
        throw new Error("Delivery end date must follow the start date.");
    }
    return { ...e, end: e.kind === "date" ? null : e.end };
  }
  const start = instant(e.start, e.timeZone);
  if (e.kind === "window") {
    if (
      !e.end ||
      Temporal.Instant.compare(start, instant(e.end, e.timeZone)) >= 0
    )
      throw new Error("Delivery end time must follow the start time.");
  }
  return { ...e, end: e.kind === "window" ? e.end : null };
}
export function nextDay(date: string) {
  return Temporal.PlainDate.from(date).add({ days: 1 }).toString();
}
export type CalendarFields = {
  summary: string;
  description: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  transparency: "transparent";
  status: "confirmed" | "cancelled";
  location: string;
};
export function calendarFields(
  s: Shipment,
  appOrigin: string,
  timeZone: string,
): CalendarFields | null {
  let estimate = s.estimate;
  if (s.status === "delivered" && s.deliveredAt)
    estimate = {
      kind: "date",
      start: dateInZone(s.deliveredAt, timeZone),
      end: null,
      timeZone,
      label: null,
    };
  if (!estimate) return null;
  estimate = normalizeEstimate(estimate)!;
  const itemNames = s.items
    .map((x) => x.name + (x.quantity > 1 ? ` × ${x.quantity}` : ""))
    .join(", ");
  const lines = [
    itemNames,
    `Status: ${STATUS_LABEL[s.status]}`,
    s.orderNumber ? `Order: ${s.orderNumber}` : "",
    s.carrier ? `Carrier: ${s.carrier}` : "",
    s.trackingNumber ? `Tracking: ${s.trackingNumber}` : "",
    s.trackingUrl || "",
    estimate.label || "",
    `View package: ${appOrigin}/?shipment=${s.id}`,
  ].filter(Boolean);
  let start: CalendarFields["start"], end: CalendarFields["end"];
  if (
    estimate.kind === "date" ||
    estimate.kind === "date_range" ||
    estimate.kind === "deadline"
  ) {
    const d =
      estimate.kind === "deadline"
        ? instant(estimate.start, estimate.timeZone)
            .toZonedDateTimeISO(estimate.timeZone)
            .toPlainDate()
            .toString()
        : estimate.start;
    start = { date: d };
    end = { date: nextDay(estimate.kind === "date_range" ? estimate.end! : d) };
    if (estimate.kind === "deadline")
      lines.push(
        `Delivery deadline: ${estimate.start} (${estimate.timeZone}). A deadline is not a delivery window.`,
      );
  } else {
    const i = instant(estimate.start, estimate.timeZone);
    start = { dateTime: i.toString(), timeZone: estimate.timeZone };
    end = {
      dateTime:
        estimate.kind === "window"
          ? instant(estimate.end!, estimate.timeZone).toString()
          : i.add({ seconds: 60 }).toString(),
      timeZone: estimate.timeZone,
    };
    if (estimate.kind === "point")
      lines.push(
        "Approximate arrival time. The one-minute calendar marker does not represent a delivery window.",
      );
  }
  return {
    summary: `${s.status === "delivered" ? "Delivered" : s.status === "cancelled" ? "Cancelled" : "Delivery"} · ${s.merchant}${itemNames ? " — " + itemNames : ""}`,
    description: lines.join("\n"),
    start,
    end,
    transparency: "transparent",
    status: s.status === "cancelled" ? "cancelled" : "confirmed",
    location: "Home",
  };
}
export function escapeIcs(s: string) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}
function stamp(value: string) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z/, "Z");
}
export function foldIcs(line: string) {
  let result = "",
    current = "",
    size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 75) {
      result += current + "\r\n";
      current = " ";
      size = 1;
    }
    current += char;
    size += bytes;
  }
  return result + current;
}
export function calendarFeed(
  shipments: Shipment[],
  appOrigin: string,
  timeZone: string,
) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Doorstep//Package Deliveries//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Package Deliveries",
  ];
  for (const s of shipments) {
    const e = calendarFields(s, appOrigin, timeZone);
    if (!e) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.id}@doorstep`,
      `DTSTAMP:${stamp(s.updatedAt)}`,
      `LAST-MODIFIED:${stamp(s.updatedAt)}`,
      `SEQUENCE:${Math.floor(new Date(s.updatedAt).getTime() / 1000)}`,
      `SUMMARY:${escapeIcs(e.summary)}`,
      `DESCRIPTION:${escapeIcs(e.description)}`,
      `URL:${appOrigin}/?shipment=${s.id}`,
      "TRANSP:TRANSPARENT",
      `STATUS:${s.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    );
    if (e.start.date)
      lines.push(
        `DTSTART;VALUE=DATE:${e.start.date.replaceAll("-", "")}`,
        `DTEND;VALUE=DATE:${e.end.date!.replaceAll("-", "")}`,
      );
    else
      lines.push(
        `DTSTART:${stamp(e.start.dateTime!)}`,
        `DTEND:${stamp(e.end.dateTime!)}`,
      );
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcs).join("\r\n") + "\r\n";
}
