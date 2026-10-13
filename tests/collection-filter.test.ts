import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitingCollection } from "../lib/display";
import type { Shipment } from "../lib/types";

test("To collect includes delivered packages until collection, excluding hidden packages", () => {
  const delivered = { status: "delivered", collectedAt: null } as Shipment;
  assert.equal(awaitingCollection(delivered), true);
  assert.equal(awaitingCollection({ ...delivered, collectedAt: "2026-10-13T12:00:00Z" }), false);
  assert.equal(awaitingCollection({ ...delivered, status: "in_transit" }), false);
  for (const field of ["archivedAt", "dismissedAt", "snoozedAt"] as const) {
    assert.equal(awaitingCollection({ ...delivered, [field]: "2026-10-13T12:00:00Z" }), false);
  }
  assert.equal(awaitingCollection({ ...delivered, collectedAt: null }), true);
});
