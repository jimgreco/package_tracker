import type { Shipment, Estimate } from "./types";
export function todayInZone(zone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function dateLabel(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  return new Intl.DateTimeFormat("en-US", options).format(
    new Date(date.slice(0, 10) + "T12:00:00"),
  );
}
export function timeLabel(value: string, zone: string) {
  if (/Z|[+-]\d\d:\d\d$/.test(value))
    return new Date(value).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
    });
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}
export function estimateLabel(e: Estimate | null) {
  if (!e) return "Not yet available";
  if (e.kind === "date_range")
    return `${dateLabel(e.start)} – ${dateLabel(e.end!)}`;
  return dateLabel(estimateLocal(e.start, e.timeZone));
}
export function estimateTime(e: Estimate | null) {
  if (!e) return "";
  if (e.kind === "window")
    return `${timeLabel(e.start, e.timeZone)} – ${timeLabel(e.end!, e.timeZone)}`;
  if (e.kind === "point") return `Around ${timeLabel(e.start, e.timeZone)}`;
  if (e.kind === "deadline") return `By ${timeLabel(e.start, e.timeZone)}`;
  return "";
}
export function dayFor(s: Shipment, zone: string) {
  if (s.status === "delivered" && s.deliveredAt)
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
      new Date(s.deliveredAt),
    );
  return s.estimate
    ? estimateLocal(s.estimate.start, s.estimate.timeZone).slice(0, 10)
    : null;
}
export function daysFor(s: Shipment, zone: string) {
  const start = dayFor(s, zone);
  if (!start) return [];
  const end =
    s.status === "delivered"
      ? start
      : s.estimate?.kind === "date_range"
        ? s.estimate.end!
        : start;
  const days = [];
  let current = new Date(start + "T12:00:00Z");
  for (let i = 0; i < 62 && current.toISOString().slice(0, 10) <= end; i++) {
    days.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 86400000);
  }
  return days;
}
export function since(date: string | null) {
  if (!date) return "Not yet checked";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(date).getTime()) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}
export function estimateLocal(value: string, zone: string) {
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return value;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(value))
    .replace(" ", "T");
}
export function includesDay(s: Shipment, day: string, zone: string) {
  const start = dayFor(s, zone);
  if (!start) return false;
  const end =
    s.status !== "delivered" && s.estimate?.kind === "date_range"
      ? s.estimate.end!
      : start;
  return day >= start && day <= end;
}
