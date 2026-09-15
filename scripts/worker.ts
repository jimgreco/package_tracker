import { runOne, schedule } from "../lib/jobs";
import { pool } from "../lib/db";
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});
let lastSchedule = 0;
console.log(
  "Doorstep worker started. Processing durable jobs and checking active shipments.",
);
while (running) {
  try {
    if (Date.now() - lastSchedule > 60_000) {
      await schedule();
      lastSchedule = Date.now();
    }
    if (!(await runOne())) await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    console.error(
      "Worker cycle failed:",
      e instanceof Error ? e.message : "Unknown error",
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await pool().end();
