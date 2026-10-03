import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const build = "1".repeat(40);
const image = `ghcr.io/jimgreco/package_tracker:${build}`;
const previous = `ghcr.io/jimgreco/package_tracker:${"2".repeat(40)}`;
const script = resolve("scripts/deploy-ec2.sh");

function release(failure = "", configured = true) {
  const root = mkdtempSync(join(tmpdir(), "porchpong-deploy-test-"));
  const bin = join(root, "bin");
  const log = join(root, "commands.jsonl");
  mkdirSync(bin);
  mkdirSync(join(root, "deploy"));
  mkdirSync(join(root, "doorstep"));
  const envFile = join(root, "deploy", ".env");
  const original = `# Preserve unrelated effective settings\nOTHER_IMAGE=untouched\nDOORSTEP_IMAGE=${previous}\nDOORSTEP_DB_PASSWORD=${"a".repeat(64)}\nDOORSTEP_ENCRYPTION_KEY=${"b".repeat(64)}\n`;
  if (configured) writeFileSync(envFile, original);
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const tool = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify([tool,...args])+'\\n');
if (tool === 'flock') process.exit(0);
if (tool === 'docker-compose') {
  const action = args[2];
  if (action === 'config' && args.includes('--services')) console.log('doorstep\\ndoorstep-worker');
  if (action === 'ps') console.log(args.at(-1)+'-container');
  const fail = process.env.DEPLOY_TEST_FAILURE;
  if ((fail === 'pull' && action === 'pull') ||
      (fail === 'database' && action === 'run' && args.includes('node')) ||
      (fail === 'migration' && args.includes('scripts/migrate.ts'))) process.exit(1);
}
if (tool === 'docker' && args[0] === 'inspect') {
  if (args[2] === '{{.Config.Image}}') console.log(process.env.DOORSTEP_IMAGE);
  else if (args[2] === '{{.State.Health.Status}}') console.log('healthy');
  else console.log('previous-image-kept');
}
`;
  for (const tool of ["docker", "docker-compose", "flock"])
    writeFileSync(join(bin, tool), fake, { mode: 0o755 });
  try {
    const result = spawnSync("bash", [script, build, image], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_TEST_LOG: log,
        DEPLOY_TEST_FAILURE: failure,
      },
    });
    const commands: string[][] = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const updated = configured ? readFileSync(envFile, "utf8") : "";
    return { result, commands, original, updated };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("deployment preserves rollback images/config and drains only the app before migrating", () => {
  const { result, commands, original, updated } = release();
  assert.equal(result.status, 0, result.stderr);
  const compose = commands.filter((c) => c[0] === "docker-compose").map((c) => c.slice(3));
  const index = (name: string) => compose.findIndex((c) => c.includes(name));
  assert.ok(index("pull") < index("stop"));
  assert.ok(index("node") < index("stop"));
  assert.ok(index("stop") < index("scripts/migrate.ts"));
  assert.ok(index("scripts/migrate.ts") < index("up"));
  assert.deepEqual(compose[index("stop")], ["stop", "--timeout", "120", "doorstep", "doorstep-worker"]);
  assert.deepEqual(compose[index("up")], ["up", "-d", "--no-deps", "--no-build", "doorstep", "doorstep-worker"]);
  assert.ok(commands.every((c) => !c.includes("prune") && !c.includes("rm") && !c.includes("psql")));
  assert.equal(updated.replace(`DOORSTEP_IMAGE=${image}\n`, ""), original.replace(`DOORSTEP_IMAGE=${previous}\n`, ""));
});

for (const failure of ["pull", "database"]) {
  test(`failed ${failure} preflight keeps running services and configuration untouched`, () => {
    const { result, commands, original, updated } = release(failure);
    assert.notEqual(result.status, 0);
    assert.ok(commands.every((c) => !c.includes("stop") && !c.includes("up") && !c.includes("scripts/migrate.ts")));
    assert.equal(updated, original);
  });
}

test("failed migration leaves old processes stopped and does not publish a healthy pin", () => {
  const { result, commands, original, updated } = release("migration");
  assert.notEqual(result.status, 0);
  assert.ok(commands.some((c) => c.includes("stop")));
  assert.ok(commands.every((c) => !c.includes("up")));
  assert.equal(updated, original);
});

test("missing deployment configuration fails without provisioning credentials or services", () => {
  const { result, commands } = release("", false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing deployment .env is required/);
  assert.ok(commands.every((c) => ["flock", "docker-compose"].includes(c[0])));
  assert.ok(commands.filter((c) => c[0] === "docker-compose").every((c) => c[3] === "config"));
});
