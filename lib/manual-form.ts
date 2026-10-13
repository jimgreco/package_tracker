import type { Estimate } from "./types";
import { estimateLocal } from "./display";

export function timestampInput(
  value: string | null | undefined,
  precision: "date" | "minute",
) {
  if (!value) return "";
  if (precision === "date") return value.slice(0, 10);
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

export function timestampValue(
  input: string,
  original: string | null | undefined,
  precision: "date" | "minute",
) {
  if (!input) return null;
  // The form cannot display all the precision (or DST occurrence) in the source.
  if (original && input === timestampInput(original, precision))
    return original;
  return new Date(
    input + (precision === "date" ? "T12:00:00" : ""),
  ).toISOString();
}

export function preserveUnchangedEstimate(
  estimate: Estimate | null,
  original?: Estimate | null,
) {
  if (
    estimate &&
    original &&
    estimate.kind === original.kind &&
    estimate.timeZone === original.timeZone &&
    estimate.start.slice(0, 16) ===
      estimateLocal(original.start, original.timeZone).slice(0, 16) &&
    (estimate.end?.slice(0, 16) ?? null) ===
      (original.end
        ? estimateLocal(original.end, original.timeZone).slice(0, 16)
        : null)
  ) {
    return original;
  }
  return estimate;
}
