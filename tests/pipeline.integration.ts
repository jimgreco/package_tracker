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
import { applyTracker } from "../lib/tracking";
import { claimJob, runOne } from "../lib/jobs";
import { encrypt, randomToken } from "../lib/security";
import { syncShipment } from "../lib/google";
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
  assert.equal(
    (
      await POST(
        request({
          ...payload,
          OriginalRecipient: "packages+unknown@inbound.example.invalid",
        }),
        params,
      )
    ).status,
    403,
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
