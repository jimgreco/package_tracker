import { query, transaction } from "./db";
import type { Context } from "./auth";
import { AppError } from "./security";

export type Plan = "free" | "paid";

export async function householdPlan(householdId: string): Promise<Plan> {
  const [row] = await query<{ plan: Plan }>(
    "SELECT plan FROM households WHERE id=$1",
    [householdId],
  );
  if (!row) throw new AppError("Household not found.", 404);
  return row.plan;
}

export async function requirePaid(householdId: string) {
  if ((await householdPlan(householdId)) !== "paid")
    throw new AppError(
      "Gmail import and carrier API tracking are available to eligible households. Forward shipping emails for updates on the free plan.",
      403,
    );
}

export async function requireAdmin(ctx: Context) {
  if (ctx.demo) throw new AppError("Admin access required.", 403);
  const [admin] = await query(
    "SELECT 1 FROM users WHERE id=$1 AND google_subject IS NOT NULL AND platform_admin=true",
    [ctx.userId],
  );
  if (!admin) throw new AppError("Admin access required.", 403);
}

export async function adminAccounts(ctx: Context) {
  await requireAdmin(ctx);
  return query<{
    id: string;
    name: string;
    plan: Plan;
    createdAt: string;
    members: { name: string; email: string; role: string }[];
  }>(
    `SELECT h.id,h.name,h.plan,h.created_at AS "createdAt",
      coalesce(jsonb_agg(jsonb_build_object('name',u.name,'email',coalesce(u.google_email,u.email),'role',m.role)
        ORDER BY u.name) FILTER (WHERE u.id IS NOT NULL),'[]'::jsonb) AS members
     FROM households h LEFT JOIN household_members m ON m.household_id=h.id
     LEFT JOIN users u ON u.id=m.user_id WHERE h.is_demo=false
     GROUP BY h.id ORDER BY h.created_at DESC,h.id`,
  );
}

export async function setHouseholdPlan(
  ctx: Context,
  householdId: string,
  plan: Plan,
) {
  await requireAdmin(ctx);
  await transaction(async (c) => {
    const [home] = (
      await c.query(
        "SELECT plan FROM households WHERE id=$1 AND is_demo=false FOR UPDATE",
        [householdId],
      )
    ).rows;
    if (!home) throw new AppError("Account not found.", 404);
    if (home.plan === plan) return;
    await c.query("UPDATE households SET plan=$2 WHERE id=$1", [
      householdId,
      plan,
    ]);
    if (plan === "free") {
      await c.query(
        "UPDATE shipments SET tracking_state='none' WHERE household_id=$1 AND is_demo=false",
        [householdId],
      );
      await c.query(
        "UPDATE gmail_connections SET enabled=false,generation=gen_random_uuid()::text WHERE household_id=$1",
        [householdId],
      );
      await c.query(
        "UPDATE jobs SET status='done',error=NULL WHERE status IN ('pending','dead') AND kind IN ('gmail_sync','track_register','track_refresh','track_webhook') AND payload->>'householdId'=$1",
        [householdId],
      );
    } else {
      await c.query(
        `INSERT INTO jobs(kind,payload,dedupe_key)
         SELECT CASE WHEN s.tracker_id IS NULL THEN 'track_register' ELSE 'track_refresh' END,
           jsonb_build_object('shipmentId',s.id,'householdId',s.household_id),
           'plan-upgrade:'||s.id||':'||gen_random_uuid()::text
         FROM shipments s WHERE s.household_id=$1 AND s.is_demo=false
           AND s.archived_at IS NULL AND s.dismissed_at IS NULL AND s.tracking_number IS NOT NULL
           AND s.status NOT IN ('delivered','cancelled','return_to_sender')`,
        [householdId],
      );
    }
  });
}
