import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarFields,
  calendarFeed,
  normalizeEstimate,
  foldIcs,
} from "../lib/calendar";
import { demoShipments } from "../lib/demo";
import { carrierEstimate } from "../lib/tracking";
import { cleanEmail } from "../lib/email";
import { publicIp } from "../lib/storage";
import { safeUrl } from "../lib/security";
import type { Estimate } from "../lib/types";
const s = () => ({ ...demoShipments()[0], isDemo: false, deliveredAt: null });
const estimate = (
  kind: Estimate["kind"],
  start: string,
  end: string | null = null,
): Estimate => ({
  kind,
  start,
  end,
  timeZone: "America/New_York",
  label: null,
});
test("inclusive all-day range has an exclusive calendar end", () => {
  const event = calendarFields(
    { ...s(), estimate: estimate("date_range", "2026-09-18", "2026-09-20") },
    "https://doorstep.example",
    "America/New_York",
  );
  assert.deepEqual(event!.start, { date: "2026-09-18" });
  assert.deepEqual(event!.end, { date: "2026-09-21" });
  assert.equal(event!.transparency, "transparent");
});
test("date-only events keep their date across time zones", () => {
  const event = calendarFields(
    {
      ...s(),
      estimate: {
        ...estimate("date", "2026-09-18"),
        timeZone: "Pacific/Honolulu",
      },
    },
    "https://doorstep.example",
    "Pacific/Honolulu",
  );
  assert.deepEqual(event!.start, { date: "2026-09-18" });
  assert.deepEqual(event!.end, { date: "2026-09-19" });
});
test("delivery windows use destination timezone with DST", () => {
  const event = calendarFields(
    {
      ...s(),
      estimate: estimate(
        "window",
        "2026-09-18T14:00:00",
        "2026-09-18T18:00:00",
      ),
    },
    "https://doorstep.example",
    "America/New_York",
  );
  assert.equal(event!.start.dateTime, "2026-09-18T18:00:00Z");
  assert.equal(event!.end.dateTime, "2026-09-18T22:00:00Z");
});
test("reject ambiguous or nonexistent DST times and reversed windows", () => {
  assert.throws(() =>
    normalizeEstimate(
      estimate("window", "2026-03-08T02:30:00", "2026-03-08T04:00:00"),
    ),
  );
  assert.throws(() =>
    normalizeEstimate(estimate("point", "2026-11-01T01:30:00")),
  );
  assert.throws(() =>
    normalizeEstimate(
      estimate("window", "2026-09-18T18:00:00", "2026-09-18T14:00:00"),
    ),
  );
});
test("deadlines remain all day and point estimates use a disclosed marker", () => {
  const deadline = calendarFields(
    { ...s(), estimate: estimate("deadline", "2026-09-18T20:00:00") },
    "https://doorstep.example",
    "America/New_York",
  );
  assert.equal(deadline!.start.date, "2026-09-18");
  assert.match(deadline!.description, /deadline/);
  const point = calendarFields(
    { ...s(), estimate: estimate("point", "2026-09-18T16:00:00") },
    "https://doorstep.example",
    "America/New_York",
  );
  assert.equal(
    Date.parse(point!.end.dateTime!) - Date.parse(point!.start.dateTime!),
    60000,
  );
  assert.match(point!.description, /does not represent a delivery window/);
});
test("unknown estimates create no events; actual delivery uses household date", () => {
  assert.equal(
    calendarFields(
      { ...s(), estimate: null },
      "https://doorstep.example",
      "America/New_York",
    ),
    null,
  );
  const event = calendarFields(
    {
      ...s(),
      status: "delivered",
      deliveredAt: "2026-09-19T01:00:00Z",
      estimate: null,
    },
    "https://doorstep.example",
    "America/New_York",
  );
  assert.equal(event!.start.date, "2026-09-18");
});
test("ICS keeps UIDs stable, escapes untrusted text, and folds UTF-8 lines", () => {
  const one = {
    ...s(),
    merchant: "A, B; C\nInjected: bad",
    estimate: estimate("date", "2026-09-18"),
  };
  const original = calendarFeed(
    [one],
    "https://doorstep.example",
    "America/New_York",
  );
  const changed = calendarFeed(
    [{ ...one, estimate: estimate("date", "2026-09-19") }],
    "https://doorstep.example",
    "America/New_York",
  );
  assert.equal(original.match(/UID:.+/)?.[0], changed.match(/UID:.+/)?.[0]);
  assert.ok(original.includes("A\\, B\\; C\\nInjected"));
  assert.ok(!original.includes("\r\nInjected:"));
  for (const line of foldIcs("DESCRIPTION:" + "📦".repeat(60)).split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
  assert.match(original, /DTEND;VALUE=DATE:20260919/);
});
test("carrier date timestamps never become invented midnight windows", () => {
  assert.deepEqual(
    carrierEstimate(
      {
        id: "trk_test",
        tracking_code: "123",
        status: "in_transit",
        est_delivery_date: "2026-09-18T00:00:00Z",
        tracking_details: [],
      },
      "America/New_York",
    ),
    {
      kind: "date",
      start: "2026-09-18",
      end: null,
      timeZone: "America/New_York",
      label: "Estimated by the carrier",
    },
  );
});
test("email cleanup preserves real links and inline product references", () => {
  const e = cleanEmail(
    '<script>bad()</script><p>Ships today</p><a href="https://carrier.example/track?code=123">Track</a><img src="cid:product" alt="Blue bag"><img src="https://store.example/pixel" alt="tracking pixel" width="1">',
    "",
  );
  assert.ok(!e.text.includes("bad()"));
  assert.ok(e.text.includes("Ships today"));
  assert.equal(e.links[0], "https://carrier.example/track?code=123");
  assert.deepEqual(e.images, [{ url: "cid:product", alt: "Blue bag" }]);
});
test("image fetching blocks private networks and URL credentials", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.100.100.200",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(publicIp(ip), false);
  assert.equal(publicIp("93.184.216.34"), true);
  assert.equal(safeUrl("https://user:password@store.example/a"), null);
  assert.equal(safeUrl("javascript:alert(1)"), null);
});
