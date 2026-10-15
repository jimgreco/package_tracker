import { test } from "node:test";
import assert from "node:assert/strict";
import { packageSummary } from "../lib/display";
import type { Shipment } from "../lib/types";

test("package summary includes useful details, household delivery day and collection state", () => {
  const shipment = { merchant: "Coffee", status: "delivered", deliveredAt: "2026-10-15T01:00:00Z", items: [{ name: "Beans", quantity: 2 }], orderNumber: "ORDER1", carrier: "UPS", trackingNumber: "TRACK1", note: "Side door", collectedAt: null } as unknown as Shipment;
  assert.equal(packageSummary(shipment, "America/New_York"), "Coffee\nStatus: Delivered\nDelivery: Delivered Oct 14, 2026\n2 × Beans\nOrder: ORDER1\nCarrier: UPS\nTracking: TRACK1\nNot yet collected\nNote: Side door");
  assert.ok(packageSummary({ ...shipment, collectedAt: "2026-10-15T02:00:00Z" }, "America/New_York").includes("\nCollected\n"));
});

test("package summary retains estimate time zone and omits unavailable identifiers", () => {
  const shipment = { merchant: "Lamp", status: "in_transit", items: [], estimate: { kind: "window", start: "2026-10-16T09:00:00", end: "2026-10-16T12:00:00", timeZone: "America/Los_Angeles" } } as unknown as Shipment;
  const text = packageSummary(shipment, "America/New_York");
  assert.ok(text.includes("America/Los_Angeles"));
  assert.ok(text.includes("9:00 AM – 12:00 PM"));
  assert.ok(!/undefined|null|Order:|Tracking:|Collected/.test(text));
});
