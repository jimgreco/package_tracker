import { test } from "node:test";
import assert from "node:assert/strict";
import { retailerReference, trackingCarrier } from "../lib/tracking-identity";

test("FedEx service names resolve to the carrier API identifier", () => {
  for (const carrier of [
    "FedEx Ground",
    "fedex express",
    " FedEx Home Delivery ",
    "FedEx",
  ])
    assert.equal(trackingCarrier(carrier), "FedEx");
  assert.equal(trackingCarrier("UPS"), "UPS");
  assert.equal(trackingCarrier(null), null);
});

test("Amazon package references require an unambiguous source link", () => {
  const a =
    "https://www.amazon.com/progress-tracker/package?orderId=ORDER&shipmentId=PACKAGE1";
  const b = "https://amazon.com/progress-tracker/package?shipmentId=PACKAGE2";
  assert.equal(retailerReference([a, a]), "amazon:PACKAGE1");
  assert.equal(retailerReference([a, b]), null);
  assert.equal(retailerReference([a, b], b), "amazon:PACKAGE2");
  assert.equal(retailerReference([a], b), "amazon:PACKAGE1");
  assert.equal(
    retailerReference(["https://amazon.com.evil.invalid/?shipmentId=PACKAGE1"]),
    null,
  );
  assert.equal(
    retailerReference(["https://amazon.com/?orderId=ORDER", "bad url"]),
    null,
  );
});
