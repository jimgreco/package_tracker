import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { pool, query } from "../lib/db";
import { randomToken, encrypt } from "../lib/security";
import { type Context } from "../lib/auth";
import { addMember, removeMember } from "../lib/households";
import {
  googleStart,
  googleCallback,
  disconnectGoogle,
  syncShipment,
} from "../lib/google";
import { saveManual } from "../lib/shipments";
import { GET } from "../app/api/[...path]/route";

const dbUrl = new URL(process.env.DATABASE_URL!);
const dbName = `doorstep_calendar_test_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(dbUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
const originalFetch = globalThis.fetch;
const appUrl = "http://127.0.0.1:4317";
let created = false;

before(async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(dbUrl.hostname));
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  dbUrl.pathname = "/" + dbName;
  Object.assign(process.env, {
    DATABASE_URL: dbUrl.toString(),
    APP_URL: appUrl,
    DEMO_MODE: "false",
    GOOGLE_CLIENT_ID: "calendar-isolation-fixture",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    ENCRYPTION_KEY: "d".repeat(64),
  });
  for (const file of (await readdir("db"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await query(await readFile(`db/${file}`, "utf8"));
  globalThis.fetch = async () => {
    throw new Error("Unexpected provider call");
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (created) {
    await pool().end();
    await admin.query(`DROP DATABASE "${dbName}"`);
  }
  await admin.end();
});

async function household() {
  const [h] = await query(
    "INSERT INTO households(name,forwarding_token,feed_token) VALUES('Calendar isolation fixture',$1,$2) RETURNING *",
    [randomToken(), randomToken()],
  );
  async function member(role: "owner" | "member") {
    const id = randomUUID();
    const [u] = await query(
      "INSERT INTO users(household_id,email,name,google_subject) VALUES($1,$2,'Fixture member',$3) RETURNING *",
      [h.id, `${id}@example.invalid`, id],
    );
    await query(
      "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,$3)",
      [h.id, u.id, role],
    );
    return {
      userId: u.id,
      householdId: h.id,
      name: u.name,
      email: u.email,
      householdName: h.name,
      timeZone: h.time_zone,
      forwardingToken: h.forwarding_token,
      feedToken: h.feed_token,
      plan: "free",
      demo: false,
    } as Context;
  }
  return { owner: await member("owner"), member: await member("member") };
}
async function calendarAttempt(ctx: Context) {
  const consent = new URL((await googleStart(ctx)).url);
  return new URL(
    `${appUrl}/api/google/callback?state=${consent.searchParams.get("state")}&code=fixture`,
  );
}
function calendarTokens() {
  return Response.json({
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    scope: "https://www.googleapis.com/auth/calendar.app.created",
  });
}
async function connectCalendar(ctx: Context) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    return calendarTokens();
  };
  try {
    await googleCallback(ctx, await calendarAttempt(ctx));
  } finally {
    globalThis.fetch = previous;
  }
  await query(
    "UPDATE google_connections SET calendar_id='fixture-calendar' WHERE household_id=$1",
    [ctx.householdId],
  );
}
async function connections(ctx: Context) {
  return query(
    "SELECT household_id FROM google_connections WHERE household_id=$1",
    [ctx.householdId],
  );
}
async function feed(token: string) {
  return GET(new Request(`${appUrl}/api/calendar/${token}.ics`), {
    params: Promise.resolve({ path: ["calendar", `${token}.ics`] }),
  });
}
async function shipment(ctx: Context) {
  return saveManual(
    {
      merchant: "Private fixture parcel",
      orderNumber: null,
      orderedAt: null,
      items: [{ name: "Fixture item", quantity: 1, imageUrl: null }],
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      status: "ordered",
      shippedAt: null,
      deliveredAt: null,
      estimate: {
        kind: "date",
        start: "2026-10-10",
        end: null,
        timeZone: "America/New_York",
        label: null,
      },
    },
    ctx,
  );
}

test("removing a household member revokes their previously copied calendar feed", async () => {
  const { owner, member } = await household();
  await shipment(owner);
  const before = await feed(member.feedToken);
  assert.equal(before.status, 200);
  assert.match(await before.text(), /Private fixture parcel/);
  await removeMember(owner, { userId: member.userId });
  assert.equal((await feed(member.feedToken)).status, 404);
  const [home] = await query("SELECT feed_token FROM households WHERE id=$1", [
    owner.householdId,
  ]);
  assert.equal((await feed(home.feed_token)).status, 200);
});

test("cancelling an invitation does not disrupt existing calendar subscriptions", async () => {
  const { owner } = await household();
  await addMember(owner, { email: "invitee@example.invalid" });
  await removeMember(owner, { email: "invitee@example.invalid" });
  assert.equal((await feed(owner.feedToken)).status, 200);
});

test("removal stops exports to the removed member's Google Calendar", async () => {
  const { owner, member } = await household();
  const id = await shipment(owner);
  await connectCalendar(member);
  await removeMember(owner, { userId: member.userId });
  assert.equal((await connections(owner)).length, 0);
  await syncShipment(id); // The default fetch stub rejects any provider request.
});

test("removal preserves a remaining member's known Calendar connection and other households", async () => {
  const { owner, member } = await household();
  const other = await household();
  await connectCalendar(owner);
  await connectCalendar(other.owner);
  await removeMember(owner, { userId: member.userId });
  assert.equal((await connections(owner)).length, 1);
  assert.equal((await connections(other.owner)).length, 1);
  assert.equal((await feed(other.owner.feedToken)).status, 200);
});

test("legacy Calendar connections with unknown ownership stop on member removal", async () => {
  const { owner, member } = await household();
  await query(
    "INSERT INTO google_connections(household_id,refresh_token,generation) VALUES($1,$2,$3)",
    [owner.householdId, encrypt("legacy-fixture-refresh"), randomToken()],
  );
  await removeMember(owner, { userId: member.userId });
  assert.equal((await connections(owner)).length, 0);
});

test("Calendar disconnect invalidates pending browser consent", async () => {
  const { owner } = await household();
  const callback = await calendarAttempt(owner);
  await disconnectGoogle(owner);
  const previous = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async () => {
    exchanges++;
    return calendarTokens();
  };
  try {
    await assert.rejects(() => googleCallback(owner, callback));
    assert.equal(exchanges, 0);
    assert.equal((await connections(owner)).length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("disconnect during a browser token exchange cannot resurrect Calendar access", async () => {
  const { owner } = await household();
  const callback = await calendarAttempt(owner);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    await disconnectGoogle(owner);
    return calendarTokens();
  };
  try {
    await assert.rejects(() => googleCallback(owner, callback));
    assert.equal((await connections(owner)).length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("membership removal during a browser token exchange cannot create an export", async () => {
  const { owner, member } = await household();
  const callback = await calendarAttempt(member);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    await removeMember(owner, { userId: member.userId });
    return calendarTokens();
  };
  try {
    await assert.rejects(() => googleCallback(member, callback));
    assert.equal((await connections(owner)).length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test(
  "a worker delayed after obtaining a token cannot export after disconnect",
  { timeout: 5000 },
  async (t) => {
    const { owner } = await household();
    const id = await shipment(owner);
    await connectCalendar(owner);
    let pause!: () => void, resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const db = pool(),
      originalConnect = db.connect;
    let transactions = 0,
      writes = 0;
    // Model pool contention between token acquisition and the export transaction.
    // SQL and transaction locking still run against real isolated PostgreSQL.
    const connect = t.mock.method(db, "connect", (...args: unknown[]) => {
      const acquire = () =>
        Reflect.apply(originalConnect, db, args) as Promise<pg.PoolClient>;
      if (args.length === 0 && ++transactions === 2) {
        pause();
        return resumed.then(acquire);
      }
      return acquire();
    });
    const previous = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token")
        return calendarTokens();
      writes++;
      return Response.json({});
    };
    const syncing = syncShipment(id);
    try {
      await paused;
      await disconnectGoogle(owner);
      resume();
      await syncing;
      assert.equal(writes, 0);
    } finally {
      resume();
      await syncing;
      connect.mock.restore();
      globalThis.fetch = previous;
    }
  },
);

test("browser Calendar consent remains single-use after successful connection", async () => {
  const { owner } = await household();
  const callback = await calendarAttempt(owner);
  const previous = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async () => {
    exchanges++;
    return calendarTokens();
  };
  try {
    await googleCallback(owner, callback);
    await assert.rejects(() => googleCallback(owner, callback));
    assert.equal(exchanges, 1);
    assert.equal((await connections(owner)).length, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
