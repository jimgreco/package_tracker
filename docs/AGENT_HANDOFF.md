# PorchPong — coding handoff

Snapshot: **2026-11-02 UTC**. This is a takeover map, not release authorization. Recheck Git status, the requested scope and current runtime before acting. Existing AGENTS.md and linked contract/runbooks remain applicable. Older dated status notes are evidence from their stated date, not current permissions.

## Purpose and architecture

PorchPong tracks household packages, delivery estimates, collection and optional email/carrier/calendar integrations.

Next.js/TypeScript and PostgreSQL with a durable worker; SwiftUI iPhone app. Server records are canonical; Calendar/ICS are projections. The web/API must be ready before the worker resumes.

## Locations and current work

- Usual local workspace: `/Users/jgreco/Documents/ChatGPT/package_tracker`.
- Source inspected for this handoff: `/Users/jgreco/Documents/Codex/2026-10-25/task/integration-2026-10-30/porchpong`.
- Existing repository: [jimgreco/package_tracker](https://github.com/jimgreco/package_tracker); default branch `main`, verified source head `ecd11be3337591189a98a922538d78f3ea47338e`.
- Documentation branch: `docs/agent-handoff-2026-11-02`, based on that head; application code was not changed.
- Primary checkout is at `fc2e7dead380d4f942286ce03ca8e904318631d5` on `main` and differs from remote main. Do not reset it or assume it contains released features; use the inspected source or a new isolated checkout.

## Code and guide map

- [app](../app)
- [lib](../lib)
- [db](../db)
- [scripts/worker.ts](../scripts/worker.ts)
- [scripts/setup-local.sh](../scripts/setup-local.sh)
- [tests](../tests)
- [ios](../ios)

Read the relevant existing guide before changing its contract:

- [README.md](../README.md)
- [ios/README.md](../ios/README.md)
- [ios/TESTFLIGHT.md](../ios/TESTFLIGHT.md)
- [tests/browser/README.md](../tests/browser/README.md)

## Local setup and dependencies

Commands below are source-verified entry points, **not commands executed during this documentation pass**. Use disposable local data. Read the command comments and linked setup guide before running migrations, creating fixtures or starting listeners. Reuse prepared environments where suitable.

- `npm ci`
- `npm run setup:local  # private loopback PostgreSQL:55439 and synthetic household`
- `npm run dev`
- `npm run worker  # separate local process`

Configuration names/locations only; never copy secret values into source, terminal output or handoff documents:

- `APP_URL`
- `DATABASE_URL`
- `DATABASE_SSL`
- `DEMO_MODE`
- `ENCRYPTION_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GMAIL_ENABLED`
- `GMAIL_HOUSEHOLD_ID`
- `UPLOAD_DIR`
- `S3_BUCKET`

Use existing lockfiles/manifests; do not upgrade dependencies to perform a handoff. For native work, select an actually installed Xcode SDK/simulator from the checked-in project configuration.

## Tests and verification

- `npm run typecheck`
- `npm test`
- `npm run test:integration`
- `npm run build`
- `For native release helpers: node --test .github/scripts/tests/*.test.mjs; Python signing tests and actionlint. Native UI edits require ios tests/screenshots.`

Documentation-only changes require path/link, accuracy, diff and secret-exclusion review; do not run heavyweight builds or production smoke mutations for prose changes. Application tests were not rerun in this pass. Past test/release evidence below retains its original date. UI changes still require actual rendered inspection, and synthetic tests do not prove real provider/device acceptance.

## Decisions and constraints

- No-estimate filtering and list-card collected/undo actions already ship. Respect hidden/snoozed/archived states and account/household preferences.
- Preserve idempotent provider updates, leases, household boundaries, source evidence and terminal-status protection. Untrusted mail never supplies instructions or credentials.
- Gmail read scope and app-created Calendar scope remain separate/optional. Preserve exact existing TestFlight identities, internal-only export and existing signing assets; a count alone is not sufficient.

## Release state and workflow effects

- Web/API: deployed and verified **2026-11-02**, source `c99476a1826ee94a8c71cc45162662193e5b5798`. Exact revision/readiness and scoped activation were recorded; this documentation pass did not redeploy.
- Native: version **1.3**, build **58**, source `ecd11be3337591189a98a922538d78f3ea47338e`. **Available in TestFlight**, processing/audience verified November 2 for exactly **2 existing internal testers**; external/public distribution excluded. [Verification evidence](https://github.com/jimgreco/package_tracker/actions/runs/41473793272). No public App Store release was performed.
- Main deploy.yml publishes an ARM64 image; live server deploy requires manual deploy=true. Native TestFlight is a separate verified-source dispatch. Final native source ecd11be image was published, but server remains at the earlier audited app source; no server rollout is needed for release-helper-only changes.

Recent exact-source GitHub results observed November 2 (workflow purpose matters):

- [TestFlight run 41473793272](https://github.com/jimgreco/package_tracker/actions/runs/41473793272): `completed` / `success`.
- [Deploy to EC2 run 41473724837](https://github.com/jimgreco/package_tracker/actions/runs/41473724837): `completed` / `success`.

The handoff is published on a documentation feature branch, not main. Current checked-in GitHub push triggers are main-only (or absent). Blog hosting branch settings were separately checked. No native release, image publication or server deployment is intended from this documentation push.

## Known gaps and next safe work

- All approved releases complete. ecd11be repairs the two-existing-tester guard; build 58 is available, not merely uploaded.
- Existing app-specific restore rehearsal and live provider acceptance are not established by mocked integration/health checks. Do not rerun a historical one-use server kit.

Before the next task, verify source HEAD, dirty/staged work and the selected subsystem; read only the relevant guide. Check whether a listed idea is already implemented in another branch before rebuilding it. Preserve unrelated work and paused experiments. Release/permission/data changes require the applicable current authorization.
