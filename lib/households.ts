import { z } from "zod";
import { query, transaction } from "./db";
import { requireReal, type Context } from "./auth";
import { AppError, randomToken, rateLimit } from "./security";
import type { PoolClient } from "pg";
async function requireOwner(ctx: Context, c: PoolClient) {
  requireReal(ctx);
  const [membership] = (
    await c.query(
      "SELECT role FROM household_members WHERE household_id=$1 AND user_id=$2 FOR UPDATE",
      [ctx.householdId, ctx.userId],
    )
  ).rows;
  if (membership?.role !== "owner")
    throw new AppError("Only the household owner can manage members.", 403);
}
export async function addMember(ctx: Context, input: unknown) {
  const { email } = z
    .object({
      email: z
        .email()
        .max(250)
        .transform((v) => v.toLowerCase()),
    })
    .parse(input);
  await rateLimit(`members:${ctx.householdId}`, 30, 3600);
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4317004)");
    await requireOwner(ctx, c);
    const [member] = (
      await c.query(
        "SELECT u.id FROM household_members m JOIN users u ON u.id=m.user_id WHERE m.household_id=$1 AND COALESCE(u.google_email,u.email)=$2",
        [ctx.householdId, email],
      )
    ).rows;
    if (member)
      throw new AppError("This person is already a household member.", 409);
    await c.query(
      "INSERT INTO household_invitations(household_id,email,added_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [ctx.householdId, email, ctx.userId],
    );
  });
}
export async function removeMember(ctx: Context, input: unknown) {
  const value = z
    .union([
      z.object({ userId: z.uuid() }),
      z.object({
        email: z
          .email()
          .max(250)
          .transform((v) => v.toLowerCase()),
      }),
    ])
    .parse(input);
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4317004)");
    await requireOwner(ctx, c);
    if ("email" in value) {
      await c.query(
        "DELETE FROM household_invitations WHERE household_id=$1 AND email=$2",
        [ctx.householdId, value.email],
      );
      return;
    }
    const [member] = (
      await c.query(
        "SELECT m.role,u.name,u.household_id FROM household_members m JOIN users u ON u.id=m.user_id WHERE m.household_id=$1 AND m.user_id=$2 FOR UPDATE OF m,u",
        [ctx.householdId, value.userId],
      )
    ).rows;
    if (!member) throw new AppError("Household member not found.", 404);
    if (member.role === "owner")
      throw new AppError("The household owner cannot be removed.");
    await c.query(
      "DELETE FROM household_members WHERE household_id=$1 AND user_id=$2",
      [ctx.householdId, value.userId],
    );
    if (member.household_id === ctx.householdId) {
      let [next] = (
        await c.query(
          "SELECT household_id FROM household_members WHERE user_id=$1 ORDER BY joined_at LIMIT 1",
          [value.userId],
        )
      ).rows;
      if (!next) {
        const [home] = (
          await c.query(
            "INSERT INTO households(name,forwarding_token,feed_token) VALUES($1,$2,$3) RETURNING id",
            [
              `${member.name.split(" ")[0]}’s household`,
              randomToken(),
              randomToken(),
            ],
          )
        ).rows;
        await c.query(
          "INSERT INTO household_members(household_id,user_id,role) VALUES($1,$2,'owner')",
          [home.id, value.userId],
        );
        next = { household_id: home.id };
      }
      await c.query("UPDATE users SET household_id=$2 WHERE id=$1", [
        value.userId,
        next.household_id,
      ]);
    }
  });
}
export async function switchHousehold(ctx: Context, input: unknown) {
  requireReal(ctx);
  const { householdId } = z.object({ householdId: z.uuid() }).parse(input);
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4317004)");
    const [updated] = (
      await c.query(
        "UPDATE users u SET household_id=$2 WHERE u.id=$1 AND EXISTS(SELECT 1 FROM household_members WHERE user_id=u.id AND household_id=$2) RETURNING id",
        [ctx.userId, householdId],
      )
    ).rows;
    if (!updated)
      throw new AppError("You do not belong to this household.", 403);
  });
}
