import { test } from "node:test";
import assert from "node:assert/strict";
import { hasNoDeliveryEstimate, matchesPackageSearch } from "../lib/package-search";

const shipment = {
  merchant: "Schoolhouse",
  carrier: "FedEx",
  note: "For the guest room",
  orderNumber: "SH-20916",
  trackingNumber: "123456789",
  items: [
    { name: "Cotton woven throw", quantity: 2, imageUrl: null },
    { name: "Blue cushion", quantity: 1, imageUrl: null },
  ],
};

test("package search combines details in any order and ignores whitespace and case", () => {
  for (const search of [
    "schoolhouse FEDEX throw",
    "throw schoolhouse fedex",
    "  SH-20916\tguest\n123456789  ",
    "blue woven",
    "Schoolhouse\u00a0FedEx",
  ]) {
    assert.equal(matchesPackageSearch(shipment, search), true, search);
  }
});

test("package search requires every term and treats punctuation as literal text", () => {
  assert.equal(matchesPackageSearch(shipment, "FedEx blanket"), false);
  assert.equal(matchesPackageSearch(shipment, "guest room"), true);
  assert.equal(matchesPackageSearch(shipment, "SH-20916"), true);
  assert.equal(matchesPackageSearch(shipment, "SH.*"), false);
  assert.equal(matchesPackageSearch(shipment, "(throw)"), false);
});

test("empty and whitespace-only searches include packages with missing optional details", () => {
  const incomplete = {
    merchant: "Small shop",
    carrier: null,
    note: null,
    orderNumber: null,
    trackingNumber: null,
    items: [],
  };
  for (const search of ["", "  \t\n", "\u00a0"]) {
    assert.equal(matchesPackageSearch(incomplete, search), true);
  }
  assert.equal(matchesPackageSearch(incomplete, "small"), true);
  assert.equal(matchesPackageSearch(incomplete, "null"), false);
  assert.equal(matchesPackageSearch(incomplete, "FedEx"), false);
});

test("search uses package details without matching private links or unrelated metadata", () => {
  const withMetadata = {
    ...shipment,
    trackingUrl: "https://example.test/private-link",
    collectedByName: "SampleCollector",
    reviewReason: "HiddenReviewMarker",
  };
  for (const search of [
    "private-link",
    "SampleCollector",
    "HiddenReviewMarker",
  ]) {
    assert.equal(matchesPackageSearch(withMetadata, search), false);
  }
});


test("No estimate follows active visible shipments and responds to an estimate arriving", () => {
  const base = { status: "in_transit", estimate: null, archivedAt: null, dismissedAt: null, snoozedAt: null } as const;
  for (const status of ["ordered", "pre_transit", "in_transit", "out_for_delivery", "delayed", "available_for_pickup", "failure"] as const) {
    assert.equal(hasNoDeliveryEstimate({ ...base, status }), true);
  }
  for (const status of ["delivered", "cancelled", "unknown"] as const) assert.equal(hasNoDeliveryEstimate({ ...base, status }), false);
  for (const field of ["archivedAt", "dismissedAt", "snoozedAt"]) assert.equal(hasNoDeliveryEstimate({ ...base, [field]: "2026-10-26T00:00:00Z" }), false);
  assert.equal(hasNoDeliveryEstimate({ ...base, estimate: { kind: "date", start: "2026-10-28", end: "2026-10-28", timeZone: "America/New_York", label: null } }), false);
});
