import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preserveUnchangedEstimate,
  timestampInput,
  timestampValue,
} from "../lib/manual-form";
import type { Estimate } from "../lib/types";

test("an unchanged shipment date preserves its precise original instant", () => {
  const original = "2026-10-11T01:23:45.678Z";
  assert.equal(timestampInput(original, "date"), "2026-10-11");
  assert.equal(timestampValue("2026-10-11", original, "date"), original);
});

test("an unchanged delivery time preserves seconds and the original DST occurrence", () => {
  const oldZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const original = "2026-11-01T01:30:45.123-05:00";
    const input = timestampInput(original, "minute");
    assert.equal(input, "2026-11-01T01:30");
    assert.equal(timestampValue(input, original, "minute"), original);
    assert.equal(
      timestampValue("2026-11-02T12:15", original, "minute"),
      "2026-11-02T17:15:00.000Z",
    );
    assert.equal(
      timestampValue("2026-11-02", original, "date"),
      "2026-11-02T17:00:00.000Z",
    );
  } finally {
    if (oldZone === undefined) delete process.env.TZ;
    else process.env.TZ = oldZone;
  }
});

test("timestamps can still be added or cleared explicitly", () => {
  assert.equal(timestampInput(null, "minute"), "");
  assert.equal(timestampValue("", "2026-10-11T01:23:45Z", "date"), null);
  assert.equal(
    timestampValue("2026-10-11T01:23Z", null, "minute"),
    "2026-10-11T01:23:00.000Z",
  );
});

test("unchanged estimate fields preserve exact bounds and source label", () => {
  const original: Estimate = {
    kind: "window",
    start: "2026-10-11T13:15:43Z",
    end: "2026-10-11T15:30:12Z",
    timeZone: "America/New_York",
    label: "Carrier's precise window",
  };
  const edited: Estimate = {
    ...original,
    start: "2026-10-11T09:15:00",
    end: "2026-10-11T11:30:00",
    label: null,
  };
  assert.equal(preserveUnchangedEstimate(edited, original), original);
  const changed = { ...edited, end: "2026-10-11T11:45:00" };
  assert.equal(preserveUnchangedEstimate(changed, original), changed);
  assert.equal(preserveUnchangedEstimate(null, original), null);
});

test("changed estimate kind or zone is not mistaken for an unchanged estimate", () => {
  const original: Estimate = {
    kind: "date",
    start: "2026-10-11",
    end: null,
    timeZone: "America/New_York",
    label: "Tomorrow",
  };
  assert.equal(
    preserveUnchangedEstimate({ ...original, label: null }, original),
    original,
  );
  const changed = { ...original, timeZone: "America/Chicago" };
  assert.equal(preserveUnchangedEstimate(changed, original), changed);
  const range: Estimate = {
    ...original,
    kind: "date_range",
    end: "2026-10-12",
  };
  assert.equal(preserveUnchangedEstimate(range, original), range);
});
