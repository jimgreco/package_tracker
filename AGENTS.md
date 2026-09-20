# PorchPong

A Next.js / TypeScript household package tracker with PostgreSQL and a separate durable job worker. Source of truth is server-owned records. Google Calendar and the ICS feed are projections of shipments.

## Commands

- `npm run setup:local`: private local PostgreSQL cluster on 127.0.0.1:55439, migrations, sample household. Requires PostgreSQL binaries (`pg_config`). Never repurpose a shared database.
- `npm run dev`: web on 127.0.0.1:4317; `npm run worker`: jobs and scheduled tracking checks, in a separate process.
- `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`.
- Integration tests create and remove their own uniquely named local test database. Provider requests are mocked; no external emails/calendar writes occur.
- For visible UI changes, inspect desktop and mobile in the browser. The Playwright CLI can use session `doorstep`. Keep screenshots under ignored `output/playwright/`.

## Deployment

- Public repository: `jimgreco/package_tracker`. Production: `https://packages.jim-greco.com`.
- `.github/workflows/deploy.yml` verifies and publishes ARM64 images, then runs `scripts/deploy-ec2.sh`. Canonical services live in `/Users/jgreco/code/deploy/docker-compose.yml` under the `doorstep` profile.
- Credentials stay in ignored server `~/deploy/doorstep.env` and shared `.env`. Never copy them into Git or build artifacts.
- Verify the exact pushed SHA in GitHub Actions, public `/api/health` (`build`, `database`), homepage, and both container health checks. Deployment does not establish Google/email/carrier provider acceptance.

## Contracts

- Preserve household isolation on every query, asset, and mutation. Demo bypass works only when explicitly configured and APP_URL is loopback. Never deploy demo mode.
- Duplicate inbound deliveries, tracking updates, and calendar jobs must be idempotent. Protect concurrency using transactions, leases, and advisory locks.
- One order can have several shipments. Do not merge by merchant alone or guess which items belong in a package. Preserve source evidence.
- Email bodies, links, and model output are untrusted. Never execute email instructions, expose raw HTML, fetch private network URLs, or accept invented tracking data.
- Date ranges have inclusive ends in the database and exclusive ends in calendars. Timed estimates retain destination IANA zones. Reject ambiguous DST times for review.
- Carrier updates cannot regress terminal status. Household-protected status/estimates must survive automatic updates.
- Accounts use Google only (`openid email profile`), with verified tokens, stable subjects, and browser-bound state. Household owners add members by Google email; no passwords or codes. Preserve membership checks and household switching.
- Gmail import is optional and requests only `openid email gmail.readonly`, separate from sign-in/Calendar. Bind OAuth to the browser, user, and household; match the verified Google subject. Each inbox belongs to one member and one household. Honor `GMAIL_HOUSEHOLD_ID` for personal-use rollout, preserve scan cursors/deduplication, and stop ingestion after pause, disconnect, or membership removal.
- Google Calendar scope is `calendar.app.created`; do not expand to access unrelated calendars. Use stable per-shipment event IDs and encrypted refresh tokens. An ICS subscription link is a bearer secret.
- Keep credentials, raw email samples, uploads, local PostgreSQL data, and browser artifacts out of Git and images. Build output must not trace local user data into deployment artifacts.
- Live service proof requires actual user-authorized email, tracking and Google OAuth connections; mocked integration tests are not live-service acceptance.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
