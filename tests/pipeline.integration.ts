import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asset } from "../lib/storage";
import pg from "pg";
import { pool, query, enqueue } from "../lib/db";
import { receiveEmail, applyExtraction, extractEmail } from "../lib/email";
import type { Extracted } from "../lib/validation";
import type { Context } from "../lib/auth";
import {
  saveManual,
  shipments,
  emails,
  shipment,
  quickShipmentAction,
} from "../lib/shipments";
import { calendarFields } from "../lib/calendar";
import {
  applyTracker,
  registerTracking,
  refreshTracking,
} from "../lib/tracking";
import { claimJob, runOne, schedule } from "../lib/jobs";
import { encrypt, randomToken } from "../lib/security";
import { syncShipment } from "../lib/google";
import { fedexFixture } from "./fixtures/fedex";
const originalUrl = process.env.DATABASE_URL!;
const dbUrl = new URL(originalUrl);
const testDb = `doorstep_test_${Date.now()}`;
const adminUrl = new URL(originalUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
const realFetch = globalThis.fetch;
let ctx: Context;
let uploadDir: string;
before(async () => {
  if (!["localhost", "127.0.0.1"].includes(dbUrl.hostname))
    throw new Error(
      "Integration tests require an isolated local PostgreSQL server.",
    );
  await admin.query(`CREATE DATABASE "${testDb}"`);
  dbUrl.pathname = "/" + testDb;
  process.env.DATABASE_URL = dbUrl.toString();
  process.env.OPENAI_API_KEY = "fixture-key";
  delete process.env.S3_BUCKET;
  uploadDir = await mkdtemp(join(tmpdir(), "doorstep-test-uploads-"));
  process.env.UPLOAD_DIR = uploadDir;
  delete process.env.EASYPOST_API_KEY;
  delete process.env.FEDEX_CLIENT_ID;
  delete process.env.FEDEX_CLIENT_SECRET;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.APP_URL = "http://127.0.0.1:4317";
  process.env.GOOGLE_CLIENT_ID = "fixture-google";
  process.env.GOOGLE_CLIENT_SECRET = "fixture-secret";
  for (const file of [
    "001_initial.sql",
    "002_archive.sql",
    "003_google_signin.sql",
    "004_google_only_households.sql",
    "005_calendar_household_state.sql",
    "006_gmail.sql",
    "007_dismissed.sql",
    "008_retailer_reference.sql",
    "009_native_sessions.sql",
    "010_delivery_features.sql",
    "011_native_calendar.sql",
    "012_snoozed.sql",
  ])
    await query(await readFile("db/" + file, "utf8"));
  const [h] = await query(
    "INSERT INTO households(name,forwarding_token,feed_token) VALUES($1,$2,$3) RETURNING *",
    ["Test household", randomToken(), randomToken()],
  );
  const [u] = await query(
    "INSERT INTO users(household_id,email,name,google_subject) VALUES($1,'test@example.invalid','Tester','fixture-tester') RETURNING id",
    [h.id],
  );
  await query(
    "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'owner')",
    [h.id, u.id],
  );
  ctx = {
    userId: u.id,
    householdId: h.id,
    name: "Tester",
    email: "test@example.invalid",
    householdName: h.name,
    timeZone: h.time_zone,
    forwardingToken: h.forwarding_token,
    feedToken: h.feed_token,
    demo: false,
  };
  globalThis.fetch = async () => {
    throw new Error("Unexpected external call in integration test.");
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await pool().end();
  await admin.query(`DROP DATABASE "${testDb}"`);
  await admin.end();
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  process.env.DATABASE_URL = originalUrl;
});
function extraction(
  track: string | null = "TRACK100",
  status = "in_transit",
  day = "2026-09-20",
  items = ["Trail shoes"],
): Extracted {
  return {
    relevant: true,
    reviewReason: null,
    orders: [
      {
        merchant: "Test Shop",
        orderNumber: "ORDER100",
        orderedAt: "2026-09-10",
        items: items.map((name) => ({ name, quantity: 1, imageUrl: null })),
        shipments: [
          {
            physicalDelivery: true,
            items: items.map((name) => ({ name, quantity: 1, imageUrl: null })),
            carrier: track ? "UPS" : null,
            trackingNumber: track,
            trackingUrl: null,
            status: status as "in_transit",
            shippedAt: track ? "2026-09-12T12:00:00Z" : null,
            statusAt: "2026-09-13T12:00:00Z",
            estimate: {
              kind: "date",
              start: day,
              end: null,
              timeZone: "America/New_York",
              label: null,
            },
            deliveredAt: null,
            evidence: "Your package is on the way.",
            needsReview: false,
            reviewReason: null,
          },
        ],
      },
    ],
  };
}
async function incoming(
  key: string,
  text = "Test Shop ORDER100 TRACK100 TRACK200 Trail shoes Blue jacket Your package is on the way.",
) {
  return receiveEmail(ctx.householdId, {
    messageId: key,
    from: "shop@example.invalid",
    subject: "Shipping update",
    text,
    html: "",
    sentAt: "2026-09-13T12:00:00Z",
  });
}
test("same inbound delivery is idempotent under concurrent retries", async () => {
  const [a, b] = await Promise.all([
    incoming("duplicate"),
    incoming("duplicate"),
  ]);
  assert.equal(a.id, b.id);
  assert.equal([a, b].filter((x) => x.duplicate).length, 1);
  assert.equal(
    (await query("SELECT * FROM jobs WHERE dedupe_key=$1", [`email:${a.id}`]))
      .length,
    1,
  );
});
test("order confirmation upgrades to shipment; split packages stay separate", async () => {
  const one = await incoming("order-confirmation");
  await applyExtraction(one.id, extraction(null, "ordered"));
  const [placeholder] = await shipments(ctx.householdId);
  const two = await incoming("first-shipment");
  await applyExtraction(two.id, extraction("TRACK100"));
  let all = await shipments(ctx.householdId);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, placeholder.id);
  assert.equal(all[0].trackingNumber, "TRACK100");
  const three = await incoming("split-shipment");
  await applyExtraction(
    three.id,
    extraction("TRACK200", "in_transit", "2026-09-21", ["Blue jacket"]),
  );
  all = await shipments(ctx.householdId);
  assert.equal(all.length, 2);
  assert.equal(new Set(all.map((x) => x.orderId)).size, 1);
  assert.deepEqual(
    new Set(all.map((x) => x.items[0].name)),
    new Set(["Trail shoes", "Blue jacket"]),
  );
  await applyExtraction(three.id, extraction("TRACK200", "in_transit"));
  assert.equal((await shipments(ctx.householdId)).length, 2);
});
test("AI cannot introduce a tracking number absent from the source", async () => {
  const email = await incoming("hallucination");
  const result = extraction("INVENTED999");
  result.orders[0].orderNumber = "DIFFERENT";
  await applyExtraction(email.id, result);
  const [r] = await query(
    "SELECT * FROM shipments WHERE review_reason LIKE '%not found in the source%'",
  );
  assert.equal(r.tracking_number, null);
  assert.equal(r.needs_review, true);
});
test("late carrier updates do not regress delivered status or overwrite manual dates", async () => {
  const s = (await shipments(ctx.householdId)).find(
    (s) => s.trackingNumber === "TRACK100",
  )!;
  await query(
    "UPDATE shipments SET tracker_id='trk_fixture',status='delivered',status_at='2026-09-20T18:00:00Z',delivered_at='2026-09-20T18:00:00Z' WHERE id=$1",
    [s.id],
  );
  await applyTracker(s.id, {
    id: "trk_fixture",
    tracking_code: "TRACK100",
    status: "in_transit",
    updated_at: "2026-09-19T12:00:00Z",
    tracking_details: [
      {
        status: "in_transit",
        datetime: "2026-09-19T12:00:00Z",
        message: "In transit",
      },
    ],
  });
  assert.equal(
    (await query("SELECT status FROM shipments WHERE id=$1", [s.id]))[0].status,
    "delivered",
  );
  await query(
    "UPDATE shipments SET status='in_transit',manual_override=true,estimate=$2 WHERE id=$1",
    [
      s.id,
      JSON.stringify({
        kind: "date",
        start: "2026-09-25",
        end: null,
        timeZone: "America/New_York",
        label: null,
      }),
    ],
  );
  await applyTracker(s.id, {
    id: "trk_fixture",
    tracking_code: "TRACK100",
    status: "out_for_delivery",
    updated_at: "2026-09-23T12:00:00Z",
    est_delivery_date: "2026-09-23T00:00:00Z",
    tracking_details: [],
  });
  const [locked] = await query(
    "SELECT status,estimate FROM shipments WHERE id=$1",
    [s.id],
  );
  assert.equal(locked.status, "in_transit");
  assert.equal(locked.estimate.start, "2026-09-25");
});
test("manual edits enforce household ownership and reject duplicate tracking", async () => {
  const s = (await shipments(ctx.householdId)).find(
    (s) => s.trackingNumber === "TRACK200",
  )!;
  const {
    merchant,
    orderNumber,
    orderedAt,
    items,
    carrier,
    trackingNumber,
    trackingUrl,
    status,
    shippedAt,
    estimate,
    deliveredAt,
  } = s;
  const payload = {
    merchant,
    orderNumber,
    orderedAt,
    items,
    carrier,
    trackingNumber,
    trackingUrl,
    status,
    shippedAt,
    estimate,
    deliveredAt,
  };
  await assert.rejects(
    saveManual(payload, { ...ctx, householdId: randomUUID() }, s.id),
    /not found/,
  );
  await assert.rejects(saveManual(payload, ctx), /already in your household/);
});
test("durable queue claims once and reclaims an expired lease", async () => {
  await query("UPDATE jobs SET status='done'");
  await enqueue("fixture", { householdId: ctx.householdId }, "claim-once");
  const claimed = await Promise.all([claimJob(), claimJob()]);
  assert.equal(claimed.filter(Boolean).length, 1);
  const first = claimed.find(Boolean)!;
  await query(
    "UPDATE jobs SET locked_at=now()-interval '6 minutes' WHERE id=$1",
    [first.id],
  );
  const second = await claimJob();
  assert.equal(second!.id, first.id);
  assert.notEqual(second!.lease_token, first.lease_token);
  await query("UPDATE jobs SET status='done'");
});
test("OpenAI structured extraction uses saved email and commits parsed output", async () => {
  const email = await incoming(
    "sdk-extraction",
    "Test Shop ORDER-SDK TRACKSDK Socks shipped September 13, 2026.",
  );
  const out = extraction("TRACKSDK");
  out.orders[0].orderNumber = "ORDER-SDK";
  let called = false;
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).includes("api.openai.com"));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    called = true;
    return Response.json({
      id: "resp_fixture",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-4.1-mini",
      output: [
        {
          id: "msg_fixture",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: JSON.stringify(out), annotations: [] },
          ],
        },
      ],
    });
  };
  await extractEmail(email.id);
  assert.equal(called, true);
  assert.equal(
    (await query("SELECT status FROM source_emails WHERE id=$1", [email.id]))[0]
      .status,
    "processed",
  );
  globalThis.fetch = async () => {
    throw new Error("Unexpected external call.");
  };
});
test("Google calendar updates reuse one event and remove an event with no estimate", async () => {
  const s = (await shipments(ctx.householdId)).find(
    (s) => s.trackingNumber === "TRACK200",
  )!;
  await query(
    "INSERT INTO google_connections(household_id,refresh_token,calendar_id,generation) VALUES($1,$2,$3,$4)",
    [
      ctx.householdId,
      encrypt("fixture-refresh"),
      "fixture-calendar",
      "fixture-generation",
    ],
  );
  const writes: {
    url: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  let exists = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token"))
      return Response.json({ access_token: "fixture-access" });
    const method = init?.method || "GET";
    writes.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (method === "PUT" && !exists) return Response.json({}, { status: 404 });
    if (method === "POST") {
      exists = true;
      return Response.json({ id: "created" });
    }
    if (method === "DELETE") {
      exists = false;
      return new Response(null, { status: 204 });
    }
    return Response.json({ id: "updated" });
  };
  await syncShipment(s.id);
  await query(
    "UPDATE shipments SET estimate=$2,version=version+1 WHERE id=$1",
    [
      s.id,
      JSON.stringify({
        kind: "date_range",
        start: "2026-09-22",
        end: "2026-09-24",
        timeZone: "America/New_York",
        label: null,
      }),
    ],
  );
  await syncShipment(s.id);
  assert.equal(writes.filter((w) => w.method === "POST").length, 1);
  const updated = writes.filter((w) => w.method === "PUT").at(-1)!;
  assert.equal((updated.body.end as { date: string }).date, "2026-09-25");
  assert.ok(updated.url.endsWith("ds" + s.id.replaceAll("-", "")));
  await query(
    "UPDATE shipments SET estimate=NULL,version=version+1 WHERE id=$1",
    [s.id],
  );
  await syncShipment(s.id);
  assert.equal(writes.filter((w) => w.method === "DELETE").length, 1);
  await syncShipment(s.id);
  assert.equal(writes.filter((w) => w.method === "DELETE").length, 1);
  // Reinstating a deleted event gets a new provider ID; normal ETA edits preserve it.
  await query(
    "UPDATE shipments SET estimate=$2,version=version+1 WHERE id=$1",
    [
      s.id,
      JSON.stringify({
        kind: "date",
        start: "2026-09-25",
        end: null,
        timeZone: "America/New_York",
        label: null,
      }),
    ],
  );
  await syncShipment(s.id);
  assert.equal(
    writes.filter((w) => w.method === "POST").at(-1)!.body.id,
    "ds" + s.id.replaceAll("-", "") + "a",
  );
  await quickShipmentAction(s.id, ctx, "dismiss");
  await syncShipment(s.id);
  assert.equal(writes.filter((w) => w.method === "DELETE").length, 2);
  await quickShipmentAction(s.id, ctx, "restore");
  await syncShipment(s.id);
  assert.equal(
    writes.filter((w) => w.method === "POST").at(-1)!.body.id,
    "ds" + s.id.replaceAll("-", "") + "aa",
  );
  globalThis.fetch = async () => {
    throw new Error("Unexpected external call.");
  };
});
test("failed jobs persist a retry rather than losing work", async () => {
  await query("UPDATE jobs SET status='done'");
  await enqueue(
    "unknown_type",
    { householdId: ctx.householdId },
    "retry-fixture",
  );
  await runOne();
  const [job] = await query(
    "SELECT status,attempts,error FROM jobs WHERE dedupe_key='retry-fixture'",
  );
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.match(job.error, /Unknown job/);
});
test("HTTP API enforces authentication, origin checks, and private calendar links", async () => {
  const { GET, POST } = await import("../app/api/[...path]/route");
  process.env.DEMO_MODE = "false";
  const params = (path: string) => ({
    params: Promise.resolve({ path: path.split("/") }),
  });
  const unauth = await GET(
    new Request("http://127.0.0.1:4317/api/dashboard"),
    params("dashboard"),
  );
  assert.equal(unauth.status, 401);
  const csrf = await POST(
    new Request("http://127.0.0.1:4317/api/shipments", {
      method: "POST",
      headers: {
        Origin: "https://unrelated.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    params("shipments"),
  );
  assert.equal(csrf.status, 403);
  const missingFeed = await GET(
    new Request("http://127.0.0.1:4317/api/calendar/missing.ics"),
    params("calendar/missing.ics"),
  );
  assert.equal(missingFeed.status, 404);
  const feed = await GET(
    new Request(`http://127.0.0.1:4317/api/calendar/${ctx.feedToken}.ics`),
    params(`calendar/${ctx.feedToken}.ics`),
  );
  assert.equal(feed.status, 200);
  assert.match(await feed.text(), /BEGIN:VCALENDAR/);
});
test("a Google account session protects household data and logout revokes it", async () => {
  const { GET, POST } = await import("../app/api/[...path]/route");
  const { sessionCookie } = await import("../lib/auth");
  const params = (path: string) => ({
    params: Promise.resolve({ path: path.split("/") }),
  });
  const request = (path: string, body: unknown, cookie = "") =>
    new Request(`http://127.0.0.1:4317/api/${path}`, {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:4317",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
  const cookie = await sessionCookie(ctx.userId);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const dashboard = await GET(
    new Request("http://127.0.0.1:4317/api/dashboard", {
      headers: { Cookie: cookie },
    }),
    params("dashboard"),
  );
  assert.equal(dashboard.status, 200);
  const foreign = await GET(
    new Request(`http://127.0.0.1:4317/api/shipments/${randomUUID()}`, {
      headers: { Cookie: cookie },
    }),
    params(`shipments/${randomUUID()}`),
  );
  assert.equal(foreign.status, 404);
  await POST(request("auth/logout", {}, cookie), params("auth/logout"));
  const revoked = await GET(
    new Request("http://127.0.0.1:4317/api/dashboard", {
      headers: { Cookie: cookie },
    }),
    params("dashboard"),
  );
  assert.equal(revoked.status, 401);
});
test("Postmark endpoint verifies its secret, routes a private alias and deduplicates", async () => {
  const { POST } = await import("../app/api/[...path]/route");
  process.env.POSTMARK_WEBHOOK_USER = "postmark";
  process.env.POSTMARK_WEBHOOK_PASSWORD = "fixture-password";
  process.env.INBOUND_DOMAIN = "inbound.example.invalid";
  const params = {
    params: Promise.resolve({ path: ["webhooks", "postmark"] }),
  };
  const payload = {
    MessageID: "http-postmark",
    From: "shop@example.invalid",
    Subject: "Package shipped",
    TextBody: "Your package TRACKHTTP has shipped.",
    OriginalRecipient: `packages+${ctx.forwardingToken}@inbound.example.invalid`,
  };
  function request(body: unknown, auth = true) {
    return new Request("http://127.0.0.1:4317/api/webhooks/postmark", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth
          ? {
              Authorization:
                "Basic " +
                Buffer.from("postmark:fixture-password").toString("base64"),
            }
          : {}),
      },
      body: JSON.stringify(body),
    });
  }
  assert.equal((await POST(request(payload, false), params)).status, 401);
  const before = await query(
    "SELECT (SELECT count(*)::int FROM source_emails) emails, (SELECT count(*)::int FROM jobs) jobs",
  );
  for (const recipient of [
    "packages+unknown@inbound.example.invalid",
    `packages+${"0".repeat(64)}@inbound.example.invalid`,
    `packages+${ctx.forwardingToken}@wrong.example.invalid`,
    "yourhash+SampleHash@inbound.postmarkapp.com",
  ]) {
    const response = await POST(
      request({ ...payload, OriginalRecipient: recipient }),
      params,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      received: true,
      ignored: true,
      reason: "unknown_recipient",
    });
  }
  // The envelope recipient wins over a valid-looking address in message headers.
  const spoofedHeaders = await POST(
    request({
      ...payload,
      OriginalRecipient: "unknown@inbound.example.invalid",
      ToFull: [{ Email: payload.OriginalRecipient }],
    }),
    params,
  );
  assert.equal((await spoofedHeaders.json()).ignored, true);
  assert.deepEqual(
    await query(
      "SELECT (SELECT count(*)::int FROM source_emails) emails, (SELECT count(*)::int FROM jobs) jobs",
    ),
    before,
  );
  const first = await POST(request(payload), params);
  const second = await POST(request(payload), params);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const a = await first.json();
  const b = await second.json();
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
});
test("inline email product images persist and remain household-private", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfbkAAAAASUVORK5CYII=",
    "base64",
  );
  const message = await receiveEmail(ctx.householdId, {
    messageId: "inline-image",
    from: "shop@example.invalid",
    subject: "Your socks shipped",
    text: "Test Shop ORDER-IMAGE TRACKIMAGE Socks shipped.",
    html: '<p>Socks shipped</p><img src="cid:product" alt="Socks">',
    attachments: [
      {
        Name: "socks.png",
        Content: png.toString("base64"),
        ContentType: "image/png",
        ContentID: "product",
      },
    ],
  });
  const [email] = await query("SELECT images FROM source_emails WHERE id=$1", [
    message.id,
  ]);
  const imageUrl = email.images[0].url;
  assert.match(imageUrl, /^\/api\/assets\//);
  const id = imageUrl.split("/").at(-1);
  assert.deepEqual((await asset(id, ctx.householdId)).bytes, png);
  await assert.rejects(asset(id, randomUUID()), /not found/);
  const out = extraction("TRACKIMAGE");
  out.orders[0].orderNumber = "ORDER-IMAGE";
  out.orders[0].shipments[0].items = [{ name: "Socks", quantity: 1, imageUrl }];
  await applyExtraction(message.id, out);
  const saved = (await shipments(ctx.householdId)).find(
    (s) => s.trackingNumber === "TRACKIMAGE",
  )!;
  assert.equal(saved.items[0].imageUrl, imageUrl);
});

test("package and inbox chronology use the original email date, with a stable manual fallback", async () => {
  const beforeIds = new Set(
    (await shipments(ctx.householdId)).map((s) => s.id),
  );
  const ids: string[] = [];
  for (const [key, date] of [
    ["newer", "2026-08-20T13:00:00Z"],
    ["older", "2026-08-01T13:00:00Z"],
  ]) {
    const e = await receiveEmail(ctx.householdId, {
      messageId: `chronology:${key}`,
      from: "shop@example.invalid",
      subject: key,
      text: "Your shoes order was placed.",
      html: "",
      sentAt: date,
    });
    ids.push(e.id);
    const out = extraction(null, "ordered");
    out.orders[0].orderNumber = `chronology:${key}`;
    await applyExtraction(e.id, out);
  }
  const created = (await shipments(ctx.householdId)).filter(
    (s) => !beforeIds.has(s.id),
  );
  assert.deepEqual(
    created.map((s) => s.orderNumber),
    ["chronology:newer", "chronology:older"],
  );
  assert.equal(created[0].timelineAt, "2026-08-20T13:00:00.000Z");
  await query(
    "UPDATE shipments SET shipped_at=now(),updated_at=now() WHERE id=$1",
    [created[1].id],
  );
  assert.deepEqual(
    (await shipments(ctx.householdId))
      .filter((s) => !beforeIds.has(s.id))
      .map((s) => s.id),
    created.map((s) => s.id),
  );
  const inbox = (await emails(ctx.householdId)).filter((e) =>
    ids.includes(e.id),
  );
  assert.deepEqual(
    inbox.map((e) => e.subject),
    ["newer", "older"],
  );
  assert.equal(inbox[1].sentAt, "2026-08-01T13:00:00.000Z");
  assert.notEqual(inbox[1].receivedAt, inbox[1].sentAt);
  // Manually created before the first linked email: retain the creation date.
  await query(
    "UPDATE shipments SET created_at='2026-07-01T12:00:00Z' WHERE id=$1",
    [created[0].id],
  );
  assert.equal(
    (await shipments(ctx.householdId)).find((s) => s.id === created[0].id)!
      .timelineAt,
    "2026-07-01T12:00:00.000Z",
  );
});

test("nonphysical receipts are ignored even if the model labels the overall email relevant", async () => {
  const before = (await shipments(ctx.householdId)).length;
  for (const name of [
    "iCloud+",
    "Google Health Premium",
    "Google Home Premium",
    "iTunes movie",
    "Movie e-ticket",
    "Schedule K-1 online package",
    "Flight booking",
  ]) {
    const e = await incoming(`nonphysical:${name}`, name);
    const out = extraction(null, "ordered", "2026-09-20", [name]);
    out.orders[0].orderNumber = `nonphysical:${name}`;
    out.orders[0].shipments[0].physicalDelivery = false;
    await applyExtraction(e.id, out);
    assert.equal(
      (await query("SELECT status FROM source_emails WHERE id=$1", [e.id]))[0]
        .status,
      "ignored",
    );
    assert.ok(!(await emails(ctx.householdId)).some((x) => x.id === e.id));
  }
  assert.equal((await shipments(ctx.householdId)).length, before);
  const e = await incoming(
    "mixed-physical",
    "Apple device will ship soon. iCloud subscription also renewed.",
  );
  const out = extraction(null, "ordered", "2026-09-20", ["Apple device"]);
  out.orders[0].orderNumber = "mixed-physical";
  const digital = structuredClone(out.orders[0]);
  digital.orderNumber = "mixed-digital";
  digital.shipments[0].physicalDelivery = false;
  out.orders.push(digital);
  await applyExtraction(e.id, out);
  assert.equal((await shipments(ctx.householdId)).length, before + 1);
  assert.ok(
    (await shipments(ctx.householdId)).some(
      (s) => s.orderNumber === "mixed-physical" && !s.trackingNumber,
    ),
  );
  assert.ok(
    !(await shipments(ctx.householdId)).some(
      (s) => s.orderNumber === "mixed-digital",
    ),
  );
});

test("Amazon retailer references match later emails without creating carrier tracking jobs", async () => {
  const link =
    "https://www.amazon.com/progress-tracker/package?shipmentId=AMZPACKAGE1";
  const first = await incoming(
    "amazon-reference:first",
    `A lamp is shipping. ${link}`,
  );
  const out = extraction("AMZPACKAGE1");
  out.orders[0].orderNumber = "amazon-reference";
  out.orders[0].shipments[0].carrier = null;
  out.orders[0].shipments[0].trackingUrl = link;
  await applyExtraction(first.id, out);
  const [row] = await query(
    "SELECT * FROM shipments WHERE household_id=$1 AND retailer_reference=$2",
    [ctx.householdId, "amazon:AMZPACKAGE1"],
  );
  assert.equal(row.tracking_number, null);
  assert.equal(row.tracking_state, "none");
  assert.equal(
    (
      await query(
        "SELECT id FROM jobs WHERE kind='track_register' AND payload->>'shipmentId'=$1",
        [row.id],
      )
    ).length,
    0,
  );

  const second = await incoming(
    "amazon-reference:second",
    `The lamp was delivered. ${link}`,
  );
  const delivered = extraction(null, "delivered");
  delivered.orders[0].orderNumber = null;
  delivered.orders[0].shipments[0].trackingUrl = link;
  await applyExtraction(second.id, delivered);
  const matched = await query(
    "SELECT * FROM shipments WHERE household_id=$1 AND retailer_reference=$2",
    [ctx.householdId, "amazon:AMZPACKAGE1"],
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, row.id);
  assert.equal(matched[0].status, "delivered");
  assert.equal(
    (
      await query("SELECT * FROM shipment_emails WHERE shipment_id=$1", [
        row.id,
      ])
    ).length,
    2,
  );
});

test("distinct Amazon package references stay separate and real carrier codes are retained", async () => {
  for (const id of ["AMZSPLIT1", "AMZSPLIT2"]) {
    const link = `https://www.amazon.com/progress-tracker/package?shipmentId=${id}`;
    const email = await incoming(
      `amazon-split:${id}`,
      `Physical items ordered. ${link}`,
    );
    const out = extraction(id, "ordered");
    out.orders[0].orderNumber = "amazon-split";
    out.orders[0].shipments[0].carrier = null;
    out.orders[0].shipments[0].trackingUrl = link;
    await applyExtraction(email.id, out);
  }
  const before = await query(
    "SELECT * FROM shipments WHERE household_id=$1 AND retailer_reference IN ('amazon:AMZSPLIT1','amazon:AMZSPLIT2')",
    [ctx.householdId],
  );
  assert.equal(before.length, 2);
  const link =
    "https://www.amazon.com/progress-tracker/package?shipmentId=AMZSPLIT1";
  const email = await incoming(
    "amazon-real-tracking",
    `Package shipped with UPS code AMZREALTRACK. ${link}`,
  );
  const out = extraction("AMZREALTRACK");
  out.orders[0].orderNumber = "amazon-split";
  out.orders[0].shipments[0].trackingUrl = link;
  await applyExtraction(email.id, out);
  const after = await query(
    "SELECT * FROM shipments WHERE household_id=$1 AND retailer_reference IN ('amazon:AMZSPLIT1','amazon:AMZSPLIT2')",
    [ctx.householdId],
  );
  assert.equal(after.length, 2);
  assert.equal(
    after.find((s) => s.retailer_reference === "amazon:AMZSPLIT1")!
      .tracking_number,
    "AMZREALTRACK",
  );
  assert.equal(
    after.find((s) => s.retailer_reference === "amazon:AMZSPLIT2")!
      .tracking_number,
    null,
  );
});

test("legacy FedEx Ground shipments register using the FedEx carrier identifier", async () => {
  const email = await incoming(
    "fedex-service",
    "FedEx Ground package FEDEXTRACK is on the way.",
  );
  const out = extraction("FEDEXTRACK");
  out.orders[0].orderNumber = "fedex-service";
  out.orders[0].shipments[0].carrier = "FedEx Ground";
  await applyExtraction(email.id, out);
  const [row] = await query(
    "SELECT * FROM shipments WHERE household_id=$1 AND tracking_number='FEDEXTRACK'",
    [ctx.householdId],
  );
  assert.equal(row.carrier, "FedEx");
  // Existing records can still contain service names; registration must handle them too.
  await query("UPDATE shipments SET carrier='FedEx Ground' WHERE id=$1", [
    row.id,
  ]);
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.EASYPOST_API_KEY;
  let calls = 0;
  process.env.EASYPOST_API_KEY = "fixture-easypost";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.easypost.com/v2/trackers");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      tracker: { tracking_code: "FEDEXTRACK", carrier: "FedEx" },
    });
    calls++;
    return Response.json({
      id: "trk_fixture_fedex",
      tracking_code: "FEDEXTRACK",
      carrier: "FedEx",
      status: "in_transit",
      updated_at: "2026-09-14T12:00:00Z",
      tracking_details: [],
    });
  };
  try {
    await registerTracking(row.id);
    assert.equal(calls, 1);
    const [saved] = await query("SELECT * FROM shipments WHERE id=$1", [
      row.id,
    ]);
    assert.equal(saved.tracker_id, "trk_fixture_fedex");
    assert.equal(saved.tracking_state, "active");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.EASYPOST_API_KEY;
    else process.env.EASYPOST_API_KEY = previousKey;
  }
});

test("quick actions are household scoped, idempotent, reversible and protect confirmed delivery", async () => {
  const e = await incoming("quick-actions");
  const out = extraction("TRACK200");
  out.orders[0].orderNumber = "quick-actions";
  // Use an isolated shipment with a source-backed unique tracking number.
  await query(
    "UPDATE source_emails SET body_text=body_text||' TRACKQUICK' WHERE id=$1",
    [e.id],
  );
  out.orders[0].shipments[0].trackingNumber = "TRACKQUICK";
  await applyExtraction(e.id, out);
  const s = (await shipments(ctx.householdId)).find(
    (s) => s.trackingNumber === "TRACKQUICK",
  )!;
  await assert.rejects(
    quickShipmentAction(s.id, { ...ctx, householdId: randomUUID() }, "dismiss"),
    /not found/,
  );
  await Promise.all([
    quickShipmentAction(s.id, ctx, "dismiss"),
    quickShipmentAction(s.id, ctx, "dismiss"),
  ]);
  assert.ok(!(await shipments(ctx.householdId)).some((x) => x.id === s.id));
  const dismissed = (await shipments(ctx.householdId, false, true)).find(
    (x) => x.id === s.id,
  )!;
  assert.ok(dismissed.dismissedAt);
  assert.equal(dismissed.status, s.status);
  assert.equal(
    calendarFields(dismissed, "https://example.invalid", ctx.timeZone),
    null,
  );
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM tracking_events WHERE shipment_id=$1 AND event_key LIKE 'manual:dismiss:%'",
        [s.id],
      )
    )[0].n,
    1,
  );
  await query("UPDATE shipments SET tracker_id='trk_quick' WHERE id=$1", [
    s.id,
  ]);
  await applyTracker(s.id, {
    id: "trk_quick",
    tracking_code: "TRACKQUICK",
    status: "delivered",
    updated_at: "2026-10-01T12:00:00Z",
    tracking_details: [],
  });
  assert.equal((await shipment(s.id)).shipment.status, s.status);
  const later = await incoming(
    "quick-later",
    "TRACKQUICK Your package is on the way.",
  );
  const update = extraction("TRACKQUICK");
  update.orders[0].orderNumber = "quick-actions";
  await applyExtraction(later.id, update);
  assert.ok(!(await shipments(ctx.householdId)).some((x) => x.id === s.id));
  await quickShipmentAction(s.id, ctx, "restore");
  assert.ok((await shipments(ctx.householdId)).some((x) => x.id === s.id));
  await Promise.all([
    quickShipmentAction(s.id, ctx, "deliver"),
    quickShipmentAction(s.id, ctx, "deliver"),
  ]);
  await applyTracker(s.id, {
    id: "trk_quick",
    tracking_code: "TRACKQUICK",
    status: "in_transit",
    updated_at: "2027-01-01T12:00:00Z",
    tracking_details: [],
  });
  const confirmed = (await shipment(s.id)).shipment;
  assert.equal(confirmed.status, "delivered");
  assert.equal(confirmed.manualOverride, true);
  assert.equal(confirmed.deliveredAt, null);
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM tracking_events WHERE shipment_id=$1 AND event_key LIKE 'manual:deliver:%'",
        [s.id],
      )
    )[0].n,
    1,
  );
});

test("snoozed packages wake on a new carrier event or source email, not an unchanged poll", async () => {
  const first = await incoming(
    "snooze-first",
    "Test Shop SNOOZEORDER TRACKSNOOZE Trail shoes Your package is on the way.",
  );
  const initial = extraction("TRACKSNOOZE");
  initial.orders[0].orderNumber = "SNOOZEORDER";
  await applyExtraction(first.id, initial);
  const s = (await shipments(ctx.householdId)).find(
    (row) => row.trackingNumber === "TRACKSNOOZE",
  )!;
  await assert.rejects(
    quickShipmentAction(s.id, { ...ctx, householdId: randomUUID() }, "snooze"),
    /not found/,
  );
  await quickShipmentAction(s.id, ctx, "snooze");
  await quickShipmentAction(s.id, ctx, "snooze");
  assert.ok((await shipment(s.id)).shipment.snoozedAt);
  await query("UPDATE shipments SET tracker_id='trk_snooze' WHERE id=$1", [s.id]);
  const tracker = {
    id: "trk_snooze",
    tracking_code: "TRACKSNOOZE",
    status: "in_transit" as const,
    updated_at: "2026-09-21T12:00:00Z",
    tracking_details: [],
  };
  await applyTracker(s.id, tracker);
  assert.ok((await shipment(s.id)).shipment.snoozedAt);
  const update = {
    ...tracker,
    tracking_details: [{
      datetime: "2026-09-21T12:00:00Z",
      status: "in_transit",
      message: "Package processed at carrier facility.",
    }],
  };
  await applyTracker(s.id, update);
  assert.equal((await shipment(s.id)).shipment.snoozedAt, null);
  await quickShipmentAction(s.id, ctx, "snooze");
  await applyTracker(s.id, update);
  assert.ok((await shipment(s.id)).shipment.snoozedAt);
  await applyTracker(s.id, {
    ...tracker,
    status: "delayed",
    updated_at: "2026-09-22T12:00:00Z",
  });
  assert.equal((await shipment(s.id)).shipment.snoozedAt, null);
  await quickShipmentAction(s.id, ctx, "snooze");
  await query(
    "UPDATE shipments SET created_at=now()-interval '180 days' WHERE id=$1",
    [s.id],
  );
  const later = await incoming(
    "snooze-later",
    "Test Shop SNOOZEORDER TRACKSNOOZE Trail shoes Your package is on the way.",
  );
  await applyExtraction(later.id, initial);
  assert.equal((await shipment(s.id)).shipment.snoozedAt, null);
  assert.equal(
    (await query("SELECT count(*)::int n FROM shipments WHERE tracking_number='TRACKSNOOZE'"))[0].n,
    1,
  );
  await quickShipmentAction(s.id, ctx, "snooze");
  await quickShipmentAction(s.id, ctx, "unsnooze");
  assert.equal((await shipment(s.id)).shipment.snoozedAt, null);
});

async function directFedexShipment(key: string) {
  const email = await incoming(key, `FedEx package ${key} is on the way.`);
  const out = extraction(key);
  out.orders[0].orderNumber = key;
  out.orders[0].shipments[0].carrier = "FedEx";
  await applyExtraction(email.id, out);
  return (
    await query(
      "SELECT * FROM shipments WHERE household_id=$1 AND tracking_number=$2",
      [ctx.householdId, key],
    )
  )[0];
}

async function withFedex(run: () => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.EASYPOST_API_KEY;
  process.env.FEDEX_CLIENT_ID = randomUUID();
  process.env.FEDEX_CLIENT_SECRET = "fixture-secret";
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.FEDEX_CLIENT_ID;
    delete process.env.FEDEX_CLIENT_SECRET;
    if (previousKey === undefined) delete process.env.EASYPOST_API_KEY;
    else process.env.EASYPOST_API_KEY = previousKey;
  }
}

test("direct FedEx takes priority over EasyPost, deduplicates scans, syncs windows, and protects delivery", async () =>
  withFedex(async () => {
    process.env.EASYPOST_API_KEY = "fixture-easypost";
    const row = await directFedexShipment("DIRECTFEDEX1");
    assert.equal(row.tracking_state, "pending");
    let code = "OD";
    let auth = 0;
    globalThis.fetch = async (url, init) => {
      if (url === "https://apis.fedex.com/oauth/token") {
        auth++;
        return Response.json({
          access_token: "fixture-token",
          expires_in: 3600,
        });
      }
      assert.equal(url, "https://apis.fedex.com/track/v1/trackingnumbers");
      assert.equal(
        JSON.parse(String(init?.body)).trackingInfo[0].trackingNumberInfo
          .trackingNumber,
        row.tracking_number,
      );
      return Response.json(fedexFixture(row.tracking_number, code));
    };
    await registerTracking(row.id);
    let saved = await shipment(row.id);
    assert.match(saved.row.tracker_id, /^fedex:/);
    assert.equal(saved.shipment.status, "out_for_delivery");
    assert.equal(saved.shipment.estimate?.kind, "window");
    assert.equal(
      calendarFields(saved.shipment, "https://example.invalid", ctx.timeZone)
        ?.end.dateTime,
      "2026-09-16T18:00:00Z",
    );
    const version = saved.row.version;
    await refreshTracking(row.id);
    saved = await shipment(row.id);
    assert.equal(saved.row.version, version);
    assert.equal(auth, 1);
    assert.equal(
      (
        await query(
          "SELECT count(*)::int n FROM tracking_events WHERE shipment_id=$1 AND source='FedEx'",
          [row.id],
        )
      )[0].n,
      1,
    );
    assert.equal(
      (
        await query("SELECT count(*)::int n FROM jobs WHERE dedupe_key=$1", [
          `calendar:${row.id}:${version}`,
        ])
      )[0].n,
      1,
    );
    code = "UNFAMILIAR";
    await refreshTracking(row.id);
    assert.equal((await shipment(row.id)).shipment.status, "out_for_delivery");
    assert.equal((await shipment(row.id)).shipment.needsReview, true);
    code = "DL";
    await refreshTracking(row.id);
    assert.equal((await shipment(row.id)).shipment.status, "delivered");
    code = "IT";
    await refreshTracking(row.id);
    assert.equal((await shipment(row.id)).shipment.status, "delivered");
    await quickShipmentAction(row.id, ctx, "deliver");
    const before = (await shipment(row.id)).shipment;
    await refreshTracking(row.id);
    const after = (await shipment(row.id)).shipment;
    assert.equal(after.status, "delivered");
    assert.deepEqual(after.estimate, before.estimate);
  }));

test("direct FedEx ignores results for edited or dismissed packages and sanitizes errors", async () =>
  withFedex(async () => {
    const row = await directFedexShipment("DIRECTFEDEX2");
    let mode = "edit";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/oauth/token"))
        return Response.json({
          access_token: "fixture-token",
          expires_in: 3600,
        });
      if (mode === "edit")
        await query(
          "UPDATE shipments SET tracking_number='EDITEDFEDEX2',tracker_id=NULL WHERE id=$1",
          [row.id],
        );
      if (mode === "dismiss") await quickShipmentAction(row.id, ctx, "dismiss");
      if (mode === "error")
        return new Response("private account detail", { status: 503 });
      if (mode === "restricted")
        return Response.json({
          output: {
            completeTrackResults: [
              {
                trackingNumber: row.tracking_number,
                trackResults: [
                  { error: { code: "TRACKING.AUTHENTICATEDDELIVERY.ERROR" } },
                ],
              },
            ],
          },
        });
      return Response.json(fedexFixture(row.tracking_number));
    };
    await registerTracking(row.id);
    assert.equal((await shipment(row.id)).row.tracker_id, null);
    assert.equal((await shipment(row.id)).shipment.status, "in_transit");
    await query("UPDATE shipments SET tracking_number=$2 WHERE id=$1", [
      row.id,
      row.tracking_number,
    ]);
    mode = "dismiss";
    await registerTracking(row.id);
    assert.equal((await shipment(row.id)).row.tracker_id, null);
    await quickShipmentAction(row.id, ctx, "restore");
    mode = "error";
    await assert.rejects(
      registerTracking(row.id),
      /FedEx tracking request failed/,
    );
    assert.equal((await shipment(row.id)).shipment.trackingState, "error");
    assert.doesNotMatch((await shipment(row.id)).row.tracking_error, /private/);
    mode = "restricted";
    await registerTracking(row.id);
    assert.equal(
      (await shipment(row.id)).shipment.trackingState,
      "unsupported",
    );
    assert.equal((await shipment(row.id)).shipment.status, "in_transit");
  }));

test("FedEx-only scheduling includes due packages and skips unsupported, terminal, and dismissed ones", async () =>
  withFedex(async () => {
    delete process.env.EASYPOST_API_KEY;
    const due = await directFedexShipment("DIRECTFEDEXSCHEDULE");
    const delivered = await directFedexShipment("DIRECTFEDEXDELIVERED");
    const dismissed = await directFedexShipment("DIRECTFEDEXDISMISSED");
    const checked = await directFedexShipment("DIRECTFEDEXCHECKED");
    await query("UPDATE shipments SET status='delivered' WHERE id=$1", [
      delivered.id,
    ]);
    await quickShipmentAction(dismissed.id, ctx, "dismiss");
    await query("UPDATE shipments SET last_checked_at=now() WHERE id=$1", [
      checked.id,
    ]);
    await schedule();
    await schedule();
    const jobs = await query(
      "SELECT j.payload->>'shipmentId' AS id, s.carrier FROM jobs j JOIN shipments s ON s.id::text=j.payload->>'shipmentId' WHERE dedupe_key LIKE 'scheduled:%'",
    );
    assert.equal(jobs.filter((j) => j.id === due.id).length, 1);
    assert.ok(jobs.every((j) => j.carrier.startsWith("FedEx")));
    for (const row of [delivered, dismissed, checked])
      assert.ok(!jobs.some((j) => j.id === row.id));
  }));

test("CDL link-only updates and later tracking numbers stay one package, while split packages remain distinct", async () => {
  const link =
    "https://apps.cdldelivers.com/Tracking-Page/track?id=CDLFIXTURE1";
  const first = await incoming(
    "cdl-link:first",
    `Your coffee is out for delivery. ${link}`,
  );
  const initial = extraction(null, "out_for_delivery", "2026-09-20", [
    "Coffee",
  ]);
  initial.orders[0].orderNumber = "cdl-link-order";
  initial.orders[0].shipments[0].trackingUrl = link;
  await applyExtraction(first.id, initial);
  const [before] = await query(
    "SELECT * FROM shipments WHERE household_id=$1 AND tracking_number='CDLFIXTURE1'",
    [ctx.householdId],
  );
  assert.ok(before);
  assert.equal(before.status, "out_for_delivery");

  const second = await incoming(
    "cdl-link:delivered",
    `Your coffee capsules have been delivered. ${link}`,
  );
  const delivered = extraction("CDLFIXTURE1", "delivered", "2026-09-20", [
    "Coffee capsules",
  ]);
  delivered.orders[0].orderNumber = "cdl-link-order";
  delivered.orders[0].shipments[0].carrier = null;
  delivered.orders[0].shipments[0].trackingUrl = link;
  delivered.orders[0].shipments[0].statusAt = "2026-09-13T18:00:00Z";
  delivered.orders[0].shipments[0].deliveredAt = "2026-09-13T18:00:00Z";
  await applyExtraction(second.id, delivered);
  await applyExtraction(second.id, delivered);
  const saved = await query("SELECT * FROM shipments WHERE order_id=$1", [
    before.order_id,
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, before.id);
  assert.equal(saved[0].status, "delivered");
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM shipment_emails WHERE shipment_id=$1",
        [before.id],
      )
    )[0].n,
    2,
  );
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM tracking_events WHERE shipment_id=$1 AND event_key LIKE 'email:%'",
        [before.id],
      )
    )[0].n,
    2,
  );

  const splitLink = link.replace("CDLFIXTURE1", "CDLFIXTURE2");
  const splitEmail = await incoming(
    "cdl-link:split",
    `A second package is on the way. ${splitLink}`,
  );
  const split = extraction(null, "in_transit");
  split.orders[0].orderNumber = "cdl-link-order";
  split.orders[0].shipments[0].trackingUrl = splitLink;
  await applyExtraction(splitEmail.id, split);
  const all = await query(
    "SELECT tracking_number,status FROM shipments WHERE order_id=$1 ORDER BY tracking_number",
    [before.order_id],
  );
  assert.deepEqual(all, [
    { tracking_number: "CDLFIXTURE1", status: "delivered" },
    { tracking_number: "CDLFIXTURE2", status: "in_transit" },
  ]);
});

const orderPageFixture =
  "https://coffee.example.invalid/123/orders/0123456789abcdef0123456789abcdef/authenticate";
async function orderPageEmail(
  key: string,
  number: string,
  status: string,
  page: string,
  code: string | null = null,
  householdId = ctx.householdId,
) {
  const link = code
    ? `https://apps.cdldelivers.com/Tracking-Page/track?id=${code}`
    : null;
  const email = await receiveEmail(householdId, {
    messageId: key,
    from: "coffee@example.invalid",
    subject: "Coffee order update",
    text: `Order ${number}: ${status}. ${page ? page + "?key=" + key : ""} ${link || ""}`,
    html: "",
    sentAt: "2026-09-13T12:00:00Z",
  });
  const parsed = extraction(null, status, "2026-09-20", ["Coffee"]);
  parsed.orders[0].merchant = "Coffee fixture";
  parsed.orders[0].orderNumber = number;
  parsed.orders[0].shipments[0].trackingUrl = link;
  if (status === "delivered")
    parsed.orders[0].shipments[0].deliveredAt = "2026-09-13T12:00:00Z";
  await applyExtraction(email.id, parsed);
  return { email, parsed };
}

test("shared order pages reconcile changed order numbers and untracked shipping notices without merging split packages", async () => {
  await orderPageEmail("page:confirmed", "700100", "ordered", orderPageFixture);
  const [original] = await query(
    "SELECT s.* FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.order_number='700100'",
    [ctx.householdId],
  );
  await orderPageEmail("page:shipped", "700100", "in_transit", "");
  await orderPageEmail(
    "page:today",
    "T700100",
    "out_for_delivery",
    orderPageFixture,
    "CDLPAGE1",
  );
  const delivered = await orderPageEmail(
    "page:delivered",
    "T700100",
    "delivered",
    orderPageFixture,
    "CDLPAGE1",
  );
  await applyExtraction(delivered.email.id, delivered.parsed);
  const rows = await query(
    "SELECT s.id,s.status,s.tracking_number,o.order_number FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.order_number=ANY($2::text[])",
    [ctx.householdId, ["700100", "T700100"]],
  );
  assert.deepEqual(rows, [
    {
      id: original.id,
      status: "delivered",
      tracking_number: "CDLPAGE1",
      order_number: "700100",
    },
  ]);
  const [history] = await query(
    "SELECT count(DISTINCT se.email_id)::int emails,count(DISTINCT te.id)::int events FROM shipment_emails se JOIN tracking_events te ON te.shipment_id=se.shipment_id WHERE se.shipment_id=$1",
    [original.id],
  );
  assert.deepEqual(history, { emails: 4, events: 4 });

  await orderPageEmail(
    "page:split",
    "T700100",
    "in_transit",
    orderPageFixture,
    "CDLPAGE2",
  );
  assert.deepEqual(
    await query(
      "SELECT tracking_number,status FROM shipments WHERE order_id=$1 ORDER BY tracking_number",
      [original.order_id],
    ),
    [
      { tracking_number: "CDLPAGE1", status: "delivered" },
      { tracking_number: "CDLPAGE2", status: "in_transit" },
    ],
  );
});

test("order-page matching requires the same household and exact page, and does not guess among shipments", async () => {
  const page = orderPageFixture.replace("/123/", "/456/");
  await orderPageEmail("page:distinct", "700200", "in_transit", page);
  await orderPageEmail(
    "page:different-url",
    "T700200",
    "out_for_delivery",
    page.replace("/456/", "/789/"),
    "CDLPAGE3",
  );
  const distinct = await query(
    "SELECT s.order_id,s.status FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.order_number=ANY($2::text[])",
    [ctx.householdId, ["700200", "T700200"]],
  );
  assert.equal(new Set(distinct.map((s) => s.order_id)).size, 2);
  assert.ok(distinct.some((s) => s.status === "in_transit"));

  const [other] = await query(
    "INSERT INTO households(name,forwarding_token,feed_token) VALUES('Order page isolation',$1,$2) RETURNING id",
    [randomToken(), randomToken()],
  );
  await orderPageEmail(
    "page:other-household",
    "T700200",
    "out_for_delivery",
    page,
    "CDLPAGE4",
    other.id,
  );
  const [isolated] = await query(
    "SELECT status FROM shipments WHERE household_id=$1",
    [other.id],
  );
  assert.equal(isolated.status, "out_for_delivery");
  assert.equal(
    (
      await query("SELECT status FROM shipments WHERE order_id=$1", [
        distinct.find((s) => s.status === "in_transit")!.order_id,
      ])
    )[0].status,
    "in_transit",
  );

  const ambiguousPage = orderPageFixture.replace("/123/", "/999/");
  await orderPageEmail(
    "page:ambiguous-first",
    "700300",
    "in_transit",
    ambiguousPage,
  );
  await orderPageEmail(
    "page:ambiguous-second",
    "700300",
    "in_transit",
    ambiguousPage,
  );
  await orderPageEmail(
    "page:ambiguous-tracked",
    "T700300",
    "out_for_delivery",
    ambiguousPage,
    "CDLPAGE5",
  );
  const ambiguous = await query(
    "SELECT s.status,s.tracking_number FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.order_number='700300'",
    [ctx.householdId],
  );
  assert.equal(
    ambiguous.filter(
      (s) => s.tracking_number === null && s.status === "in_transit",
    ).length,
    2,
  );
  assert.equal(
    ambiguous.filter((s) => s.tracking_number === "CDLPAGE5").length,
    1,
  );
});

test("collection is household-scoped, idempotent, reversible, and independent of delivery", async () => {
  const id = await saveManual(
    {
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
      merchant: "Collection fixture",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "delivered",
    },
    ctx,
  );
  await assert.rejects(
    quickShipmentAction(id, { ...ctx, householdId: randomUUID() }, "collect"),
    /not found/,
  );
  await Promise.all([
    quickShipmentAction(id, ctx, "collect"),
    quickShipmentAction(id, ctx, "collect"),
  ]);
  const first = (await shipment(id, ctx.householdId)).shipment;
  assert.ok(first.collectedAt);
  assert.equal(first.collectedByName, "Tester");
  assert.equal(first.status, "delivered");
  assert.equal(first.deliveredAt, null);
  assert.equal(
    (
      await query(
        "SELECT * FROM tracking_events WHERE shipment_id=$1 AND event_key LIKE 'collection:%'",
        [id],
      )
    ).length,
    1,
  );
  await quickShipmentAction(id, ctx, "uncollect");
  assert.equal(
    (await shipment(id, ctx.householdId)).shipment.collectedAt,
    null,
  );
  await saveManual(
    {
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
      merchant: "Collection fixture",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "in_transit",
    },
    ctx,
    id,
  );
  await assert.rejects(
    quickShipmentAction(id, ctx, "collect"),
    /Only delivered/,
  );
});

test("push transitions dedupe, honor preferences, retry safely, and reject removed memberships", async () => {
  const { registerDevice, saveNotificationSettings, deliverPush } =
    await import("../lib/notifications");
  const sessionHash = "push-fixture-session";
  await query(
    "INSERT INTO native_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [sessionHash, ctx.userId],
  );
  const native = { ...ctx, nativeSessionHash: sessionHash };
  const prefs = {
    enabled: true,
    outForDelivery: true,
    delivered: true,
    pickup: true,
    problems: true,
  };
  await registerDevice(native, {
    token: "a".repeat(64),
    environment: "sandbox",
  });
  await saveNotificationSettings(native, prefs);
  const id = await saveManual(
    {
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
      merchant: "Push fixture",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "in_transit",
    },
    ctx,
  );
  await query(
    "UPDATE shipments SET status='out_for_delivery',status_at=now(),version=version+1 WHERE id=$1",
    [id],
  );
  await query(
    "UPDATE shipments SET status='out_for_delivery',version=version+1 WHERE id=$1",
    [id],
  );
  const deliveries = await query(
    "SELECT * FROM push_deliveries WHERE shipment_id=$1",
    [id],
  );
  assert.equal(deliveries.length, 1);
  let attempts = 0;
  await assert.rejects(
    deliverPush(deliveries[0].id, async () => {
      attempts++;
      return { status: 503 };
    }),
    /503/,
  );
  assert.equal(
    (
      await query("SELECT status FROM push_deliveries WHERE id=$1", [
        deliveries[0].id,
      ])
    )[0].status,
    "pending",
  );
  await deliverPush(deliveries[0].id, async () => {
    attempts++;
    return { status: 200 };
  });
  await deliverPush(deliveries[0].id, async () => {
    attempts++;
    return { status: 200 };
  });
  assert.equal(attempts, 2);
  await saveNotificationSettings(native, { ...prefs, delivered: false });
  await quickShipmentAction(id, ctx, "deliver");
  assert.equal(
    (await query("SELECT * FROM push_deliveries WHERE shipment_id=$1", [id]))
      .length,
    1,
  );
  await saveNotificationSettings(native, prefs);
  const second = await saveManual(
    {
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
      merchant: "Another push",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "in_transit",
    },
    ctx,
  );
  await quickShipmentAction(second, ctx, "deliver");
  const [queued] = await query(
    "SELECT * FROM push_deliveries WHERE shipment_id=$1",
    [second],
  );
  await saveNotificationSettings(native, { ...prefs, enabled: false });
  await deliverPush(queued.id, async () => {
    throw new Error("Disabled preferences must never send");
  });
  assert.equal(
    (
      await query("SELECT status FROM push_deliveries WHERE id=$1", [queued.id])
    )[0].status,
    "skipped",
  );
  await saveNotificationSettings(native, prefs);
  const third = await saveManual(
    {
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
      merchant: "Removed membership",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "delivered",
    },
    ctx,
  );
  const [removed] = await query(
    "SELECT * FROM push_deliveries WHERE shipment_id=$1",
    [third],
  );
  await query(
    "DELETE FROM household_members WHERE household_id=$1 AND user_id=$2",
    [ctx.householdId, ctx.userId],
  );
  await deliverPush(removed.id, async () => {
    throw new Error("Removed members must never receive pushes");
  });
  assert.equal(
    (
      await query("SELECT status FROM push_deliveries WHERE id=$1", [
        removed.id,
      ])
    )[0].status,
    "skipped",
  );
  await query(
    "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'owner')",
    [ctx.householdId, ctx.userId],
  );
  await query("DELETE FROM native_sessions WHERE token_hash=$1", [sessionHash]);
  assert.equal(
    (
      await query("SELECT * FROM push_devices WHERE session_hash=$1", [
        sessionHash,
      ])
    ).length,
    0,
  );
});

test("attention alerts do not repeat and resolved or collected packages suppress queued pushes", async () => {
  const {
    registerDevice,
    saveNotificationSettings,
    scheduleNotifications,
    deliverPush,
  } = await import("../lib/notifications");
  const native = { ...ctx, nativeSessionHash: "attention-push-session" };
  await query(
    "INSERT INTO native_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [native.nativeSessionHash, ctx.userId],
  );
  await registerDevice(native, {
    token: "b".repeat(64),
    environment: "sandbox",
  });
  await saveNotificationSettings(native, {
    enabled: true,
    outForDelivery: true,
    delivered: true,
    pickup: true,
    problems: true,
  });
  const id = await saveManual(
    {
      merchant: "Stalled test",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "ordered",
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
    },
    ctx,
  );
  await query(
    "UPDATE shipments SET created_at=now()-interval '8 days' WHERE id=$1",
    [id],
  );
  await scheduleNotifications();
  await scheduleNotifications();
  const alerts = await query(
    "SELECT * FROM push_deliveries WHERE shipment_id=$1",
    [id],
  );
  assert.equal(alerts.length, 1);
  await query(
    "UPDATE shipments SET shipped_at=now(),status='in_transit',version=version+1 WHERE id=$1",
    [id],
  );
  await deliverPush(alerts[0].id, async () => {
    throw new Error("Resolved attention must not send");
  });
  assert.equal(
    (
      await query("SELECT status FROM push_deliveries WHERE id=$1", [
        alerts[0].id,
      ])
    )[0].status,
    "skipped",
  );
  await quickShipmentAction(id, ctx, "deliver");
  const [delivered] = await query(
    "SELECT * FROM push_deliveries WHERE shipment_id=$1 AND category='delivered'",
    [id],
  );
  await quickShipmentAction(id, ctx, "collect");
  await deliverPush(delivered.id, async () => {
    throw new Error("Collected package must not send");
  });
  assert.equal(
    (
      await query("SELECT status FROM push_deliveries WHERE id=$1", [
        delivered.id,
      ])
    )[0].status,
    "skipped",
  );
  await query("DELETE FROM native_sessions WHERE token_hash=$1", [
    native.nativeSessionHash,
  ]);
});

test("device registration requires native auth and reassignment discards old login deliveries", async () => {
  const { registerDevice, saveNotificationSettings, deliverPush } =
    await import("../lib/notifications");
  const device = { token: "c".repeat(64), environment: "sandbox" };
  await assert.rejects(registerDevice(ctx, device), /iPhone app/);
  for (const key of ["old-device-session", "new-device-session"])
    await query(
      "INSERT INTO native_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [key, ctx.userId],
    );
  await registerDevice(
    { ...ctx, nativeSessionHash: "old-device-session" },
    device,
  );
  await saveNotificationSettings(ctx, {
    enabled: true,
    outForDelivery: true,
    delivered: true,
    pickup: true,
    problems: true,
  });
  const id = await saveManual(
    {
      merchant: "Device test",
      items: [{ name: "Parcel", quantity: 1, imageUrl: null }],
      status: "delivered",
      orderNumber: null,
      orderedAt: null,
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: null,
      estimate: null,
      deliveredAt: null,
    },
    ctx,
  );
  assert.equal(
    (await query("SELECT * FROM push_deliveries WHERE shipment_id=$1", [id]))
      .length,
    1,
  );
  await registerDevice(
    { ...ctx, nativeSessionHash: "new-device-session" },
    device,
  );
  assert.equal(
    (await query("SELECT * FROM push_deliveries WHERE shipment_id=$1", [id]))
      .length,
    0,
  );
  await query(
    "UPDATE shipments SET status='out_for_delivery',status_at=now()-interval '2 days',version=version+1 WHERE id=$1",
    [id],
  );
  assert.equal(
    (await query("SELECT * FROM push_deliveries WHERE shipment_id=$1", [id]))
      .length,
    0,
  );
  await query(
    "UPDATE shipments SET status='delivered',status_at=now(),version=version+1 WHERE id=$1",
    [id],
  );
  const [queued] = await query(
    "SELECT * FROM push_deliveries WHERE shipment_id=$1",
    [id],
  );
  await deliverPush(queued.id, async () => ({
    status: 410,
    reason: "Unregistered",
  }));
  assert.equal(
    (await query("SELECT * FROM push_devices WHERE token=$1", [device.token]))
      .length,
    0,
  );
  await query("DELETE FROM native_sessions WHERE token_hash=ANY($1::text[])", [
    ["old-device-session", "new-device-session"],
  ]);
});

test("formatting-tolerant order matching upgrades confirmations and preserves split shipments under concurrency", async () => {
  const merchant = "Formatting regression shop";
  async function ingest(key: string, number: string, tracking: string | null) {
    const email = await incoming(
      key,
      `Order ${number} ${tracking || ""} Trail shoes`,
    );
    const parsed = extraction(tracking, tracking ? "in_transit" : "ordered");
    parsed.orders[0].merchant = merchant;
    parsed.orders[0].orderNumber = number;
    await applyExtraction(email.id, parsed);
    return email.id;
  }
  const confirmation = await ingest("format:confirm", "AB-005174132", null);
  const [original] = await query(
    "SELECT s.id FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.merchant=$2",
    [ctx.householdId, merchant],
  );
  await Promise.all([
    ingest("format:ship", "Order #ab 005174132", "FORMATTRACK1"),
    ingest("format:retry", "AB/005174132", "FORMATTRACK1"),
  ]);
  let rows = await query(
    "SELECT s.id,s.tracking_number,s.order_id FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.merchant=$2",
    [ctx.householdId, merchant],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, original.id);
  assert.equal(rows[0].tracking_number, "FORMATTRACK1");
  assert.equal(
    (
      await query("SELECT * FROM shipment_emails WHERE shipment_id=$1", [
        original.id,
      ])
    ).length,
    3,
  );
  assert.ok(
    (
      await query(
        "SELECT * FROM shipment_emails WHERE shipment_id=$1 AND email_id=$2",
        [original.id, confirmation],
      )
    ).length,
  );
  await ingest("format:split", "AB_005174132", "FORMATTRACK2");
  rows = await query(
    "SELECT s.order_id FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.merchant=$2",
    [ctx.householdId, merchant],
  );
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.order_id)).size, 1);
  await ingest("format:different-digit", "AB-005174133", null);
  assert.equal(
    (
      await query(
        "SELECT * FROM orders WHERE household_id=$1 AND merchant=$2",
        [ctx.householdId, merchant],
      )
    ).length,
    2,
  );
});

test("normalized order matches remain household and merchant scoped and ambiguous candidates require review", async () => {
  const merchant = "Ambiguous formatting shop";
  const [other] = await query(
    "INSERT INTO households(name,forwarding_token,feed_token) VALUES('Formatting isolation',$1,$2) RETURNING id",
    [randomToken(), randomToken()],
  );
  for (const [household, shop, number] of [
    [ctx.householdId, merchant, "XY-123456"],
    [ctx.householdId, merchant, "XY/123456"],
    [other.id, merchant, "ZZ-987654"],
    [ctx.householdId, "Another merchant", "ZZ/987654"],
  ])
    await query(
      "INSERT INTO orders(household_id,merchant,merchant_key,order_number) VALUES($1,$2,lower($2),$3)",
      [household, shop, number],
    );
  for (const [key, number, review] of [
    ["ambiguous", "XY 123456", true],
    ["isolated", "ZZ 987654", false],
    ["exact", "XY-123456", false],
  ] as const) {
    const email = await incoming(`format:${key}`);
    const parsed = extraction(null, "ordered");
    parsed.orders[0].merchant = merchant;
    parsed.orders[0].orderNumber = number;
    await applyExtraction(email.id, parsed);
    const [row] = await query(
      "SELECT s.needs_review,s.review_reason,o.order_number FROM shipments s JOIN orders o ON o.id=s.order_id JOIN shipment_emails se ON se.shipment_id=s.id WHERE se.email_id=$1 AND s.household_id=$2",
      [email.id, ctx.householdId],
    );
    assert.equal(row.order_number, number);
    assert.equal(row.needs_review, review);
    if (review) assert.match(row.review_reason, /Multiple orders match/);
  }
});

test("Cometeer-style letter prefixes match with corroboration and preserve ambiguity", async () => {
  const merchant = "Prefix regression coffee";
  async function ingest(
    key: string,
    number: string,
    track: string | null,
    day = "2026-09-10",
  ) {
    const email = await incoming(key, `Coffee capsules ${track || ""}`);
    const parsed = extraction(
      track,
      track ? "in_transit" : "ordered",
      "2026-09-20",
      ["Coffee capsules"],
    );
    Object.assign(parsed.orders[0], {
      merchant,
      orderNumber: number,
      orderedAt: day,
    });
    await applyExtraction(email.id, parsed);
  }
  await ingest("prefix:confirmation", "98765432", null);
  await ingest("prefix:shipment", "T98765432", "PREFIXTRACK1");
  let rows = await query(
    "SELECT s.id,s.tracking_number FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.merchant=$2",
    [ctx.householdId, merchant],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tracking_number, "PREFIXTRACK1");
  await ingest("prefix:other-date", "T98765432", null, "2026-09-11");
  rows = await query(
    "SELECT * FROM orders WHERE household_id=$1 AND merchant=$2",
    [ctx.householdId, merchant],
  );
  assert.equal(rows.length, 2);
  await query(
    "INSERT INTO orders(household_id,merchant,merchant_key,order_number,ordered_at,items) VALUES($1,$2,lower($2),'P98765432','2026-09-10',$3)",
    [ctx.householdId, merchant, JSON.stringify([{ name: "Coffee capsules" }])],
  );
  await ingest("prefix:ambiguous", "X98765432", null);
  // X can only match the unprefixed order; distinct prefixes are never stripped.
  assert.equal(
    (
      await query(
        "SELECT * FROM orders WHERE household_id=$1 AND merchant=$2",
        [ctx.householdId, merchant],
      )
    ).length,
    3,
  );
  for (const number of ["T87654321", "P87654321"])
    await query(
      "INSERT INTO orders(household_id,merchant,merchant_key,order_number,ordered_at,items) VALUES($1,$2,lower($2),$3,'2026-09-10',$4)",
      [
        ctx.householdId,
        merchant,
        number,
        JSON.stringify([{ name: "Coffee capsules" }]),
      ],
    );
  await ingest("prefix:multiple-candidates", "87654321", null);
  const [ambiguous] = await query(
    "SELECT s.needs_review FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.household_id=$1 AND o.merchant=$2 AND o.order_number='87654321'",
    [ctx.householdId, merchant],
  );
  assert.equal(ambiguous.needs_review, true);
});
