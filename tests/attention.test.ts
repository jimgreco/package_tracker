import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionReasons } from "../lib/attention";
import type { Shipment } from "../lib/types";
const base = {
  status: "in_transit",
  createdAt: "2026-09-20T12:00:00Z",
  trackingState: "none",
  needsReview: false,
} as Shipment;
test("date ranges include their entire final day in the destination zone", () => {
  const s = {
    ...base,
    estimate: {
      kind: "date_range",
      start: "2026-09-18",
      end: "2026-09-20",
      timeZone: "America/Los_Angeles",
      label: null,
    },
  } as Shipment;
  assert.deepEqual(attentionReasons(s, new Date("2026-09-21T06:59:59Z")), []);
  assert.match(
    attentionReasons(s, new Date("2026-09-21T07:00:00Z"))[0],
    /expected delivery/,
  );
});
test("timed windows use their end and DST offset; approximate points allow two hours", () => {
  const s = {
    ...base,
    estimate: {
      kind: "window",
      start: "2026-11-01T01:00:00-04:00",
      end: "2026-11-01T01:30:00-05:00",
      timeZone: "America/New_York",
      label: null,
    },
  } as Shipment;
  assert.deepEqual(attentionReasons(s, new Date("2026-11-01T06:29:00Z")), []);
  assert.equal(attentionReasons(s, new Date("2026-11-01T06:31:00Z")).length, 1);
  s.estimate = {
    ...s.estimate!,
    kind: "point",
    start: "2026-09-20T10:00:00",
    end: null,
  };
  assert.deepEqual(attentionReasons(s, new Date("2026-09-20T15:59:00Z")), []);
  assert.equal(attentionReasons(s, new Date("2026-09-20T16:01:00Z")).length, 1);
});
test("stalled orders, failed providers, and stale checks explain themselves", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  assert.match(
    attentionReasons({ ...base, status: "ordered" }, now)[0],
    /seven days/,
  );
  assert.deepEqual(
    attentionReasons(
      { ...base, status: "ordered", shippedAt: "2026-09-27T12:00:00Z" },
      now,
    ),
    [],
  );
  assert.match(
    attentionReasons(
      { ...base, trackingNumber: "123", trackingState: "error" },
      now,
    )[0],
    /could not be refreshed/,
  );
  const s = {
    ...base,
    status: "out_for_delivery",
    trackingNumber: "123",
    trackingState: "active",
    lastCheckedAt: "2026-09-28T11:00:00Z",
  } as Shipment;
  assert.match(attentionReasons(s, now)[0], /fresh check/);
  assert.deepEqual(
    attentionReasons({ ...s, lastCheckedAt: "2026-09-28T11:30:00Z" }, now),
    [],
  );
});
test("terminal, dismissed and collected packages do not remain in attention", () => {
  for (const extra of [
    { status: "delivered" },
    { status: "cancelled" },
    { dismissedAt: "2026-09-20" },
    { collectedAt: "2026-09-20" },
    { archivedAt: "2026-09-20" },
  ])
    assert.deepEqual(
      attentionReasons({ ...base, needsReview: true, ...extra } as Shipment),
      [],
    );
});
