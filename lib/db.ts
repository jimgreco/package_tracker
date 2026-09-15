import pg, { type PoolClient } from "pg";
const globalDb = globalThis as unknown as { doorstepPool?: pg.Pool };
export function pool() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured. Run npm run setup:local.");
  return (globalDb.doorstepPool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: true }
        : undefined,
  }));
}
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
) {
  return (await pool().query<T>(sql, params)).rows;
}
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function enqueue(
  kind: string,
  payload: unknown,
  key: string,
  client?: PoolClient,
  delaySeconds = 0,
) {
  const sql =
    "INSERT INTO jobs(kind,payload,dedupe_key,run_at) VALUES($1,$2,$3,now()+$4*interval '1 second') ON CONFLICT(dedupe_key) DO NOTHING";
  const args = [kind, JSON.stringify(payload), key, delaySeconds];
  if (client) await client.query(sql, args);
  else await query(sql, args);
}
