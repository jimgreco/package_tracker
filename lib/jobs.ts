import { query, enqueue, transaction } from "./db";
import { extractEmail } from "./email";
import {
  registerTracking,
  refreshTracking,
  applyTracker,
  trackerSchema,
} from "./tracking";
import { syncShipment, syncAll } from "./google";
import { gmailConfigured, syncGmail } from "./gmail";
import { randomUUID } from "node:crypto";
type Job = {
  id: string;
  kind: string;
  payload: {
    emailId?: string;
    connectionId?: string;
    generation?: string;
    shipmentId?: string;
    householdId: string;
    tracker?: unknown;
  };
  attempts: number;
  lease_token: string;
};
export async function claimJob(): Promise<Job | undefined> {
  const [job] = await query(
    `UPDATE jobs SET status='running',locked_at=now(),lease_token=$1,attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE (status='pending' AND run_at<=now()) OR (status='running' AND locked_at<now()-interval '5 minutes') ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [randomUUID()],
  );
  return job as Job | undefined;
}
export async function runOne() {
  const job = await claimJob();
  if (!job) return false;
  try {
    switch (job.kind) {
      case "gmail_sync":
        await syncGmail(job.payload.connectionId!, job.payload.generation!);
        break;
      case "parse_email":
        await extractEmail(job.payload.emailId!);
        break;
      case "track_register":
        await registerTracking(job.payload.shipmentId!);
        break;
      case "track_refresh":
        await refreshTracking(job.payload.shipmentId!);
        break;
      case "track_webhook":
        await applyTracker(
          job.payload.shipmentId!,
          trackerSchema.parse(job.payload.tracker),
        );
        break;
      case "google_sync":
        await syncShipment(job.payload.shipmentId!);
        break;
      case "google_all":
        await syncAll(job.payload.householdId);
        break;
      default:
        throw new Error(`Unknown job: ${job.kind}`);
    }
    await query(
      "UPDATE jobs SET status='done',locked_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease_token],
    );
  } catch (e) {
    const message =
      e instanceof Error
        ? e.message.slice(0, 500)
        : "Background processing failed.";
    const dead = job.attempts >= 8;
    const delay =
      Math.min(3600, 15 * 2 ** job.attempts) + Math.floor(Math.random() * 15);
    await query(
      "UPDATE jobs SET status=$2,run_at=now()+$3*interval '1 second',locked_at=NULL,error=$4 WHERE id=$1 AND lease_token=$5",
      [job.id, dead ? "dead" : "pending", delay, message, job.lease_token],
    );
    if (job.payload.emailId)
      await query(
        "UPDATE source_emails SET status='failed',error=$2 WHERE id=$1 AND status NOT IN ('processed','ignored')",
        [job.payload.emailId, message],
      );
    if (job.kind.startsWith("google"))
      await query(
        "UPDATE google_connections SET error=$2 WHERE household_id=$1",
        [job.payload.householdId, message],
      );
    console.warn(
      `Job ${job.kind} ${job.id}: ${dead ? "needs attention" : "will retry"}. ${message}`,
    );
  }
  return true;
}
export async function schedule() {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4317003)");
    await c.query(
      "INSERT INTO service_health(name,last_seen_at) VALUES('worker',now()) ON CONFLICT(name) DO UPDATE SET last_seen_at=now()",
    );
    if (process.env.EASYPOST_API_KEY) {
      const due = (
        await c.query(
          `SELECT id,household_id,tracker_id FROM shipments WHERE is_demo=false AND archived_at IS NULL AND dismissed_at IS NULL AND tracking_number IS NOT NULL AND status NOT IN ('delivered','cancelled','return_to_sender') AND tracking_state<>'unsupported' AND (last_checked_at IS NULL OR last_checked_at<now()-CASE WHEN status='out_for_delivery' THEN interval '15 minutes' ELSE interval '4 hours' END) LIMIT 200`,
        )
      ).rows;
      for (const s of due)
        await enqueue(
          s.tracker_id ? "track_refresh" : "track_register",
          { shipmentId: s.id, householdId: s.household_id },
          `scheduled:${s.id}:${Math.floor(Date.now() / 900_000)}`,
          c,
        );
    }
    if (gmailConfigured()) {
      const due = (
        await c.query(
          `SELECT g.id,g.household_id,g.generation FROM gmail_connections g
        WHERE g.enabled=true AND g.needs_reconnect=false AND g.next_sync_at<=now() AND ($1::uuid IS NULL OR g.household_id=$1)
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='gmail_sync' AND j.payload->>'connectionId'=g.id::text
          AND j.payload->>'generation'=g.generation AND j.status IN ('pending','running')) LIMIT 100`,
          [process.env.GMAIL_HOUSEHOLD_ID || null],
        )
      ).rows;
      for (const g of due)
        await enqueue(
          "gmail_sync",
          {
            connectionId: g.id,
            householdId: g.household_id,
            generation: g.generation,
          },
          `gmail-scheduled:${g.id}:${randomUUID()}`,
          c,
        );
    }
    await c.query("DELETE FROM gmail_oauth_states WHERE expires_at<now()");
    await c.query("DELETE FROM sessions WHERE expires_at<now()");
    await c.query("DELETE FROM oauth_states WHERE expires_at<now()");
    await c.query("DELETE FROM google_signin_states WHERE expires_at<now()");
    await c.query("DELETE FROM rate_limits WHERE expires_at<now()");
    await c.query(
      "DELETE FROM jobs WHERE status='done' AND created_at<now()-interval '30 days'",
    );
  });
}
