import { pool, query } from "../lib/db";
try {
  const [row] = await query(
    "SELECT last_seen_at>now()-interval '3 minutes' AS healthy FROM service_health WHERE name='worker'",
  );
  if (!row?.healthy) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool().end();
}
