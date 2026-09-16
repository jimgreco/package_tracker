import { z } from "zod";
import { AppError, hash } from "./security";
import { instant, normalizeEstimate } from "./calendar";
import type { Estimate, Status } from "./types";
import type { Tracker } from "./tracking";

const base = "https://apis.fedex.com";
let cached: { key: string; value: string; expires: number } | undefined;
let pending: { key: string; promise: Promise<string> } | undefined;

async function request(path: string, init: RequestInit) {
  try {
    return await fetch(base + path, {
      ...init,
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
    });
  } catch {
    throw new AppError("FedEx could not be reached. We will retry.", 503);
  }
}
async function accessToken() {
  const client_id = process.env.FEDEX_CLIENT_ID;
  const client_secret = process.env.FEDEX_CLIENT_SECRET;
  if (!client_id || !client_secret)
    throw new AppError("Direct FedEx tracking is not configured.", 503);
  const key = hash(`${client_id}:${client_secret}`);
  if (cached?.key === key && cached.expires > Date.now()) return cached.value;
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    const response = await request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id,
        client_secret,
      }),
    });
    if (!response.ok)
      throw new AppError(
        "FedEx authentication failed. Check the production API credentials.",
        503,
      );
    const parsed = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number().positive(),
      })
      .safeParse(await response.json());
    if (!parsed.success)
      throw new AppError(
        "FedEx returned an invalid authentication response.",
        503,
      );
    cached = {
      key,
      value: parsed.data.access_token,
      expires: Date.now() + Math.max(0, parsed.data.expires_in - 60) * 1000,
    };
    return cached.value;
  })();
  pending = { key, promise };
  try {
    return await promise;
  } finally {
    if (pending?.promise === promise) pending = undefined;
  }
}

const location = z.object({
  city: z.string().optional(),
  stateOrProvinceCode: z.string().optional(),
  countryCode: z.string().optional(),
});
const delay = z.object({ status: z.string().optional() });
const resultSchema = z.object({
  trackingNumberInfo: z.object({ trackingNumber: z.string() }).optional(),
  error: z.object({ code: z.string().optional() }).optional(),
  latestStatusDetail: z
    .object({
      code: z.string(),
      derivedCode: z.string().optional(),
      description: z.string().optional(),
      delayDetail: delay.optional(),
    })
    .optional(),
  scanEvents: z
    .array(
      z.object({
        date: z.string(),
        eventType: z.string(),
        eventDescription: z.string().optional(),
        derivedStatusCode: z.string().optional(),
        scanLocation: location.optional(),
        delayDetail: delay.optional(),
      }),
    )
    .default([]),
  dateAndTimes: z
    .array(z.object({ type: z.string(), dateTime: z.string() }))
    .default([]),
  estimatedDeliveryTimeWindow: z
    .object({
      window: z
        .object({ begins: z.string().optional(), ends: z.string().optional() })
        .optional(),
    })
    .optional(),
});
const responseSchema = z.object({
  output: z.object({
    completeTrackResults: z.array(
      z.object({
        trackingNumber: z.string(),
        trackResults: z.array(resultSchema),
      }),
    ),
  }),
});

export function fedexStatus(code: string, delayed = false): Status {
  if (code === "DL") return "delivered";
  if (code === "CA") return "cancelled";
  if (code === "RS") return "return_to_sender";
  if (delayed) return "delayed";
  if (code === "OD") return "out_for_delivery";
  if (code === "OC") return "pre_transit";
  if (["HL", "HP"].includes(code)) return "available_for_pickup";
  if (["DE", "SE", "CD"].includes(code)) return "failure";
  if (["IT", "PU", "AR", "DP", "AF", "IP", "IX"].includes(code))
    return "in_transit";
  return "unknown";
}

function timestamp(value: string, zone?: string) {
  // Scan locations may be in other zones. Never interpret an offset-free scan in the server's zone.
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    (!zone && !/(Z|[+-]\d\d:\d\d)$/.test(value))
  )
    return null;
  try {
    return instant(value, zone || "UTC").toString();
  } catch {
    return null;
  }
}

export function parseFedex(
  data: unknown,
  trackingNumber: string,
  timeZone: string,
  checkedAt = new Date().toISOString(),
) {
  const parsed = responseSchema.safeParse(data);
  if (!parsed.success)
    throw new AppError(
      "FedEx returned an invalid tracking response. We will retry.",
      503,
    );
  const matches = parsed.data.output.completeTrackResults
    .filter((r) => r.trackingNumber === trackingNumber)
    .flatMap((r) => r.trackResults);
  if (matches.length !== 1)
    throw new AppError(
      "FedEx returned missing or ambiguous package results. Check the tracking number.",
      503,
    );
  const r = matches[0];
  if (r.error) {
    if (r.error.code === "TRACKING.AUTHENTICATEDDELIVERY.ERROR")
      throw new AppError(
        "FedEx requires secure website tracking for this package. Email updates remain available.",
        422,
      );
    throw new AppError(
      "FedEx has no tracking details for this package yet. We will retry.",
      503,
    );
  }
  if (
    r.trackingNumberInfo?.trackingNumber !== trackingNumber ||
    !r.latestStatusDetail
  )
    throw new AppError(
      "FedEx did not return the requested package. We will retry.",
      503,
    );
  const latest = r.latestStatusDetail;
  const history: Tracker["tracking_details"] = r.scanEvents.flatMap((e) => {
    const at = timestamp(e.date);
    return at
      ? [
          {
            datetime: at,
            status: fedexStatus(
              e.derivedStatusCode || e.eventType,
              e.delayDetail?.status === "DELAYED",
            ),
            message: e.eventDescription?.slice(0, 1500),
            source: "FedEx",
            tracking_location: {
              city: e.scanLocation?.city,
              state: e.scanLocation?.stateOrProvinceCode,
              country: e.scanLocation?.countryCode,
            },
          },
        ]
      : [];
  });
  const status = fedexStatus(
    latest.derivedCode || latest.code,
    latest.delayDetail?.status === "DELAYED",
  );
  const delivered = r.dateAndTimes.find((d) => d.type === "ACTUAL_DELIVERY");
  const deliveredAt = delivered && timestamp(delivered.dateTime, timeZone);
  if (
    status === "delivered" &&
    deliveredAt &&
    !history.some((e) => e.status === "delivered" && e.datetime === deliveredAt)
  )
    history.push({
      datetime: deliveredAt,
      status: "delivered",
      message: "Delivered",
      source: "FedEx",
    });
  let estimate: Estimate | null = null;
  let reviewReason: string | null =
    status === "unknown"
      ? "FedEx returned an unfamiliar delivery status."
      : null;
  const window = r.estimatedDeliveryTimeWindow?.window;
  const date = r.dateAndTimes.find(
    (d) => d.type === "ESTIMATED_DELIVERY",
  )?.dateTime;
  try {
    if (window?.begins && window.ends) {
      const datesOnly =
        /^\d{4}-\d{2}-\d{2}$/.test(window.begins) &&
        /^\d{4}-\d{2}-\d{2}$/.test(window.ends);
      estimate = normalizeEstimate({
        kind: datesOnly
          ? window.begins === window.ends
            ? "date"
            : "date_range"
          : "window",
        start: window.begins,
        end: window.ends,
        timeZone,
        label: "Estimated by FedEx",
      });
    } else if (date) {
      estimate = normalizeEstimate({
        kind: "date",
        start: date.slice(0, 10),
        end: null,
        timeZone,
        label: "Estimated by FedEx",
      });
    }
  } catch {
    reviewReason = "FedEx delivery date or time zone needs confirmation.";
  }
  const tracker: Tracker = {
    id: `fedex:${hash(trackingNumber)}`,
    tracking_code: trackingNumber,
    carrier: "FedEx",
    status,
    updated_at: checkedAt,
    tracking_details: history,
  };
  return { tracker, estimate, reviewReason };
}

export async function fetchFedex(trackingNumber: string, timeZone: string) {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    response = await request("/track/v1/trackingnumbers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-locale": "en_US",
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      }),
    });
    if (response.status !== 401 || attempt) break;
    cached = undefined;
  }
  if (!response.ok)
    throw new AppError(
      response.status === 429
        ? "FedEx rate limit reached. We will retry."
        : "FedEx tracking request failed. We will retry.",
      503,
    );
  return parseFedex(await response.json(), trackingNumber, timeZone);
}
