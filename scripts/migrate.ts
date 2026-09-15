import { readFile, readdir } from "node:fs/promises";
import { pool, transaction } from "../lib/db";
await transaction(async (c) => {
  await c.query("SELECT pg_advisory_xact_lock(4317001)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("db"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    if (
      (await c.query("SELECT 1 FROM migrations WHERE name=$1", [name])).rowCount
    )
      continue;
    await c.query(await readFile(`db/${name}`, "utf8"));
    await c.query("INSERT INTO migrations(name) VALUES($1)", [name]);
    console.log(`Applied ${name}`);
  }
});
await pool().end();
