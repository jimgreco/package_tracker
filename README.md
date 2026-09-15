# Doorstep

A shared household package tracker. Forward a shipping email, review the extracted order and shipments, and follow delivery updates on the web and in Google Calendar (including Apple Calendar through your Google account).

## What is implemented

- Responsive package timeline, search, status filters, manual entry/editing, tracking history, source-email inspection, and duplicate merging.
- Separate household, order, item, shipment, email, and tracking-event records in PostgreSQL.
- Postmark inbound webhook with Basic authentication, private per-household routing, attachment ingestion, durable processing, and retry-safe deduplication.
- OpenAI Responses API extraction with a strict schema, `store: false`, original-message context, evidence, missing-value handling, and review flags. The model cannot browse or call tools.
- Product images from inline attachments or email image references. Remote images are cached through a bounded HTTPS downloader that pins a public IPv4 address and checks redirects. Unavailable images fall back to a shop initial.
- EasyPost external-shipment registration, authenticated webhook updates, carrier history, and scheduled reconciliation. Out-for-delivery checks are scheduled every 15 minutes, other active shipments every 4 hours; actual carrier freshness depends on EasyPost.
- Durable PostgreSQL jobs with transactional enqueueing, independent worker, leases, retry/backoff, and a failed-job retry control.
- Google OAuth with PKCE, one-use state, the `calendar.app.created` scope, encrypted refresh tokens, dedicated delivery calendar, stable shipment event IDs, and queued updates.
- Private revocable ICS feed, date-range handling, timed windows, deadlines, and approximate-time markers.
- Google-only accounts, household members added by email, household switching, protected assets, and data export.

This checkout has no live provider credentials. The local preview uses a separate, explicitly labeled sample household. Automated provider tests use mocked HTTP responses. No real email, shipment or Google calendar has been processed by this installation yet.

## Local preview

Requires Node.js 22+, npm, and PostgreSQL 16 binaries available through `pg_config`. On this Mac those binaries are already installed.

```bash
npm ci
npm run setup:local
npm run dev
```

In another terminal:

```bash
npm run worker
```

Open [Doorstep locally](http://127.0.0.1:4317).

`setup:local` creates an ignored `.env`, random setup/encryption secrets, a dedicated PostgreSQL cluster in `.local/postgres` listening **only on 127.0.0.1:55439**, and the sample household. It does not access a shared PostgreSQL server. Local database authentication uses trust only on this loopback development cluster. Do not expose that cluster remotely.

Running `db:seed` again refreshes only the fixed sample shipment dates. Your own manually added packages are preserved. `DEMO_MODE=true` permits the sample session only when `APP_URL` is loopback. Authenticated real accounts always take precedence over the sample session.

To stop the dedicated local database:

```bash
"$(pg_config --bindir)/pg_ctl" -D .local/postgres stop
```

## Accounts and household members

1. Configure the Google OAuth client below, then choose **Continue with Google**. There are no Doorstep passwords, setup codes, or invite codes.
2. First sign-in creates a private household automatically. If an owner already added your Google email, you join their household instead.
3. In **Settings → Household members**, the owner enters another member’s Gmail or Google Workspace email. The pending membership becomes active when that person signs in with their own Google account. Doorstep does not send an invitation email.
4. Existing users retain their household and gain access to the shared household on their next sign-in. Choose the current household in **Settings → Your account**. Package data stays separate.
5. The owner can cancel pending members or remove joined members. Removed members lose access and return to another household they belong to, or a new empty personal household. The owner cannot remove themselves.

Personal accounts support verified Google identities. Automatic shared access by email requires Gmail or a Google Workspace identity (`hd` in the signed ID token), where Google is authoritative for email ownership. Other third-party email identities cannot claim a shared membership just by matching an email address. Google’s stable `sub` identifies returning accounts even if their email changes.

The sample household stays separate. Set `DEMO_MODE=false` beyond the local preview. Legacy password sign-in routes and stored password hashes are removed by the migration. Existing account records are preserved; a matching authoritative Google identity can establish their Google sign-in.

## Connect the services

Use `.env.example` as the configuration reference. Restart both the web process and worker after changes. Store real credentials in your hosting environment or secret manager, never in Git. `APP_URL` must be the exact browser origin (scheme, host, and port); production must use HTTPS.

### 1. OpenAI

Set `OPENAI_API_KEY`. `OPENAI_MODEL` defaults to `gpt-4.1-mini` and can be set to another Responses API model supporting Structured Outputs. Email text, links, and product image references are submitted for extraction; raw source email is retained in your PostgreSQL database for review. This implementation uses text extraction, not OCR for screenshot-only or PDF-only notices.

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

### 2. Postmark inbound email

1. Configure an inbound message stream and a dedicated forwarding subdomain, for example `inbound.example.com`, following Postmark's DNS instructions.
2. Set `INBOUND_DOMAIN` to that domain, `POSTMARK_WEBHOOK_USER`, and a random `POSTMARK_WEBHOOK_PASSWORD`.
3. Set the stream's inbound webhook URL to:
   `https://USERNAME:PASSWORD@YOUR_HOST/api/webhooks/postmark`
4. Use HTTP Basic authentication over HTTPS. If supported by your deployment edge, also allowlist Postmark's published webhook IP ranges. This app does not trust client-supplied forwarding headers for IP authentication.
5. Copy the address in Doorstep Settings and forward a real shipping email. The server routes by the envelope recipient's private `packages+TOKEN` alias and configured domain.

Message content is saved before its parse job is acknowledged. Duplicate webhook deliveries return the existing email. Non-image attachments are ignored in v1; supported inline images are JPEG, PNG, WebP, and GIF, up to 5 MB each. Total webhook input is bounded at 25 MB. HTML is never rendered in the application.

- [Postmark inbound parsing](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email)
- [Webhook authentication](https://postmarkapp.com/developer/webhooks/webhooks-overview)

### 3. EasyPost

1. Set `EASYPOST_API_KEY` to the appropriate test or production key.
2. Choose a random `EASYPOST_WEBHOOK_SECRET` used here as the Basic authentication password.
3. Register this webhook in the matching EasyPost mode:
   `https://easypost:SECRET@YOUR_HOST/api/webhooks/easypost`
4. Keep the worker running. Adding a tracking number queues registration; supported active shipments are reconciled on the schedule described above.

This implementation uses EasyPost's documented **Basic authentication** option, not its HMAC option. Provider carrier coverage and data completeness vary. Unsupported trackers remain visible with their source link. A provider failure is displayed separately from the parcel's delivery status. Carrier timestamps cannot regress a completed delivery; protected manual estimates remain unchanged.

- [Track existing shipments](https://docs.easypost.com/guides/tracking-guide)
- [Webhook authentication](https://docs.easypost.com/guides/webhooks-guide)

### 4. Google sign-in and Calendar

1. Create a Google Cloud project, enable the Calendar API, configure the OAuth consent screen, and create a **Web application** OAuth client.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a 64-character hexadecimal `ENCRYPTION_KEY`. The local setup generates that encryption key. Preserve it when migrating the database; losing it makes stored refresh tokens unreadable.
3. Register **both** exact redirect URIs on that Web application client:
   - Sign-in: `APP_URL/api/auth/google/callback` (local: `http://127.0.0.1:4317/api/auth/google/callback`).
   - Calendar: `APP_URL/api/google/callback` (local: `http://127.0.0.1:4317/api/google/callback`).
     Use the same hostname as `APP_URL` when opening the app. Restart the web process after changing credentials.
4. While the OAuth app is in Testing, add your account as a test user. Google's testing-mode refresh-token expiration can require reconnecting. Complete the applicable Google production/verification steps before relying on continuous use.
5. Sign in to your real household and select **Connect Google Calendar**.

Sign-in requests only `openid email profile`. It uses authorization code flow with PKCE, browser-bound one-use state, a nonce, and server-side signed ID-token validation (Google keys, issuer, audience, expiry, authorized party, nonce, and verified email). Identity access tokens are not persisted. Sessions are HttpOnly, SameSite=Lax, and Secure on HTTPS.

The separate Calendar connection requests only `https://www.googleapis.com/auth/calendar.app.created`. It creates **Package Deliveries** and manages that calendar's events. It does not request access to unrelated calendars. The worker creates/updates events after changes; a disconnected or expired account shows a reconnection message. Disconnecting deletes Doorstep's stored credentials and leaves the existing calendar in your Google account. Reconnecting to the same calendar must use its owning account. Switching accounts requires disconnecting first and creates a new delivery calendar.

To see it in Apple Calendar, add your Google account and enable **Package Deliveries**. Other calendars may need enabling on Google's Calendar sync selection page. Apple has its own refresh schedule; neither this app nor a successful Google API write guarantees instant visibility on a physical device.

- [Google sign-in protocol](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google ID-token validation and email ownership](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google-to-Apple calendar sync](https://support.google.com/calendar/answer/99358)

### Calendar behavior

- One shipment = one calendar event. ETA changes update the same event.
- Dates and inclusive date ranges become all-day events; their calendar end is exclusive.
- Exact windows use both supplied times and the destination IANA time zone.
- A single approximate time uses an explicitly described one-minute marker. It does not imply a delivery window.
- “By 8 PM” is an all-day event with the deadline in the description.
- No estimate means no event. Clearing an estimate removes a previously synced event.
- Delivered packages use the actual local delivery date when known. Completed deliveries remain as history.
- Cancelled or merged-away shipments remove their Google events; the ICS feed retains a cancelled event with the same UID so subscribed clients can reconcile.
- A restored event after deletion receives a new provider ID; normal ETA edits preserve the ID.
- Events show as free and do not create calendar invitations or attendees.
- Subscription URLs are unguessable bearer secrets and can be replaced in Settings. Add a feed in Google using **Other calendars → From URL**, not a one-time file import. Feed refresh timing is controlled by Google.

### Image storage

Local development and single-host deployments can use the private `UPLOAD_DIR` directory. The web process and worker must share it. For S3-compatible storage, configure `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, and either server IAM credentials or the `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` pair. Keep the bucket private; images are streamed only after household authentication. Do not change the storage backend without migrating existing objects.

## Run on a server

The app requires a continuously running web process, worker, PostgreSQL, HTTPS termination, and durable image storage. The Docker Compose configuration provides the first three plus shared persistent volumes; supply an HTTPS reverse proxy such as Caddy or your hosting platform's ingress.

1. Create `.env` from `.env.example` and configure a public HTTPS `APP_URL` and service credentials.
2. Set `POSTGRES_PASSWORD` to a long random hexadecimal value and `ENCRYPTION_KEY` to 32 random bytes encoded as hex. Use `openssl rand -hex 32` for each.
3. Run `docker compose up --build -d`.
4. The migration container runs before web/worker start. Both application containers connect to the private Compose database and share the uploads volume. Demo access is explicitly disabled.
5. Terminate HTTPS and proxy to `127.0.0.1:4317`. Preserve the original `Origin` header. Permit inbound payloads up to the application's configured 25 MB limit.
6. Verify `/api/health` and the worker status in Settings, then run the live acceptance checks below. Back up PostgreSQL and object storage; do not use disposable volumes for user data.

### Consolidated EC2 deployment

Production URL: `https://packages.jim-greco.com`. The public application repository is `jimgreco/package_tracker`; infrastructure is managed by `jimgreco/consolidated-deploy`.

Pushes to `main` run `.github/workflows/deploy.yml`: TypeScript, unit and isolated PostgreSQL integration tests, production build, ARM64 image publication, migrations, and scoped deployment through the canonical consolidated Compose file. Both containers must become healthy and the public `/api/health` must return the pushed commit before the workflow succeeds. Pull requests run verification only.

Repository deployment secrets: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`, and `EC2_KNOWN_HOSTS` (the trusted server host-key entry). Application credentials stay in `~/deploy/doorstep.env` on EC2; they are never copied into the image or public repository. Use `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`, and the receiving/tracking variables from `.env.example`. Google redirects for production are:

- `https://packages.jim-greco.com/api/auth/google/callback`
- `https://packages.jim-greco.com/api/google/callback`

The `doorstep` Compose profile keeps application release pins separate from unrelated infrastructure pushes. `scripts/deploy-ec2.sh` generates database/encryption secrets once, creates the dedicated `doorstep` database owned by `doorstep_app`, and persists a healthy `DOORSTEP_IMAGE` pin. It never restarts the shared database or other applications. Nginx Proxy Manager routes the hostname to `doorstep:4317`.

Back up the `doorstep` database, the `deploy_doorstep_uploads` volume, and the encryption key together. For a compatible rollback, rerun the deployment script with a previously published full commit SHA and its matching image after authenticating Docker to GHCR. Migrations are forward-only; do not roll back application code across an incompatible schema change.

## Verification

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
```

Unit tests cover calendar precision, exclusive ends, DST, stable UIDs, input cleanup, safe image URLs. Integration tests create a uniquely named database on the **local** PostgreSQL server and delete that newly created database afterward. They exercise concurrent duplicate email ingestion, split shipments, hallucinated tracking rejection, stale carrier events, household isolation, durable leases/retries, OpenAI SDK structured parsing, and Google event upsert/delete/recreate behavior. Google account tests verify real RSA-signed token fixtures, rejected signatures/claims, state replay and browser binding, automatic account creation, member access, removal, and household switching. All external HTTP responses in these tests are fixtures.

Live acceptance still requires real accounts and representative emails:

1. Forward an actual shipping notice; confirm shop, items, order number, date, image and tracking information against the original.
2. Forward a follow-up and duplicate; confirm one shipment and a combined history.
3. Verify a real EasyPost update and a failed/retried webhook.
4. Connect Google; confirm a timed window and an all-day range in the dedicated calendar.
5. Change an ETA; confirm the existing Google event moves and that it appears correctly in Apple Calendar after sync.

## Key files

- `app/page.tsx`, `app/components.tsx`, `app/views.tsx`, `app/globals.css`: application UI.
- `app/api/[...path]/route.ts`: API routing, authorization and inbound endpoints.
- `lib/email.ts`: sanitization, extraction and reconciliation.
- `lib/tracking.ts`: EasyPost adapter and status reconciliation.
- `lib/google-auth.ts`, `lib/auth.ts`, `lib/households.ts`: Google identity, sessions, and household membership.
- `lib/calendar.ts`, `lib/google.ts`: calendar representations and Google synchronization.
- `lib/jobs.ts`, `scripts/worker.ts`: durable background processing.
- `db/`: ordered PostgreSQL migrations.
