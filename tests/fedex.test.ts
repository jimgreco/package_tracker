import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFedex, parseFedex, fedexStatus } from "../lib/fedex";
import { fedexFixture } from "./fixtures/fedex";
import { AppError } from "../lib/security";
const number = "123456789012";
const zone = "America/New_York";

test("FedEx statuses preserve terminal outcomes and distinguish delays, pickup, and exceptions", () => {
  for (const [code, expected] of Object.entries({
    DL: "delivered",
    CA: "cancelled",
    RS: "return_to_sender",
    OD: "out_for_delivery",
    OC: "pre_transit",
    HL: "available_for_pickup",
    DE: "failure",
    IT: "in_transit",
    PU: "in_transit",
    UNRECOGNIZED: "unknown",
  }))
    assert.equal(fedexStatus(code), expected);
  assert.equal(fedexStatus("IT", true), "delayed");
  assert.equal(fedexStatus("DL", true), "delivered");
});

test("FedEx parses scan offsets, actual delivery, and destination delivery windows", () => {
  const data = fedexFixture(number, "DL");
  data.output.completeTrackResults[0].trackResults[0].dateAndTimes.push({
    type: "ACTUAL_DELIVERY",
    dateTime: "2026-09-16T12:23:00-04:00",
  });
  const parsed = parseFedex(data, number, zone, "2026-09-16T18:00:00Z");
  assert.equal(parsed.tracker.status, "delivered");
  assert.equal(
    parsed.tracker.tracking_details[0].datetime,
    "2026-09-16T12:00:00Z",
  );
  assert.equal(
    parsed.tracker.tracking_details.at(-1)?.datetime,
    "2026-09-16T16:23:00Z",
  );
  assert.equal(parsed.estimate?.kind, "window");
  assert.equal(parsed.estimate?.timeZone, zone);
  assert.equal(parsed.reviewReason, null);
  assert.equal(parsed.tracker.id, parseFedex(data, number, zone).tracker.id);
});

test("FedEx date placeholders remain all-day; date ranges and ambiguous times are handled explicitly", () => {
  const data = fedexFixture();
  const row = data.output.completeTrackResults[0].trackResults[0];
  row.estimatedDeliveryTimeWindow.window = { begins: "", ends: "" };
  assert.deepEqual(parseFedex(data, number, zone).estimate, {
    kind: "date",
    start: "2026-09-16",
    end: null,
    timeZone: zone,
    label: "Estimated by FedEx",
  });
  row.estimatedDeliveryTimeWindow.window = {
    begins: "2026-09-16",
    ends: "2026-09-18",
  };
  assert.equal(parseFedex(data, number, zone).estimate?.kind, "date_range");
  assert.equal(parseFedex(data, number, zone).estimate?.end, "2026-09-18");
  row.estimatedDeliveryTimeWindow.window = {
    begins: "2026-11-01T01:30:00",
    ends: "2026-11-01T02:30:00",
  };
  assert.equal(parseFedex(data, number, zone).estimate, null);
  assert.match(parseFedex(data, number, zone).reviewReason!, /time zone/);
  row.scanEvents[0].date = "2026-09-16T08:00:00";
  assert.equal(
    parseFedex(data, number, zone).tracker.tracking_details.length,
    0,
  );
});

test("FedEx rejects mismatched, ambiguous, malformed, and restricted results", () => {
  assert.throws(
    () => parseFedex({}, number, zone),
    /invalid tracking response/,
  );
  assert.throws(
    () => parseFedex(fedexFixture("999999999999"), number, zone),
    /missing or ambiguous/,
  );
  const data = fedexFixture();
  const complete = data.output.completeTrackResults[0];
  complete.trackResults[0].trackingNumberInfo.trackingNumber = "999999999999";
  assert.throws(() => parseFedex(data, number, zone), /requested package/);
  complete.trackResults.push(complete.trackResults[0]);
  assert.throws(() => parseFedex(data, number, zone), /ambiguous/);
  const error = {
    output: {
      completeTrackResults: [
        {
          trackingNumber: number,
          trackResults: [
            {
              error: {
                code: "TRACKING.AUTHENTICATEDDELIVERY.ERROR",
                message: "private response must not escape",
              },
            },
          ],
        },
      ],
    },
  };
  assert.throws(
    () => parseFedex(error, number, zone),
    (e) =>
      e instanceof AppError &&
      e.status === 422 &&
      !e.message.includes("private"),
  );
  assert.match(
    parseFedex(fedexFixture(number, "NEW_CODE"), number, zone).reviewReason!,
    /unfamiliar/,
  );
});

test("FedEx OAuth is cached, concurrent requests share renewal, and a rejected token renews once", async () => {
  const originalFetch = globalThis.fetch;
  const env = {
    id: process.env.FEDEX_CLIENT_ID,
    secret: process.env.FEDEX_CLIENT_SECRET,
  };
  process.env.FEDEX_CLIENT_ID = "unit-client";
  process.env.FEDEX_CLIENT_SECRET = "unit-secret";
  let tokens = 0,
    tracks = 0,
    rejectOldToken = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    if (url === "https://apis.fedex.com/oauth/token") {
      tokens++;
      assert.equal(
        new URLSearchParams(init?.body as URLSearchParams).get("grant_type"),
        "client_credentials",
      );
      return Response.json({
        access_token: `token-${tokens}`,
        expires_in: 3600,
      });
    }
    assert.equal(url, "https://apis.fedex.com/track/v1/trackingnumbers");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }],
    });
    tracks++;
    if (
      rejectOldToken &&
      (init?.headers as Record<string, string>).Authorization ===
        "Bearer token-1"
    )
      return new Response(null, { status: 401 });
    return Response.json(fedexFixture());
  };
  try {
    await Promise.all([fetchFedex(number, zone), fetchFedex(number, zone)]);
    assert.equal(tokens, 1);
    assert.equal(tracks, 2);
    rejectOldToken = true;
    await fetchFedex(number, zone);
    assert.equal(tokens, 2);
    assert.equal(tracks, 4);
    globalThis.fetch = async () =>
      new Response("sensitive provider response", { status: 429 });
    await assert.rejects(fetchFedex(number, zone), /rate limit/);
    globalThis.fetch = async () => {
      throw new Error("sensitive transport response");
    };
    await assert.rejects(
      fetchFedex(number, zone),
      (e) => e instanceof AppError && !e.message.includes("sensitive"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (env.id === undefined) delete process.env.FEDEX_CLIENT_ID;
    else process.env.FEDEX_CLIENT_ID = env.id;
    if (env.secret === undefined) delete process.env.FEDEX_CLIENT_SECRET;
    else process.env.FEDEX_CLIENT_SECRET = env.secret;
  }
});
