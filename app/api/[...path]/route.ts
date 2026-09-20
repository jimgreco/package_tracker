import {
  nativeCalendarStart,
  nativeCalendarAuthorize,
  nativeCalendarCallback,
  calendarBrowserCookie,
} from "@/lib/native-calendar";
import {
  notificationSettings,
  saveNotificationSettings,
  registerDevice,
  disableDevice,
} from "@/lib/notifications";
import {
  nativeStart,
  nativeAuthorize,
  nativeCallbackAttempt,
  nativeComplete,
  nativeReturn,
  nativeExchange,
  checkNativePublicRequest,
} from "@/lib/native-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query, transaction, enqueue } from "@/lib/db";
import { context, sessionCookie, requireReal } from "@/lib/auth";
import {
  AppError,
  checkOrigin,
  jsonBody,
  origin,
  equal,
  hash,
  randomToken,
  rateLimit,
  configured,
} from "@/lib/security";
import {
  dashboard,
  detail,
  saveManual,
  quickShipmentAction,
  shipments,
  shipment,
  updateHousehold,
} from "@/lib/shipments";
import { calendarFeed } from "@/lib/calendar";
import { postmarkSchema, receiveEmail } from "@/lib/email";
import { trackingWebhook } from "@/lib/tracking";
import { trackingConfigured } from "@/lib/tracking-config";
import { googleStart, googleCallback, disconnectGoogle } from "@/lib/google";
import {
  googleSigninStart,
  googleSigninCallback,
  googleSigninCookie,
  googleSigninConfigured,
} from "@/lib/google-auth";
import { addMember, removeMember, switchHousehold } from "@/lib/households";
import { asset } from "@/lib/storage";
import {
  gmailStart,
  gmailCallback,
  gmailCookie,
  gmailAction,
} from "@/lib/gmail";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = z.uuid();
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
function basic(req: Request, user: string, password: string) {
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  if (!equal(req.headers.get("authorization") || "", expected))
    throw new AppError("Invalid webhook credentials.", 401);
}
async function handle(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const route = path.join("/");
  const method = req.method;
  let requestContext: Awaited<ReturnType<typeof context>> | undefined;
  const json = (value: unknown, status = 200) =>
    NextResponse.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(requestContext
          ? {
              "X-Doorstep-Household": requestContext.householdId,
              "X-Doorstep-User": requestContext.userId,
            }
          : {}),
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      },
    });
  try {
    if (route === "health" && method === "GET") {
      await query("SELECT 1");
      return json({
        status: "ok",
        version: "0.1.0",
        build: process.env.APP_BUILD || "local",
        database: "ready",
      });
    }
    if (route === "webhooks/postmark" && method === "POST") {
      basic(
        req,
        process.env.POSTMARK_WEBHOOK_USER || "postmark",
        configured("POSTMARK_WEBHOOK_PASSWORD"),
      );
      const payload = postmarkSchema.parse(await jsonBody(req, 25_000_000));
      const recipients = payload.OriginalRecipient
        ? [payload.OriginalRecipient]
        : payload.ToFull?.map((r) => r.Email) || [payload.To || ""];
      const domain = configured("INBOUND_DOMAIN").toLowerCase();
      let household;
      for (const email of recipients) {
        const match = email
          .trim()
          .toLowerCase()
          .match(/^packages\+([0-9a-f]{64})@(.+)$/);
        if (match && match[2] === domain) {
          [household] = await query(
            "SELECT id FROM households WHERE forwarding_token=$1 AND is_demo=false",
            [match[1]],
          );
          if (household) break;
        }
      }
      if (!household) throw new AppError("Unknown forwarding address.", 403);
      await rateLimit(`inbound:${household.id}`, 200, 86400);
      return json(
        await receiveEmail(household.id, {
          messageId: payload.MessageID,
          from: payload.From,
          subject: payload.Subject,
          text: payload.TextBody,
          html: payload.HtmlBody,
          sentAt: payload.Date,
          attachments: payload.Attachments,
        }),
      );
    }
    if (route === "webhooks/easypost" && method === "POST") {
      basic(req, "easypost", configured("EASYPOST_WEBHOOK_SECRET"));
      await trackingWebhook(await jsonBody(req, 2_000_000));
      return json({ received: true });
    }
    if (path[0] === "calendar" && path.length === 2 && method === "GET") {
      const token = path[1].replace(/\.ics$/, "");
      if (!/^[0-9a-f]{64}$/.test(token))
        throw new AppError("Calendar not found.", 404);
      const [h] = await query(
        "SELECT id,time_zone FROM households WHERE feed_token=$1",
        [token],
      );
      if (!h) throw new AppError("Calendar not found.", 404);
      const list = await shipments(h.id, true);
      return new Response(calendarFeed(list, origin(), h.time_zone), {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "private, max-age=60",
          "Content-Disposition": 'inline; filename="doorstep.ics"',
          "X-Robots-Tag": "noindex",
        },
      });
    }
    if (
      ["native/auth/start", "native/auth/exchange"].includes(route) &&
      method === "POST"
    ) {
      checkNativePublicRequest(req);
      const input = await jsonBody(req, 4096);
      return json(
        route.endsWith("/start")
          ? await nativeStart(input)
          : await nativeExchange(input),
      );
    }
    if (route === "native/auth/authorize" && method === "GET") {
      const result = await nativeAuthorize(req);
      const response = NextResponse.redirect(result.url);
      response.headers.set("Set-Cookie", result.cookie);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (route === "native/calendar/authorize" && method === "GET") {
      const result = await nativeCalendarAuthorize(req);
      const response = NextResponse.redirect(result.url);
      response.headers.set("Set-Cookie", result.cookie);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (route === "google/callback" && method === "GET") {
      const destination = await nativeCalendarCallback(req);
      if (destination) {
        const response = NextResponse.redirect(destination);
        response.headers.set("Set-Cookie", calendarBrowserCookie());
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("Referrer-Policy", "no-referrer");
        return response;
      }
    }
    if (req.headers.has("authorization")) {
      requestContext = await context(req, false);
      if (!requestContext.nativeSessionHash)
        throw new AppError("Please sign in again.", 401);
      if (["google", "gmail", "auth"].includes(path[0]))
        throw new AppError("Manage connections on the Doorstep website.", 403);
    } else if (method !== "GET") checkOrigin(req);
    if (route === "auth/config" && method === "GET")
      return json({ google: googleSigninConfigured() });
    if (route === "auth/google/start" && method === "POST") {
      const result = await googleSigninStart(req, await jsonBody(req));
      const response = json({ url: result.url });
      response.headers.set("Set-Cookie", result.cookie);
      return response;
    }
    if (route === "auth/google/callback" && method === "GET") {
      let response: NextResponse;
      const nativeAttempt = await nativeCallbackAttempt(req);
      try {
        const result = await googleSigninCallback(req);
        if (nativeAttempt) {
          response = NextResponse.redirect(
            await nativeComplete(
              nativeAttempt.id,
              result.userId,
              nativeAttempt.app_state,
            ),
          );
        } else {
          response = NextResponse.redirect(`${origin()}/`);
          response.headers.append(
            "Set-Cookie",
            await sessionCookie(result.userId),
          );
        }
      } catch (error) {
        const message =
          error instanceof AppError
            ? error.message
            : "Google sign-in could not finish. Please try again.";
        response = NextResponse.redirect(
          nativeAttempt
            ? nativeReturn(nativeAttempt.app_state, { error: "signin_failed" })
            : `${origin()}/?authError=${encodeURIComponent(message)}`,
        );
      }
      response.headers.append("Set-Cookie", googleSigninCookie());
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (route === "auth/logout" && method === "POST") {
      const token = req.headers
        .get("cookie")
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("doorstep_session="))
        ?.slice(17);
      if (token)
        await query("DELETE FROM sessions WHERE token_hash=$1", [hash(token)]);
      return NextResponse.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie":
              "doorstep_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    if (route === "gmail/callback" && method === "GET") {
      let target: string;
      try {
        await gmailCallback(await context(req, false), req);
        target = `${origin()}/?view=settings&gmail=connected`;
      } catch (e) {
        target = `${origin()}/?view=settings&gmailError=${encodeURIComponent(e instanceof AppError ? e.message : "Could not connect Gmail. Please try again.")}`;
      }
      const response = NextResponse.redirect(target);
      response.headers.set("Set-Cookie", gmailCookie());
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    const ctx =
      requestContext ?? (await context(req, route !== "google/callback"));
    requestContext = ctx;
    if (route === "native/auth/logout" && method === "POST") {
      if (!ctx.nativeSessionHash)
        throw new AppError("A native session is required.", 401);
      await query("DELETE FROM native_sessions WHERE token_hash=$1", [
        ctx.nativeSessionHash,
      ]);
      return json({ ok: true });
    }
    if (route === "gmail/connect" && method === "POST") {
      const result = await gmailStart(ctx, await jsonBody(req));
      const response = json({ url: result.url });
      response.headers.set("Set-Cookie", result.cookie);
      return response;
    }
    if (path[0] === "gmail" && path.length === 2 && method === "POST") {
      const action = z
        .enum(["pause", "resume", "disconnect", "sync"])
        .parse(path[1]);
      await gmailAction(ctx, action);
      return json({ ok: true });
    }
    if (
      path[0] === "native" &&
      path[1] === "calendar" &&
      path.length === 3 &&
      method === "POST"
    ) {
      if (!ctx.nativeSessionHash)
        throw new AppError("Use the Doorstep iPhone app.", 403);
      if (path[2] === "start")
        return json(await nativeCalendarStart(ctx, await jsonBody(req, 4096)));
      if (path[2] === "disconnect") {
        await disconnectGoogle(ctx);
        return json({ ok: true });
      }
      if (path[2] === "sync") {
        requireReal(ctx);
        await rateLimit(`calendar-sync:${ctx.householdId}`, 4, 3600);
        const [connection] = await query(
          "SELECT household_id FROM google_connections WHERE household_id=$1",
          [ctx.householdId],
        );
        if (!connection) throw new AppError("Connect Google Calendar first.");
        await enqueue(
          "google_all",
          { householdId: ctx.householdId },
          `native-calendar-sync:${ctx.householdId}:${randomToken()}`,
        );
        return json({ queued: true });
      }
    }
    if (route === "notifications/preferences" && method === "GET")
      return json(await notificationSettings(ctx));
    if (route === "notifications/preferences" && method === "POST") {
      requireReal(ctx);
      return json(
        await saveNotificationSettings(ctx, await jsonBody(req, 4096)),
      );
    }
    if (route === "notifications/device" && method === "POST") {
      requireReal(ctx);
      await rateLimit(`push-device:${ctx.userId}`, 60, 3600);
      await registerDevice(ctx, await jsonBody(req, 4096));
      return json({ ok: true });
    }
    if (route === "notifications/device/disable" && method === "POST") {
      await disableDevice(ctx);
      return json({ ok: true });
    }
    if (route === "dashboard" && method === "GET")
      return json(await dashboard(ctx));
    if (route === "shipments" && method === "POST") {
      await rateLimit(`manual:${ctx.householdId}`, 100, 3600);
      return json(
        {
          id: await saveManual(
            await jsonBody(req),
            ctx,
            undefined,
            req.headers.get("idempotency-key") || undefined,
          ),
        },
        201,
      );
    }
    if (path[0] === "shipments" && path[1]) {
      const id = uuid.parse(path[1]);
      if (path.length === 2 && method === "GET")
        return json(await detail(id, ctx));
      if (path.length === 2 && method === "PATCH")
        return json({ id: await saveManual(await jsonBody(req), ctx, id) });
      if (
        path.length === 3 &&
        ["deliver", "dismiss", "restore", "collect", "uncollect"].includes(
          path[2],
        ) &&
        method === "POST"
      ) {
        await quickShipmentAction(
          id,
          ctx,
          z
            .enum(["deliver", "dismiss", "restore", "collect", "uncollect"])
            .parse(path[2]),
        );
        return json({ ok: true });
      }
      if (path[2] === "refresh" && method === "POST") {
        requireReal(ctx);
        const { row } = await shipment(id, ctx.householdId);
        await rateLimit(`refresh:${id}`, 4, 3600);
        if (!row.tracking_number)
          throw new AppError("Add a tracking number first.");
        if (!trackingConfigured(row.carrier))
          throw new AppError(
            "Tracking is not configured for this carrier.",
            503,
          );
        await enqueue(
          row.tracker_id ? "track_refresh" : "track_register",
          { shipmentId: id, householdId: ctx.householdId },
          `manual-refresh:${id}:${randomToken()}`,
        );
        return json({ queued: true });
      }
      if (path[2] === "merge" && method === "POST") {
        const { targetId } = z
          .object({ targetId: uuid })
          .parse(await jsonBody(req));
        if (targetId === id) throw new AppError("Choose a different package.");
        await transaction(async (c) => {
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            ctx.householdId,
          ]);
          const rows = (
            await c.query(
              "SELECT * FROM shipments WHERE id=ANY($1::uuid[]) AND household_id=$2 AND archived_at IS NULL FOR UPDATE",
              [[id, targetId], ctx.householdId],
            )
          ).rows;
          if (rows.length !== 2) throw new AppError("Package not found.", 404);
          const source = rows.find((r) => r.id === id)!;
          const target = rows.find((r) => r.id === targetId)!;
          if (source.collected_at && target.status !== "delivered")
            throw new AppError(
              "Keep the delivered package as the merge destination to preserve its collection record.",
            );
          if (source.collected_at && !target.collected_at)
            await c.query(
              "UPDATE shipments SET collected_at=$2,collected_by=$3,collected_by_name=$4 WHERE id=$1",
              [
                targetId,
                source.collected_at,
                source.collected_by,
                source.collected_by_name,
              ],
            );

          await c.query(
            "INSERT INTO shipment_emails(shipment_id,email_id) SELECT $2,email_id FROM shipment_emails WHERE shipment_id=$1 ON CONFLICT DO NOTHING",
            [id, targetId],
          );
          await c.query(
            "INSERT INTO tracking_events(shipment_id,event_key,status,message,location,occurred_at,source) SELECT $2,event_key,status,message,location,occurred_at,source FROM tracking_events WHERE shipment_id=$1 ON CONFLICT DO NOTHING",
            [id, targetId],
          );
          const [archived] = (
            await c.query(
              "UPDATE shipments SET archived_at=now(),status='cancelled',updated_at=now(),version=version+1 WHERE id=$1 RETURNING version",
              [id],
            )
          ).rows;
          if (!ctx.demo)
            await enqueue(
              "google_sync",
              { shipmentId: id, householdId: ctx.householdId },
              `calendar:${id}:${archived.version}`,
              c,
            );
        });
        return json({ id: targetId });
      }
    }
    if (route === "emails" && method === "POST") {
      requireReal(ctx);
      if (!process.env.OPENAI_API_KEY)
        throw new AppError(
          "Connect OpenAI in the server configuration before parsing an email.",
          503,
        );
      await rateLimit(`paste:${ctx.householdId}`, 100, 86400);
      const v = z
        .object({
          subject: z.string().min(1).max(1000),
          text: z.string().min(20).max(100_000),
        })
        .parse(await jsonBody(req, 150_000));
      return json(
        await receiveEmail(ctx.householdId, {
          messageId: "paste:" + hash(v.subject + "\n" + v.text),
          from: ctx.email,
          subject: v.subject,
          text: v.text,
          html: "",
        }),
        202,
      );
    }
    if (path[0] === "emails" && path[1]) {
      const id = uuid.parse(path[1]);
      const [email] = await query(
        "SELECT * FROM source_emails WHERE id=$1 AND household_id=$2",
        [id, ctx.householdId],
      );
      if (!email) throw new AppError("Email not found.", 404);
      if (path.length === 2 && method === "GET")
        return json({
          id: email.id,
          subject: email.subject,
          from: email.sender,
          text: email.body_text,
          receivedAt: email.received_at,
          sentAt: email.sent_at,
          status: email.status,
          error: email.error,
          extraction: email.extraction,
          shipments: await query(
            "SELECT s.id,o.merchant FROM shipment_emails se JOIN shipments s ON s.id=se.shipment_id JOIN orders o ON o.id=s.order_id WHERE se.email_id=$1 AND s.household_id=$2 AND s.archived_at IS NULL ORDER BY s.created_at DESC",
            [id, ctx.householdId],
          ),
        });
      if (path[2] === "retry" && method === "POST") {
        requireReal(ctx);
        if (!process.env.OPENAI_API_KEY)
          throw new AppError("OpenAI is not configured.", 503);
        if (email.status === "processed") return json({ ok: true });
        await query(
          "UPDATE source_emails SET status='queued',error=NULL WHERE id=$1",
          [id],
        );
        await query(
          "UPDATE jobs SET status='pending',attempts=0,run_at=now(),locked_at=NULL WHERE dedupe_key=$1 AND status<>'running'",
          [`email:${id}`],
        );
        return json({ queued: true });
      }
    }
    if (route === "settings" && method === "PATCH") {
      await updateHousehold(
        ctx,
        z
          .object({ name: z.string(), timeZone: z.string() })
          .parse(await jsonBody(req)),
      );
      return json({ ok: true });
    }
    if (route === "settings/members" && method === "POST") {
      await addMember(ctx, await jsonBody(req));
      return json({ ok: true });
    }
    if (route === "settings/members/remove" && method === "POST") {
      await removeMember(ctx, await jsonBody(req));
      return json({ ok: true });
    }
    if (route === "settings/household-switch" && method === "POST") {
      await switchHousehold(ctx, await jsonBody(req));
      return json({ ok: true });
    }
    if (route === "settings/rotate-feed" && method === "POST") {
      const token = randomToken();
      await query("UPDATE households SET feed_token=$1 WHERE id=$2", [
        token,
        ctx.householdId,
      ]);
      return json({ url: `${origin()}/api/calendar/${token}.ics` });
    }
    if (route === "settings/export" && method === "GET")
      return new Response(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            household: { name: ctx.householdName, timeZone: ctx.timeZone },
            shipments: await shipments(ctx.householdId),
            notificationPreferences: await notificationSettings(ctx),
            emails: await query(
              "SELECT subject,sender,sent_at,body_text,extraction FROM source_emails WHERE household_id=$1",
              [ctx.householdId],
            ),
          },
          null,
          2,
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "X-Doorstep-Household": ctx.householdId,
            "X-Doorstep-User": ctx.userId,
            "Content-Disposition":
              'attachment; filename="doorstep-export.json"',
            "Cache-Control": "no-store",
          },
        },
      );
    if (route === "settings/retry-jobs" && method === "POST") {
      requireReal(ctx);
      await query(
        "UPDATE jobs SET status='pending',attempts=0,run_at=now(),error=NULL WHERE status='dead' AND payload->>'householdId'=$1",
        [ctx.householdId],
      );
      return json({ ok: true });
    }
    if (route === "google/connect" && method === "POST")
      return json(await googleStart(ctx));
    if (route === "google/callback" && method === "GET") {
      try {
        await googleCallback(ctx, new URL(req.url));
        return NextResponse.redirect(
          `${origin()}/?view=settings&google=connected`,
        );
      } catch (e) {
        const message =
          e instanceof AppError
            ? e.message
            : "Could not connect Google Calendar.";
        return NextResponse.redirect(
          `${origin()}/?view=settings&googleError=${encodeURIComponent(message)}`,
        );
      }
    }
    if (route === "google/disconnect" && method === "POST") {
      await disconnectGoogle(ctx);
      return json({ ok: true });
    }
    if (route === "google/sync" && method === "POST") {
      requireReal(ctx);
      await rateLimit(`google-sync:${ctx.householdId}`, 6, 3600);
      await enqueue(
        "google_all",
        { householdId: ctx.householdId },
        `google-manual:${ctx.householdId}:${randomToken()}`,
      );
      return json({ queued: true });
    }
    if (path[0] === "assets" && path.length === 2 && method === "GET") {
      const image = await asset(uuid.parse(path[1]), ctx.householdId);
      return new Response(new Uint8Array(image.bytes), {
        headers: {
          "Content-Type": image.type,
          "X-Doorstep-Household": ctx.householdId,
          "X-Doorstep-User": ctx.userId,
          "Cache-Control": "private, max-age=3600",
          "Content-Security-Policy": "default-src 'none'",
        },
      });
    }
    throw new AppError("Not found.", 404);
  } catch (e) {
    if (e instanceof z.ZodError)
      return json(
        {
          error: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    if (e instanceof AppError) return json({ error: e.message }, e.status);
    if (
      e instanceof Error &&
      /Delivery|time zone|YYYY-MM-DD|Invalid PlainDate|Invalid time value/.test(
        e.message,
      )
    )
      return json({ error: e.message }, 400);
    console.error(
      `Request ${method} ${path[0]} failed:`,
      e instanceof Error ? e.message : "Unknown error",
    );
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
