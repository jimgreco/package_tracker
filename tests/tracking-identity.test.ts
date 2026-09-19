import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderPageReference,
  retailerReference,
  trackingCarrier,
  trackingCodeFromLink,
} from "../lib/tracking-identity";

test("order-page identity ignores query secrets and rejects ambiguous order links", () => {
  const page =
    "https://shop.example.invalid/123/orders/0123456789abcdef0123456789abcdef/authenticate";
  assert.equal(
    orderPageReference([page + "?key=one", page + "?key=two&syclid=click"]),
    page,
  );
  assert.equal(
    orderPageReference([page, page.replace("/123/", "/456/")]),
    null,
  );
  assert.notEqual(
    orderPageReference([
      page.replace("shop.example.invalid", "another.example.invalid"),
    ]),
    page,
  );
  for (const invalid of [
    page.replace("https:", "http:"),
    page.replace("https://", "https://user:password@"),
    page.replace("/authenticate", "/account"),
    "https://shop.example.invalid/account/orders",
    "invalid URL",
  ])
    assert.equal(orderPageReference([invalid]), null);
});

test("CDL tracking codes require an exact source-backed package link", () => {
  const link =
    "https://apps.cdldelivers.com/Tracking-Page/track?id=CDLFIXTURE1";
  assert.equal(trackingCodeFromLink([link], link), "CDLFIXTURE1");
  assert.equal(trackingCodeFromLink([], link), null);
  assert.equal(trackingCodeFromLink([link], null), null);
  for (const invalid of [
    link.replace("apps.cdldelivers.com", "apps.cdldelivers.com.evil.invalid"),
    link.replace("https:", "http:"),
    link.replace("https://", "https://user:password@"),
    link.replace("/Tracking-Page/track", "/orders"),
    link.replace("CDLFIXTURE1", "ORDER1"),
    link + "&id=CDLFIXTURE2",
    "invalid URL",
  ])
    assert.equal(trackingCodeFromLink([invalid], invalid), null);
});

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
