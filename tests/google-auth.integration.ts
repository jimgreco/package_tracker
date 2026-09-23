import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { pool, query } from "../lib/db";
import { decrypt, hash, randomToken } from "../lib/security";
import { sessionCookie } from "../lib/auth";
import { GET, POST } from "../app/api/[...path]/route";
const appUrl = "http://127.0.0.1:4317";
const dbUrl = new URL(process.env.DATABASE_URL!);
const dbName = `doorstep_auth_test_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(dbUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
const originalFetch = globalThis.fetch;
let createdDb = false;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let forgedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let householdId: string, googleUserId: string;
const codes = new Map<string, { token: string; verifier: string }>();
let tokenExchanges = 0;
before(async () => {
  assert.ok(
    ["localhost", "127.0.0.1"].includes(dbUrl.hostname),
    "Tests require an isolated local database",
  );
  await admin.query(`CREATE DATABASE "${dbName}"`);
  createdDb = true;
  dbUrl.pathname = "/" + dbName;
  Object.assign(process.env, {
    DATABASE_URL: dbUrl.toString(),
    APP_URL: appUrl,
    DEMO_MODE: "false",
    GOOGLE_CLIENT_ID: "auth-fixture-client",
    GOOGLE_CLIENT_SECRET: "auth-fixture-secret",
    ENCRYPTION_KEY: "b".repeat(64),
  });
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
  keys = await generateKeyPair("RS256");
  forgedKeys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [jwk] });
    if (url === "https://oauth2.googleapis.com/token") {
      tokenExchanges++;
      const params = new URLSearchParams(options?.body as URLSearchParams);
      const value = codes.get(params.get("code")!);
      assert.ok(value, "Only fixture authorization codes are accepted");
      assert.equal(params.get("client_id"), "auth-fixture-client");
      assert.equal(
        params.get("redirect_uri"),
        appUrl + "/api/auth/google/callback",
      );
      assert.equal(params.get("code_verifier"), value.verifier);
      return Response.json({
        id_token: value.token,
        access_token: "not-persisted",
        token_type: "Bearer",
      });
    }
    throw new Error("Unexpected external request in auth tests");
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (createdDb) {
    await pool().end();
    await admin.query(`DROP DATABASE "${dbName}"`);
  }
  await admin.end();
});
async function call(
  path: string,
  body?: unknown,
  cookie = "",
  withOrigin = true,
) {
  const method = body === undefined ? "GET" : "POST";
  const req = new Request(appUrl + "/api/" + path, {
    method,
    headers: {
      ...(withOrigin ? { origin: appUrl } : {}),
      "Content-Type": "application/json",
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (method === "GET" ? GET : POST)(req, {
    params: Promise.resolve({ path: path.split("?")[0].split("/") }),
  });
}
async function start() {
  const res = await call("auth/google/start", {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const url = new URL((await res.json()).url);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  assert.match(res.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("access_type"), null);
  const [state] = await query(
    "SELECT * FROM google_signin_states WHERE state_hash=$1",
    [hash(url.searchParams.get("state")!)],
  );
  const verifier = decrypt(state.verifier);
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  return { url, cookie, verifier };
}
async function finish(
  attempt: Awaited<ReturnType<typeof start>>,
  claims: JWTPayload = {},
  forged = false,
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sub: "google-owner",
    email: "owner@gmail.com",
    name: "Owner",
    email_verified: true,
    iss: "https://accounts.google.com",
    aud: "auth-fixture-client",
    iat: now,
    exp: now + 3600,
    nonce: attempt.url.searchParams.get("nonce"),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign((forged ? forgedKeys : keys).privateKey);
  const code = randomToken();
  codes.set(code, { token, verifier: attempt.verifier });
  const path = `auth/google/callback?state=${attempt.url.searchParams.get("state")}&code=${code}`;
  const response = await call(path, undefined, attempt.cookie, false);
  return { response, path };
}
function authError(response: Response) {
  return new URL(response.headers.get("location")!).searchParams.get(
    "authError",
  );
}
function authSession(response: Response) {
  return response.headers
    .getSetCookie()
    .find((x) => x.startsWith("doorstep_session="))
    ?.split(";")[0];
}
test("Google setup status and origin checks fail clearly without creating attempts", async () => {
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.deepEqual(await (await call("auth/config")).json(), { google: false });
  assert.equal((await call("auth/google/start", {})).status, 503);
  process.env.GOOGLE_CLIENT_SECRET = "auth-fixture-secret";
  assert.equal((await call("auth/google/start", {}, "", false)).status, 403);

  assert.equal((await query("SELECT * FROM google_signin_states")).length, 0);
});
test("Google sign-in creates a private household automatically", async () => {
  const attempt = await start();
  const { response } = await finish(attempt);
  assert.equal(authError(response), null);
  assert.ok(authSession(response));
  const [user] = await query(
    "SELECT * FROM users WHERE google_subject='google-owner'",
  );
  googleUserId = user.id;
  householdId = user.household_id;
  assert.equal("password_hash" in user, false);
  assert.equal(user.email, "owner@gmail.com");
  const dashboard = await call("dashboard", undefined, authSession(response)!);
  assert.equal(dashboard.status, 200);
  const data = await dashboard.json();
  assert.equal(data.settings.account.email, "owner@gmail.com");
  assert.equal(data.settings.householdName, "Owner’s household");
  assert.equal(data.shipments.length, 0);
  assert.equal(data.settings.google.connected, false);
  assert.equal((await query("SELECT * FROM google_connections")).length, 0);
  assert.ok(
    response.headers
      .getSetCookie()
      .some(
        (x) =>
          x.startsWith("doorstep_google_signin=;") && x.includes("Max-Age=0"),
      ),
  );
});
test("returning Google sign-in uses the stable subject even when email changes; legacy password sign-in is unavailable and logout revokes the session", async () => {
  const { response } = await finish(await start(), {
    email: "changed@gmail.com",
  });
  assert.equal(authError(response), null);
  const session = authSession(response)!;
  const [user] = await query(
    "SELECT * FROM users WHERE google_subject='google-owner'",
  );
  assert.equal(user.id, googleUserId);
  assert.equal(user.google_email, "changed@gmail.com");
  assert.equal(
    (
      await call("auth/login", {
        email: user.email,
        password: "does-not-exist",
      })
    ).status,
    401,
  );
  assert.equal((await call("auth/logout", {}, session)).status, 200);
  assert.equal((await call("dashboard", undefined, session)).status, 401);
});
test("browser binding, expired state, cancellation, and replay do not create sessions", async () => {
  const attempt = await start();
  const exchanges = tokenExchanges;
  const wrongBrowser = await call(
    `auth/google/callback?state=${attempt.url.searchParams.get("state")}&code=forged`,
    undefined,
    "doorstep_google_signin=wrong",
  );
  assert.match(authError(wrongBrowser)!, /expired|already used/);
  assert.equal(tokenExchanges, exchanges);
  const { response, path } = await finish(attempt);
  assert.equal(authError(response), null);
  const replay = await call(path, undefined, attempt.cookie);
  assert.ok(authError(replay));
  assert.equal(authSession(replay), undefined);
  const expired = await start();
  await query(
    "UPDATE google_signin_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
    [hash(expired.url.searchParams.get("state")!)],
  );
  assert.ok(authError((await finish(expired)).response));
  const cancelled = await start();
  const cancel = await call(
    `auth/google/callback?state=${cancelled.url.searchParams.get("state")}&error=access_denied`,
    undefined,
    cancelled.cookie,
  );
  assert.match(authError(cancel)!, /cancelled/);
  assert.equal(authSession(cancel), undefined);
});
test("signed identities reject forged signatures and invalid identity claims", async () => {
  const cases: [JWTPayload, boolean][] = [
    [{}, true],
    [{ aud: "another-app" }, false],
    [{ iss: "https://attacker.invalid" }, false],
    [{ exp: 1 }, false],
    [{ iat: 1 }, false],
    [{ nonce: "wrong" }, false],
    [{ email_verified: false }, false],
    [{ azp: "another-client" }, false],
    [{ aud: ["auth-fixture-client", "another-client"] }, false],
    [{ sub: "" }, false],
  ];
  for (const [claims, forged] of cases) {
    const { response } = await finish(await start(), claims, forged);
    assert.match(authError(response)!, /could not be verified/);
    assert.equal(authSession(response), undefined);
  }
});

test("adding a Google email joins that household on first sign-in without codes", async () => {
  const ownerSession = (await sessionCookie(googleUserId)).split(";")[0];
  const email = "housemate@gmail.com";
  const added = await call(
    "settings/members",
    { email: "Housemate@gmail.com" },
    ownerSession,
  );
  assert.equal(added.status, 200);
  assert.equal(
    (await call("settings/members", { email }, ownerSession)).status,
    200,
  );
  const pending = await (
    await call("dashboard", undefined, ownerSession)
  ).json();
  assert.equal(
    pending.settings.members.filter((m: { pending: boolean }) => m.pending)
      .length,
    1,
  );
  const claims = { sub: "google-housemate", email, name: "Housemate" };
  const results = await Promise.all([
    finish(await start(), claims),
    finish(await start(), claims),
  ]);
  for (const result of results) assert.equal(authError(result.response), null);
  const [member] = await query("SELECT * FROM users WHERE google_subject=$1", [
    claims.sub,
  ]);
  assert.equal(member.household_id, householdId);
  assert.equal(
    (
      await query("SELECT * FROM household_members WHERE user_id=$1", [
        member.id,
      ])
    ).length,
    1,
  );
  assert.equal(
    (await query("SELECT * FROM household_invitations WHERE email=$1", [email]))
      .length,
    0,
  );
  assert.equal((await query("SELECT * FROM households")).length, 1);
  const memberSession = authSession(results[0].response)!;
  assert.equal(
    (
      await call(
        "settings/members",
        { email: "outsider@gmail.com" },
        memberSession,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "settings/members/remove",
        { userId: googleUserId },
        memberSession,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "settings/members/remove",
        { userId: googleUserId },
        ownerSession,
      )
    ).status,
    400,
  );
  const removed = await call(
    "settings/members/remove",
    { userId: member.id },
    ownerSession,
  );
  assert.equal(removed.status, 200);
  const own = await (await call("dashboard", undefined, memberSession)).json();
  assert.notEqual(own.settings.householdId, householdId);
  assert.equal(own.settings.role, "owner");
  assert.equal(
    (await call("settings/household-switch", { householdId }, memberSession))
      .status,
    403,
  );
});
test("existing accounts can join another household and switch without mixing package data", async () => {
  const ownerSession = (await sessionCookie(googleUserId)).split(";")[0];
  const [member] = await query(
    "SELECT * FROM users WHERE google_subject='google-housemate'",
  );
  const originalHousehold = member.household_id;
  await call(
    "settings/members",
    { email: "housemate@gmail.com" },
    ownerSession,
  );
  const { response } = await finish(await start(), {
    sub: "google-housemate",
    email: "housemate@gmail.com",
    name: "Housemate",
  });
  assert.equal(authError(response), null);
  const session = authSession(response)!;
  let data = await (await call("dashboard", undefined, session)).json();
  assert.equal(data.settings.households.length, 2);
  assert.equal(data.settings.householdId, originalHousehold);
  assert.equal(
    (await call("settings/household-switch", { householdId }, session)).status,
    200,
  );
  data = await (await call("dashboard", undefined, session)).json();
  assert.equal(data.settings.householdId, householdId);
  assert.equal(data.settings.role, "member");
  assert.equal(
    (
      await call(
        "settings/household-switch",
        { householdId: randomUUID() },
        session,
      )
    ).status,
    403,
  );
});
test("cancelled membership invitations never grant access", async () => {
  const session = (await sessionCookie(googleUserId)).split(";")[0];
  await call("settings/members", { email: "cancelled@gmail.com" }, session);
  await call(
    "settings/members/remove",
    { email: "cancelled@gmail.com" },
    session,
  );
  const { response } = await finish(await start(), {
    sub: "cancelled",
    email: "cancelled@gmail.com",
    name: "Cancelled",
  });
  assert.equal(authError(response), null);
  const [member] = await query(
    "SELECT * FROM users WHERE google_subject='cancelled'",
  );
  assert.notEqual(member.household_id, householdId);
});
test("a Google Workspace identity can join; unverified and third-party email claims cannot claim shared access", async () => {
  const session = (await sessionCookie(googleUserId)).split(";")[0];
  for (const email of [
    "colleague@company.invalid",
    "third-party@example.invalid",
  ])
    await call("settings/members", { email }, session);
  const workspace = await finish(await start(), {
    sub: "workspace",
    email: "colleague@company.invalid",
    hd: "company.invalid",
  });
  assert.equal(authError(workspace.response), null);
  assert.equal(
    (
      await query(
        "SELECT household_id FROM users WHERE google_subject='workspace'",
      )
    )[0].household_id,
    householdId,
  );
  const thirdParty = await finish(await start(), {
    sub: "third-party",
    email: "third-party@example.invalid",
  });
  assert.equal(authError(thirdParty.response), null);
  assert.notEqual(
    (
      await query(
        "SELECT household_id FROM users WHERE google_subject='third-party'",
      )
    )[0].household_id,
    householdId,
  );
});
test("a different Google subject cannot take over an existing email account", async () => {
  const { response } = await finish(await start(), {
    sub: "imposter",
    email: "owner@gmail.com",
  });
  assert.match(authError(response)!, /another account/);
  assert.equal(authSession(response), undefined);
  assert.equal(
    (
      await query("SELECT google_subject FROM users WHERE id=$1", [
        googleUserId,
      ])
    )[0].google_subject,
    "google-owner",
  );
});

test("calendar authorization stays bound to the household where it began", async () => {
  const { context } = await import("../lib/auth");
  const { googleStart, googleCallback } = await import("../lib/google");
  const session = (await sessionCookie(googleUserId)).split(";")[0];
  const ctx = await context(
    new Request(appUrl, { headers: { cookie: session } }),
    false,
  );
  const started = new URL((await googleStart(ctx)).url);
  const callback = new URL(
    appUrl +
      "/api/google/callback?state=" +
      started.searchParams.get("state") +
      "&code=wrong-household",
  );
  const exchanges = tokenExchanges;
  await assert.rejects(
    googleCallback({ ...ctx, householdId: randomUUID() }, callback),
    /expired/,
  );
  assert.equal(tokenExchanges, exchanges);
  const [state] = await query(
    "SELECT household_id FROM oauth_states WHERE state_hash=$1",
    [hash(started.searchParams.get("state")!)],
  );
  assert.equal(state.household_id, householdId);
});

async function nativeCall(
  path: string,
  body?: unknown,
  token?: string,
  extra: Record<string, string> = {},
) {
  const method = body === undefined ? "GET" : "POST";
  return (method === "GET" ? GET : POST)(
    new Request(appUrl + "/api/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
  );
}
async function nativeAttempt() {
  const verifier = randomToken(),
    state = randomToken();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await nativeCall("native/auth/start", { state, challenge });
  assert.equal(start.status, 200);
  const authorizationURL = (await start.json()).url;
  assert.equal(new URL(authorizationURL).origin, appUrl);
  const entry = await nativeCall(
    authorizationURL.replace(appUrl + "/api/", ""),
  );
  const url = new URL(entry.headers.get("location")!);
  const cookie = entry.headers.get("set-cookie")!.split(";")[0];
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  const [google] = await query(
    "SELECT * FROM google_signin_states WHERE state_hash=$1",
    [hash(url.searchParams.get("state")!)],
  );
  return {
    appState: state,
    appVerifier: verifier,
    url,
    cookie,
    verifier: decrypt(google.verifier),
    authorizationURL,
    nativeId: google.native_attempt_id,
  };
}
async function nativeCode() {
  const a = await nativeAttempt();
  const { response } = await finish(a);
  assert.equal(
    authSession(response),
    undefined,
    "Native login never creates a web session",
  );
  const callback = new URL(response.headers.get("location")!);
  assert.equal(callback.protocol, "com.jimgreco.doorstep:");
  assert.equal(callback.pathname, "/auth/callback");
  assert.equal(callback.searchParams.get("state"), a.appState);
  assert.deepEqual([...callback.searchParams.keys()].sort(), ["code", "state"]);
  return {
    ...a,
    body: {
      code: callback.searchParams.get("code"),
      verifier: a.appVerifier,
      state: a.appState,
    },
  };
}
test("native login validates destination, browser binding, expiry, consent, identity and replay", async () => {
  const state = randomToken(),
    challenge = createHash("sha256").update(randomToken()).digest("base64url");
  assert.equal(
    (
      await nativeCall("native/auth/start", {
        state,
        challenge,
        callback: "evil:/",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await nativeCall("native/auth/start", { state, challenge }, undefined, {
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await nativeCall("native/auth/start", { state, challenge }, undefined, {
        cookie: "doorstep_session=anything",
      })
    ).status,
    400,
  );
  const expired = await nativeAttempt();
  await query(
    "UPDATE native_login_attempts SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.nativeId],
  );
  assert.equal(
    (await nativeCall(expired.authorizationURL.replace(appUrl + "/api/", "")))
      .status,
    400,
  );
  const expiredCallback = await nativeAttempt();
  await query(
    "UPDATE native_login_attempts SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiredCallback.nativeId],
  );
  const expiredResponse = (await finish(expiredCallback)).response;
  assert.equal(authSession(expiredResponse), undefined);
  assert.equal(
    new URL(expiredResponse.headers.get("location")!).searchParams.get("error"),
    "signin_failed",
  );
  const denied = await nativeAttempt();
  const deniedResponse = await call(
    `auth/google/callback?state=${denied.url.searchParams.get("state")}&error=access_denied`,
    undefined,
    denied.cookie,
    false,
  );
  assert.equal(
    new URL(deniedResponse.headers.get("location")!).searchParams.get("error"),
    "signin_failed",
  );
  assert.equal(
    (
      await query("SELECT code_hash FROM native_login_attempts WHERE id=$1", [
        denied.nativeId,
      ])
    )[0].code_hash,
    null,
  );
  const invalid = await nativeAttempt();
  const invalidResponse = await finish(invalid, { email_verified: false });
  assert.equal(
    new URL(invalidResponse.response.headers.get("location")!).searchParams.get(
      "error",
    ),
    "signin_failed",
  );
  const browser = await nativeAttempt();
  const wrongBrowser = await call(
    `auth/google/callback?state=${browser.url.searchParams.get("state")}&code=unused`,
    undefined,
    "doorstep_google_signin=wrong",
    false,
  );
  assert.ok(authError(wrongBrowser));
  const attempt = await nativeCode();
  assert.equal(
    (
      await nativeCall("native/auth/exchange", {
        ...attempt.body,
        state: randomToken(),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await nativeCall("native/auth/exchange", {
        ...attempt.body,
        verifier: randomToken(),
      })
    ).status,
    401,
  );
  const replies = await Promise.all([
    nativeCall("native/auth/exchange", attempt.body),
    nativeCall("native/auth/exchange", attempt.body),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
  const session = await replies.find((r) => r.status === 200)!.json();
  assert.equal(session.userId, googleUserId);
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM users WHERE google_subject='google-owner'",
      )
    )[0].n,
    1,
  );
  assert.equal(
    (
      await query(
        "SELECT token_hash FROM native_sessions WHERE token_hash=$1",
        [hash(session.token)],
      )
    )[0].token_hash,
    hash(session.token),
  );
  const expiry = await nativeCode();
  await query(
    "UPDATE native_login_attempts SET code_expires_at=now()-interval '1 second' WHERE id=$1",
    [expiry.nativeId],
  );
  assert.equal(
    (await nativeCall("native/auth/exchange", expiry.body)).status,
    401,
  );
});
test("native bearer isolation, Origin separation, revocation and atomic manual creation", async () => {
  const connectionsBefore = await query(
    "SELECT * FROM google_connections ORDER BY household_id",
  );
  const gmailBefore = await query(
    "SELECT * FROM gmail_connections ORDER BY user_id",
  );
  const a = await nativeCode();
  const session = await (
    await nativeCall("native/auth/exchange", a.body)
  ).json();
  const token = session.token;
  const dashboard = await nativeCall("dashboard", undefined, token);
  assert.equal(dashboard.status, 200);
  assert.equal(
    dashboard.headers.get("x-doorstep-household"),
    session.householdId,
  );
  assert.equal(
    (await nativeCall("dashboard", undefined, randomToken())).status,
    401,
  );
  assert.equal(
    (
      await nativeCall("dashboard", undefined, token, {
        cookie: (await sessionCookie(googleUserId)).split(";")[0],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await nativeCall("dashboard", undefined, token, {
        "x-doorstep-household": randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (await nativeCall("settings/retry-jobs", {}, randomToken())).status,
    401,
  );
  assert.equal(
    (
      await nativeCall("settings/retry-jobs", {}, undefined, {
        cookie: (await sessionCookie(googleUserId)).split(";")[0],
      })
    ).status,
    403,
  );
  assert.equal((await nativeCall("gmail/pause", {}, token)).status, 403);
  assert.equal((await nativeCall("google/disconnect", {}, token)).status, 403);
  const input = {
    merchant: "Native fixture",
    orderNumber: null,
    orderedAt: null,
    items: [{ name: "Notebook", quantity: 1, imageUrl: null }],
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    status: "ordered",
    shippedAt: null,
    estimate: null,
    deliveredAt: null,
    manualOverride: false,
  };
  const key = randomToken();
  const saved = await Promise.all([
    nativeCall("shipments", input, token, { "idempotency-key": key }),
    nativeCall("shipments", input, token, { "idempotency-key": key }),
  ]);
  assert.deepEqual(
    saved.map((r) => r.status),
    [201, 201],
  );
  const ids = await Promise.all(saved.map((r) => r.json()));
  assert.equal(ids[0].id, ids[1].id);
  assert.equal(
    (
      await nativeCall("shipments", { ...input, merchant: "Changed" }, token, {
        "idempotency-key": key,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await query(
        "SELECT count(*)::int n FROM shipments s JOIN orders o ON o.id=s.order_id WHERE o.merchant='Native fixture'",
      )
    )[0].n,
    1,
  );
  assert.equal(
    (await nativeCall(`shipments/${ids[0].id}/dismiss`, {}, token)).status,
    200,
  );
  assert.equal(
    (
      await (
        await nativeCall(`shipments/${ids[0].id}`, undefined, token)
      ).json()
    ).shipment.status,
    "ordered",
  );
  assert.equal(
    (await nativeCall(`shipments/${ids[0].id}/restore`, {}, token)).status,
    200,
  );
  const [source] = await query(
    "INSERT INTO source_emails(household_id,message_key,subject,sender,body_text,status) VALUES($1,$2,'Physical order','fixture@example.test','Synthetic order evidence','processed') RETURNING id",
    [session.householdId, randomToken()],
  );
  await query(
    "INSERT INTO shipment_emails(shipment_id,email_id) VALUES($1,$2)",
    [ids[0].id, source.id],
  );
  const [ignored] = await query(
    "INSERT INTO source_emails(household_id,message_key,subject,sender,body_text,status) VALUES($1,$2,'Digital receipt','fixture@example.test','Not a physical delivery','ignored') RETURNING id",
    [session.householdId, randomToken()],
  );
  const reviewIds = [];
  for (const status of ["needs_review", "failed", "queued"]) {
    const [email] = await query(
      "INSERT INTO source_emails(household_id,message_key,subject,sender,body_text,status) VALUES($1,$2,$3,'fixture@example.test','Delivery email',$3) RETURNING id",
      [session.householdId, randomToken(), status],
    );
    reviewIds.push(email.id);
  }
  const nativeInbox = (
    await (await nativeCall("dashboard", undefined, token)).json()
  ).emails;
  const webInbox = (
    await (
      await call("dashboard", undefined, await sessionCookie(session.userId))
    ).json()
  ).emails;
  assert.deepEqual(
    nativeInbox,
    webInbox,
    "Native and web inboxes must use the same filter",
  );
  assert.ok(!nativeInbox.some((e: { id: string }) => e.id === ignored.id));
  for (const id of [source.id, ...reviewIds]) {
    assert.ok(nativeInbox.some((e: { id: string }) => e.id === id));
  }
  assert.equal(
    (
      await query("SELECT status FROM source_emails WHERE id=$1", [ignored.id])
    )[0].status,
    "ignored",
  );
  const linkedEmail = await (
    await nativeCall(`emails/${source.id}`, undefined, token)
  ).json();
  assert.deepEqual(linkedEmail.shipments, [
    { id: ids[0].id, merchant: "Native fixture" },
  ]);
  const target = await (
    await nativeCall(
      "shipments",
      { ...input, merchant: "Retained native fixture" },
      token,
      { "idempotency-key": randomToken() },
    )
  ).json();
  assert.equal(
    (
      await nativeCall(
        `shipments/${ids[0].id}/merge`,
        { targetId: target.id },
        token,
      )
    ).status,
    200,
  );
  const retained = await (
    await nativeCall(`shipments/${target.id}`, undefined, token)
  ).json();
  assert.equal(retained.shipment.merchant, "Retained native fixture");
  assert.ok(retained.emails.some((e: { id: string }) => e.id === source.id));
  const mergedDashboard = await (
    await nativeCall("dashboard", undefined, token)
  ).json();
  assert.ok(
    !mergedDashboard.shipments.some((s: { id: string }) => s.id === ids[0].id),
  );
  assert.deepEqual(
    (await (await nativeCall(`emails/${source.id}`, undefined, token)).json())
      .shipments,
    [{ id: target.id, merchant: "Retained native fixture" }],
  );
  // A membership deleted after session issuance never authorizes another read.
  await query(
    "DELETE FROM household_members WHERE user_id=$1 AND household_id=$2",
    [session.userId, session.householdId],
  );
  assert.equal((await nativeCall("dashboard", undefined, token)).status, 401);
  await query(
    "INSERT INTO household_members(user_id,household_id,role) VALUES($1,$2,'owner')",
    [session.userId, session.householdId],
  );
  assert.equal((await nativeCall("native/auth/logout", {}, token)).status, 200);
  assert.equal((await nativeCall("dashboard", undefined, token)).status, 401);
  const b = await nativeCode();
  const second = await (
    await nativeCall("native/auth/exchange", b.body)
  ).json();
  await query(
    "UPDATE native_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [hash(second.token)],
  );
  assert.equal(
    (await nativeCall("dashboard", undefined, second.token)).status,
    401,
  );
  assert.deepEqual(
    await query("SELECT * FROM google_connections ORDER BY household_id"),
    connectionsBefore,
  );
  assert.deepEqual(
    await query("SELECT * FROM gmail_connections ORDER BY user_id"),
    gmailBefore,
  );
});

test("native Calendar consent is browser-bound, scoped, retry-safe and independent of Gmail", async () => {
  const login = await nativeCode();
  const session = await (
    await nativeCall("native/auth/exchange", login.body)
  ).json();
  const gmailBefore = await query(
    "SELECT * FROM gmail_connections ORDER BY user_id",
  );
  async function begin() {
    const appState = randomToken();
    const start = await nativeCall(
      "native/calendar/start",
      { state: appState },
      session.token,
      { "x-doorstep-household": session.householdId },
    );
    assert.equal(start.status, 200);
    const launch = new URL((await start.json()).url);
    const path = launch.pathname.replace("/api/", "") + launch.search;
    const opened = await nativeCall(path);
    assert.equal(opened.status, 307);
    const consent = new URL(opened.headers.get("location")!);
    assert.equal(
      consent.searchParams.get("scope"),
      "https://www.googleapis.com/auth/calendar.app.created",
    );
    assert.equal(
      consent.searchParams.get("redirect_uri"),
      appUrl + "/api/google/callback",
    );
    assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      (await nativeCall(path)).status,
      400,
      "Launch links are single-use",
    );
    const state = consent.searchParams.get("state")!;
    const [saved] = await query(
      "SELECT verifier FROM oauth_states WHERE state_hash=$1",
      [hash(state)],
    );
    return {
      appState,
      state,
      verifier: decrypt(saved.verifier),
      cookie: opened.headers.get("set-cookie")!.split(";")[0],
    };
  }
  const authFetch = globalThis.fetch;
  let expectedVerifier = "",
    exchanges = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      exchanges++;
      const params = new URLSearchParams(options?.body as URLSearchParams);
      assert.equal(params.get("redirect_uri"), appUrl + "/api/google/callback");
      assert.equal(params.get("code_verifier"), expectedVerifier);
      return Response.json({
        access_token: "calendar-access",
        refresh_token: "calendar-refresh",
        scope: "https://www.googleapis.com/auth/calendar.app.created",
      });
    }
    throw new Error("Unexpected Calendar provider request");
  };
  try {
    const attempt = await begin();
    expectedVerifier = attempt.verifier;
    const callback = `google/callback?state=${attempt.state}&code=fixture-calendar`;
    assert.equal((await nativeCall(callback)).status, 403);
    assert.equal(exchanges, 0);
    const connected = await nativeCall(callback, undefined, undefined, {
      cookie: attempt.cookie,
    });
    assert.equal(connected.status, 307);
    const returned = new URL(connected.headers.get("location")!);
    assert.equal(returned.protocol, "com.jimgreco.doorstep:");
    assert.equal(returned.pathname, "/calendar/callback");
    assert.equal(returned.searchParams.get("state"), attempt.appState);
    assert.equal(returned.searchParams.get("result"), "connected");
    assert.ok(!returned.searchParams.has("code"));
    assert.equal(exchanges, 1);
    assert.notEqual(
      (
        await nativeCall(callback, undefined, undefined, {
          cookie: attempt.cookie,
        })
      ).status,
      307,
    );
    assert.equal(exchanges, 1);
    let [connection] = await query(
      "SELECT * FROM google_connections WHERE household_id=$1",
      [session.householdId],
    );
    assert.equal(decrypt(connection.refresh_token), "calendar-refresh");
    assert.equal(
      (await nativeCall("native/calendar/sync", {}, session.token)).status,
      200,
    );
    const cancelled = await begin();
    const denied = await nativeCall(
      `google/callback?state=${cancelled.state}&error=access_denied`,
      undefined,
      undefined,
      { cookie: cancelled.cookie },
    );
    assert.equal(
      new URL(denied.headers.get("location")!).searchParams.get("result"),
      "cancelled",
    );
    assert.equal(exchanges, 1);
    assert.equal(
      (
        await query("SELECT * FROM google_connections WHERE household_id=$1", [
          session.householdId,
        ])
      ).length,
      1,
    );
    const pending = await begin();
    assert.equal(
      (await nativeCall("native/calendar/disconnect", {}, session.token))
        .status,
      200,
    );
    assert.equal(
      (
        await query("SELECT * FROM google_connections WHERE household_id=$1", [
          session.householdId,
        ])
      ).length,
      0,
    );
    assert.notEqual(
      (
        await nativeCall(
          `google/callback?state=${pending.state}&code=fixture`,
          undefined,
          undefined,
          { cookie: pending.cookie },
        )
      ).status,
      307,
    );
    assert.equal(exchanges, 1, "Disconnect invalidates unfinished consent");
    assert.equal(
      (await nativeCall("native/calendar/sync", {}, session.token)).status,
      400,
    );
    assert.equal(
      (await nativeCall("gmail/connect", {}, session.token)).status,
      403,
    );
    assert.deepEqual(
      await query("SELECT * FROM gmail_connections ORDER BY user_id"),
      gmailBefore,
    );
    const expired = await begin();
    await query(
      "UPDATE native_calendar_attempts SET expires_at=now()-interval '1 second' WHERE session_hash=$1",
      [hash(session.token)],
    );
    assert.equal(
      (
        await nativeCall(
          `google/callback?state=${expired.state}&code=fixture`,
          undefined,
          undefined,
          { cookie: expired.cookie },
        )
      ).status,
      400,
    );
    const revoked = await begin();
    await nativeCall("native/auth/logout", {}, session.token);
    assert.notEqual(
      (
        await nativeCall(
          `google/callback?state=${revoked.state}&code=fixture`,
          undefined,
          undefined,
          { cookie: revoked.cookie },
        )
      ).status,
      307,
    );
    assert.equal(exchanges, 1);
  } finally {
    globalThis.fetch = authFetch;
  }
});
