import { test } from "node:test";
import assert from "node:assert/strict";
import { orderNumberKey } from "../lib/order-identity";

test("order identifiers tolerate labels, case, Unicode and separators", () => {
  for (const value of [
    "5174132",
    " #5174132 ",
    "Order #5174132",
    "Order No. 5174132",
    "Order number: 5174132",
    "Order ID: 5174132",
    "５１７４１３２",
  ])
    assert.equal(orderNumberKey(value), "5174132", value);
  for (const value of ["AB-001/23", "ab 001_23", "AB–001.23"])
    assert.equal(orderNumberKey(value), "ab00123", value);
});

test("order identifiers preserve meaningful differences and reject empty keys", () => {
  for (const value of ["5174133", "05174132", "T5174132", "5174312"])
    assert.notEqual(orderNumberKey(value), orderNumberKey("5174132"));
  assert.equal(orderNumberKey("ORDER100"), "order100");
  assert.notEqual(orderNumberKey("AB+123"), orderNumberKey("AB123"));
  for (const value of [null, "", " # ", "Order #", "---"])
    assert.equal(orderNumberKey(value), null);
});

test("letter prefixes require matching dates and items, never changed digits", async () => {
  const { corroboratedOrderPrefix } = await import("../lib/order-identity");
  const original = {
    number: "123456",
    date: "2026-09-22",
    items: [{ name: "Coffee capsules" }],
  };
  const prefixed = { ...original, number: "T123456" };
  assert.equal(corroboratedOrderPrefix(original, prefixed), true);
  assert.equal(corroboratedOrderPrefix(prefixed, original), true);
  for (const candidate of [
    { ...prefixed, date: null },
    { ...prefixed, date: "2026-09-21" },
    { ...prefixed, items: [] },
    { ...prefixed, items: [{ name: "Coffee mug" }] },
    { ...prefixed, number: "T123457" },
    { ...prefixed, number: "T0123456" },
  ])
    assert.equal(corroboratedOrderPrefix(original, candidate), false);
});
