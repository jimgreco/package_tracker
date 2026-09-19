# Doorstep for iPhone

Implementation specification · 2026-09-19

## 1. Outcome

Build a polished native iPhone app for the existing Doorstep household package
tracker. A user signs in with Google and immediately sees the same packages,
source emails, household, and connections as on the website. Package ingestion,
extraction, carrier checks, and calendar updates continue on the server while
the app is closed.

Create the app in `ios/` inside this repository. Extend the existing backend
where necessary; keep one service and one source of truth.

### Product requirements carried forward

- Google authentication only. No passwords, setup codes, or invitation codes.
- Household owners add people by their Google email. Each person signs in with
  their own Google account using the existing membership rules.
- Physical deliveries only. Digital subscriptions, downloads, tickets, online
  documents, and marketing emails do not become package cards.
- Packages sort newest first by the initial source-email date, falling back to
  manual creation time. A new tracking update must not move an old order to the
  top of the main timeline.
- Clearly distinguish **Mark delivered** from **Dismiss**. Dismissal hides a
  package without asserting that it arrived and can be reversed.
- The calendar destination is Google Calendar, which the user then views through
  Apple Calendar. Preserve the existing subscribed ICS feed as an alternative.
- Multiple shipments from one order remain separate when their package identities
  differ. Native code must not perform its own order merging or extraction.

### Implementation defaults

- SwiftUI, Swift concurrency, Observation, and `URLSession`.
- iPhone first; minimum iOS 18. Build with the installed supported Xcode/SDK and
  use availability checks for newer APIs.
- App name: **Doorstep**. Proposed bundle identifier: `com.jimgreco.doorstep`;
  confirm availability in the existing Apple signing setup before registering it.
- Production API origin: `https://packages.jim-greco.com`.
- Local web API: `http://127.0.0.1:4317` for simulator development. A physical
  iPhone needs a reachable development host; its loopback address is not the Mac.
- First delivery: a functioning native client, required backend support, tests,
  simulator evidence, and a device-build path. App Store submission is a separate
  distribution milestone.

## 2. Existing implementation to reuse

This spec was checked against commit `8969cd03b6469dd4b4c68bd1434b7330dada46a1`.
Read current source before implementing; preserve subsequent changes.

| Area                                            | Source                                                  |
| ----------------------------------------------- | ------------------------------------------------------- |
| Project contracts and release checks            | `AGENTS.md`, `README.md`                                |
| HTTP routes and error responses                 | `app/api/[...path]/route.ts`                            |
| Request/response models and status labels       | `lib/types.ts`, `lib/validation.ts`                     |
| Browser sessions and household context          | `lib/auth.ts`                                           |
| Verified Google sign-in and account creation    | `lib/google-auth.ts`                                    |
| Membership permissions and household switching  | Follow the membership imports in the API route          |
| Dashboard, details, manual edits, quick actions | `lib/shipments.ts`                                      |
| Current filter/search behavior                  | `app/page.tsx`                                          |
| Email ingestion and matching                    | `lib/email.ts`, `lib/tracking-identity.ts`              |
| Gmail import and OAuth                          | `lib/gmail.ts`                                          |
| Google Calendar and ICS/date semantics          | `lib/google.ts`, `lib/calendar.ts`                      |
| Carrier checks and durable jobs                 | `lib/tracking.ts`, `lib/jobs.ts`                        |
| Authentication and pipeline regression fixtures | `tests/*.integration.ts`, `tests/*.test.ts`             |
| EC2 release                                     | `.github/workflows/deploy.yml`, `scripts/deploy-ec2.sh` |

The existing API uses an HttpOnly `doorstep_session` cookie. Non-GET browser
requests require the configured Origin. Google login has a browser-oriented
callback. Native bearer sessions and native sign-in completion routes described
below **do not exist yet**. Gmail and Calendar connection flows remain on the
website and are outside the native implementation scope.

The existing dashboard includes dismissed shipments and excludes archived ones.
Its `settings` object carries connection status, household membership, and the
current account. Shipment detail embeds source emails but does not give those
embedded emails the same complete shape as the inbox `Email` type. Model these
responses separately rather than assuming every email has a processing status.

## 3. App structure and visual direction

Use three tabs: **Packages**, **Inbox**, and **Settings**. Each has its own native
navigation stack. Present create/edit forms as sheets. Use system typography,
SF Symbols, native menus, swipe actions, search, and pull-to-refresh. Carry forward
Doorstep's existing icon and visual character while adapting the layout to iPhone.

Support light/dark appearance, Dynamic Type, VoiceOver, Reduce Motion, and at
least 44-point tap targets. Status must be understandable without color. Long
merchant names, item names, and tracking numbers must remain usable on small
phones and at accessibility text sizes.

### Packages

- Default to **All packages**, with visible filters for **On the way**,
  **Delivered**, **Needs attention**, and **Dismissed**. A compact menu is
  acceptable if it shows the selected filter and makes all filters discoverable.
- Search merchant, item name, order number, and tracking number. Preserve the
  selected filter during refresh and detail navigation.
- Preserve the server's dashboard ordering. `timelineAt` is the authoritative
  ordering field; use `createdAt`, then ID, for identical timestamps if sorting
  locally. Do not sort by `updatedAt`, ETA, or current status.
- Show a short explanation: “Newest orders first.” In detail, label the initial
  email date and actual order date separately.
- Each row shows merchant, item summary/quantity, product thumbnail or fallback,
  status, delivery estimate or actual delivery, and order number when available.
- Use precise labels such as “Expected Sep 22–24,” “Today, 2–6 PM,” and
  “Delivered Sep 18.” Never imply that an unknown estimate is today.
- Show a small “Arriving today” summary when supported by the household's local
  date and delivery estimates. It must not silently reorder the main list.
- Swipe actions: **Mark delivered** and **Dismiss** for applicable packages;
  **Restore** in Dismissed. Make the same actions accessible in detail.
- Dismissal offers an Undo action backed by the server's restore endpoint.
  Marking delivered must not use restore as an undo: restore only reverses
  dismissal. Any delivery-date correction goes through Edit details.
- A refresh retrieves current server data. A package's explicit **Check tracking**
  action requests a server job; show that it was requested rather than pretending
  the carrier has already returned a new result.

#### Filter rules: match the website

All filters exclude archived records. Except Dismissed, they exclude dismissed
records. Counts and rows must use the same predicate.

| Filter          | Membership                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| All packages    | All non-dismissed dashboard shipments                                                                    |
| On the way      | `ordered`, `pre_transit`, `in_transit`, `out_for_delivery`, `delayed`, `available_for_pickup`, `failure` |
| Delivered       | `delivered`                                                                                              |
| Needs attention | `needsReview == true`, or status `failure`, `delayed`, or `unknown`                                      |
| Dismissed       | `dismissedAt != null`                                                                                    |

Needs attention and On the way can overlap. Explain Needs attention in the UI:
“Delivery problems or package details that need your review.” Show the actual
review reason or delivery problem. A missing tracking number alone is not an
additional native-only reason to flag a package.

### Package detail

Show:

1. Merchant, items, quantities, and available images.
2. Current status, estimate/delivery date, and any review reason.
3. Order number, order date, initial email date, carrier, tracking number,
   last tracking check, and source of the latest status where available.
4. Tracking history with timestamps and sources, newest first.
5. Linked source emails with subject, sender, original sent date, and readable
   plain text. Imported time is a separate field.

Actions: copy tracking/order numbers, open the source-backed tracking URL, check
tracking, mark delivered, dismiss/restore, edit details, and merge duplicate
entries. For merge, choose the retained entry and show both packages before the
user confirms. Preserve the existing server merge semantics and source history;
do not infer a merge solely from similar item names or an order-number prefix.

Opening a tracking link is a user action through the system browser. Do not
attach Doorstep authorization to that request. Render source email text safely;
do not execute or display raw email HTML in a web view.

### Add/edit package

Provide native forms for the fields supported by `manualSchema`: merchant,
order number/date, items/quantities, carrier, tracking number/URL, status, shipped
time, estimate, actual delivery time, and the existing automatic-update override.

Use progressive disclosure for optional details and delivery precision. Preserve
values the user did not edit. Clearly label protection from automatic updates;
do not silently set or clear `manualOverride` when saving unrelated fields.
Display server validation errors next to relevant controls when possible.

### Inbox

- List imported/forwarded/pasted source emails in the existing server order.
- Primary date is `sentAt`, falling back to `receivedAt` with the label
  “Imported” when the original sent date is unknown.
- Show sender, subject, and processing state. Map queued/processing, processed,
  ignored, needs review, and failed states to plain language; tolerate new states.
- Detail shows readable original text, original sent/imported timestamps, and
  useful extraction/error information without exposing raw JSON as the default.
- Offer retry where the current server supports it and **Paste email** using
  the existing subject/text endpoint. Preserve user text on a failed request.
- Explain that ignored digital purchases and unrelated emails are not packages.
  Do not hide the provenance needed to understand an extraction decision.
- If linking inbox detail to associated packages needs an API addition, add
  household-scoped shipment summaries/IDs to that response. Do not download all
  package details simply to discover those links.

### Settings

- Account name/email, household name/time zone, household switcher, and sign out.
- Members and pending members. Owners can add by Google email and remove members
  using existing server permissions. No invitation-code workflow or email sending.
- Copy the household forwarding email address with a short forwarding explanation.
- Gmail: show the existing connected account, enabled/paused state, import
  progress, last sync, count, and reconnect/error state. Connection setup and
  management stay on the website.
- Google Calendar: show existing connection, last sync, and error/reconnect state.
  Connection setup and management stay on the website. Explain how to enable the
  generated Google calendar in Apple Calendar. Do not request EventKit access.
- Offer a normal **Manage connections on website** link to Doorstep settings if
  useful. Safari may require its own login; do not build a native-to-web session
  transfer or provider-consent handoff for this link.
- ICS feed: explicit copy/share and rotate-link actions. Treat the feed link as
  a secret; keep it out of logs, analytics, screenshots used for publication, and
  persistent dashboard caches.
- Household JSON export through a native share sheet; delete the temporary export
  after use. Include the existing retry-failed-jobs action in a diagnostics section.
- Present service failures as useful recovery guidance. Users should not need
  provider keys, server paths, or deployment terminology to operate the app.

## 4. Data and calendar correctness

Use `lib/types.ts` and runtime API responses to implement Swift `Codable` models.
Unknown optional fields must not break decoding. Unknown status strings should
display a neutral readable fallback rather than discard the dashboard.

Distinguish date-only strings (`YYYY-MM-DD`), absolute timestamps, and local
date-times associated with an IANA time zone. Do not decode everything through
one UTC `Date` parser. Handle timestamps with and without fractional seconds.

Preserve all five estimate kinds: `date`, `date_range`, `window`, `point`, and
`deadline`. Display them using the estimate's destination zone; explain that zone
when it differs from the phone's. Use the household zone for household-day
grouping and source timestamp presentation. Date ranges have inclusive ends in
the database. Calendar exclusive-end conversion stays in the backend. Missing
dates stay missing; ambiguous DST values should receive the existing review flow.

Google Calendar and ICS remain projections of server shipments. Never create
parallel native calendar events, recalculate shipment identity, call OpenAI, or
poll carriers from the phone. Keep stable server shipment and calendar IDs.

## 5. Native authentication: required backend work

### Chosen approach

Use `ASWebAuthenticationSession` to run Doorstep's server-hosted Google sign-in,
then exchange a short-lived completion code for a native Doorstep session.
This reuses verified Google identity and membership resolution. The iPhone never
receives the Google web client secret or the service's Google refresh tokens.

Do not load Google OAuth in `WKWebView`. Google documents restrictions on embedded
user agents; use a supported external authentication session. See
[Google's native OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app)
and [Apple Authentication Services](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).

### Login sequence

1. The app generates an unpredictable state and a PKCE verifier/challenge for
   the Doorstep-to-app handoff. It retains the verifier locally for this attempt.
2. `POST /api/native/auth/start` accepts the state and S256 challenge and returns
   a short-lived authorization URL on the Doorstep production origin. Callback
   destinations are fixed/allowlisted server configuration, not arbitrary URLs.
3. The app opens that URL with `ASWebAuthenticationSession`. The browser entry
   establishes browser-bound state/cookies before redirecting to Google. Reuse
   the existing Google flow's separate PKCE, nonce, token verification, stable
   `sub`, verified email, and authoritative-email membership rules.
4. After successful server verification, return to a registered app callback,
   proposed `com.jimgreco.doorstep:/auth/callback`, with only an opaque single-use
   completion code and the original app state. Keep normal web sign-in redirects
   working. Never put a session token, Google token, or refresh token in a URL.
5. The app verifies state, then sends the code and verifier to
   `POST /api/native/auth/exchange`. Consume the code atomically only with the
   matching challenge. Codes expire within two minutes and are replay protected.
6. Return an opaque Doorstep bearer session plus expiry and account/session
   identity. Store only its hash on the server, and the token in iOS Keychain
   using device-only storage. A 30-day session matches the existing web session
   policy; expiration requests a fresh Google sign-in. A refresh-token subsystem
   is not required for the first version.
7. Load the authenticated dashboard and show the existing household. Login must
   not create a parallel account for a returning Google subject.

Persist native login attempts and sessions in new numbered migrations. Bind
attempts to their purpose, browser, app state, challenge, expiry, and verified
user. Rate-limit public start/exchange endpoints. Retain the authentication
session object while running; handle cancellation, expired attempts, app return,
and interrupted/network-failed completion without exposing secrets in errors.

### Authenticated API access

- Extend `context()` to accept a verified native bearer session while retaining
  browser cookie behavior. Both modes resolve through current household membership.
- Do not bypass `checkOrigin()` merely because an Authorization header exists.
  Only a successfully validated native session may use the native mutation path.
  Browser-cookie mutations continue requiring the exact Origin. Define and test
  mixed cookie/bearer requests explicitly; rejecting mixed credentials is fine.
- Public native start/exchange and browser callback exceptions must be narrowly
  routed and validated; do not relax Origin checking across the API.
- Add `POST /api/native/auth/logout` to revoke the current native session. Sign
  out clears local credentials and account data even if the network is down;
  report when server revocation could not complete. Logging out of one device
  must not silently disconnect the household's Gmail or Calendar grants.
- Keep native sessions distinguishable and independently revocable. Removed
  household members must lose access immediately on the server.
- Scope requests and cached data to the authenticated user and household. The
  current server stores selected household on the user; another client can change
  it. Check returned household identity, discard stale in-flight responses, and
  clear the previous household view when selection changes.

### Existing Gmail and Calendar connections

The only Google authorization flow to implement in iOS is account sign-in using
`openid email profile`. Do not add native Gmail/Calendar connection endpoints,
provider-consent callbacks, history-range setup, or grant-management controls.

Reuse the existing server connections. Gmail continues importing and the worker
continues syncing shipment changes to Google Calendar regardless of whether the
iPhone app is open. Show their status from the dashboard; direct setup/reconnect
work to the website. A user can use the iPhone app without either connection.

Leave the website's existing Google callbacks, scopes, account restrictions,
`GMAIL_HOUSEHOLD_ID`, and connection lifecycle behavior intact. Native sign-in and
sign-out must not create, replace, or disconnect these grants.

## 6. Existing API surface

All paths below are relative to `/api`. Reuse existing request validators and
response/error shapes. Existing failures generally return `{ "error": "..." }`.

| Method       | Path                                            | Native use                           |
| ------------ | ----------------------------------------------- | ------------------------------------ |
| GET          | `auth/config`                                   | Google availability before sign-in   |
| GET          | `dashboard`                                     | Shipments, inbox summaries, settings |
| GET          | `shipments/:id`                                 | Shipment, events, source emails      |
| POST / PATCH | `shipments` / `shipments/:id`                   | Manual create/edit                   |
| POST         | `shipments/:id/deliver`, `/dismiss`, `/restore` | Quick actions                        |
| POST         | `shipments/:id/refresh`                         | Queue carrier check                  |
| POST         | `shipments/:id/merge`                           | Merge into `targetId`                |
| POST         | `emails`                                        | Paste `{subject, text}`              |
| GET          | `emails/:id`                                    | Source detail                        |
| POST         | `emails/:id/retry`                              | Retry extraction                     |
| PATCH        | `settings`                                      | Household name/time zone             |
| POST         | `settings/members`, `settings/members/remove`   | Membership management                |
| POST         | `settings/household-switch`                     | Select existing household            |
| POST         | `settings/rotate-feed`                          | Rotate ICS bearer link               |
| GET          | `settings/export`                               | Household export                     |
| POST         | `settings/retry-jobs`                           | Retry failed household jobs          |
| GET          | `assets/:id`                                    | Authenticated household image        |

Retain browser `auth/google/*`, `gmail/connect`, and `google/connect` routes for
the website. Only the proposed native sign-in/session routes supplement them.

Add atomic server idempotency for manual creation using an `Idempotency-Key`
bound to user, household, route, and request-body hash. Repeating the same saved
attempt after a lost response returns the original ID; reusing a key with different
input is rejected. Follow existing idempotency for other mutations and do not
blindly retry non-idempotent POSTs.

Add only API fields required by a real native screen, with backwards-compatible
responses and tests. Do not create a second parallel package API or move provider
configuration onto the device.

## 7. Native implementation and lifecycle

Suggested layout (adapt modestly to existing local iOS conventions):

```text
ios/
  README.md
  Doorstep.xcodeproj/          # or a reproducibly generated project plus its config
  Doorstep/
    App/                      # app entry, configuration, root state/navigation
    Models/                   # API DTOs, status and date/estimate presentation
    Networking/               # API client, error mapping, authenticated images
    Authentication/           # system auth session, callback handling, Keychain
    Persistence/              # household-scoped read-only cache
    Features/
      Packages/
      Inbox/
      Settings/
    Resources/                # asset catalog, localization, privacy manifest as needed
  DoorstepTests/
  DoorstepUITests/
```

- Use an actor or equivalent serialization for credentials and network state,
  and `@MainActor` observable screen stores. Inject an API protocol and clock so
  tests do not depend on live production accounts or wall-clock dates.
- Fetch on launch, sign-in, foreground activation, household switch, successful
  mutations, and pull-to-refresh. While relevant screens are visible, a bounded
  approximately 60-second refresh may surface worker updates. Coalesce requests
  and stop foreground polling when inactive.
- Use a shorter bounded refresh after a requested sync/check while showing its
  pending state. Back off after failures and honor rate limits.
- Cache the last successful package list and previously viewed details for
  read-only offline access. Show “Offline · last updated …”. Do not invent carrier
  updates locally or silently queue offline edits in this release.
- Persist a purpose-built cache model, not the entire `DashboardData`: exclude
  feed URLs, raw email bodies, exports, auth material, and sensitive settings.
  Partition by user/household, apply iOS file protection, exclude cache from backup,
  and clear it on sign-out. Hide private content in the app-switcher snapshot.
- A cached screen cannot authorize a mutation. On membership/authentication errors,
  clear inaccessible data and return to a useful sign-in/household state.
- During writes, prevent double taps, preserve form inputs on error, and reconcile
  with the server. Do not announce success before server acknowledgement. Reuse
  a manual-create idempotency key when retrying the same unresolved save.
- Authenticated `/api/assets/:id` images need an image loader using the API session;
  a plain unauthenticated image request may fail. Send credentials only to the
  configured Doorstep origin and reject credential-bearing cross-origin redirects.
- Keep public configuration in build settings/xcconfig. No service credentials,
  production tokens, user email samples, or signing secrets enter Git or the IPA.
- Release builds use production HTTPS and must not expose a demo-auth bypass or
  unrestricted server-URL switch. Any local networking exception is Debug only.

## 8. Required states and acceptance tests

### Product acceptance

1. A returning Google account sees its existing household and packages; a pending
   household member joins through their own verified Google account without codes.
2. Packages match web filter membership, counts, search, and timeline ordering.
   Delivered/status updates do not reorder the initial-order timeline.
3. A synthetic Cometeer-style sequence uses one order page with order numbers
   `700100` and `T700100`: confirmation → shipping notice without tracking → CDL
   out-for-delivery link → delivered. The app displays one delivered package with
   all four sources. Two distinct CDL tracking codes stay separate shipments.
4. Mark delivered, dismiss, restore, edit, and merge survive reload and are visible
   on the website. Dismissal never changes status to delivered. Protected manual
   status/estimate values survive automatic updates.
5. Inbox rows show original email dates; imported dates are separately labeled.
   Irrelevant digital receipts do not appear in package filters.
6. Date-only, inclusive date-range, timed window, point, deadline, missing date,
   destination-zone, and DST cases display correctly.
7. Native Google sign-in requests only `openid email profile`; cancellation leaves
   existing connections intact. Existing Gmail imports and Google Calendar updates
   continue on the server. The app shows connection status without requiring or
   initiating Gmail/Calendar consent.
8. Household switching, member removal, session expiration, logout, offline launch,
   malformed responses, missing images, and server errors have usable states and
   do not leak one household's data into another view.
9. Manual creation after a lost response or repeated tap creates one shipment.
10. Small and large iPhone screens, dark mode, large text, and VoiceOver support
    all core actions without clipped controls or color-only status cues.

### Automated verification

- Backend: native start/exchange expiry, wrong state/verifier, replay/concurrent
  exchange, denied consent, invalid identity, callback destination validation,
  bearer expiry/revocation, Origin separation, membership isolation, unchanged
  existing Google connections, and manual-create idempotency.
- Reuse existing Google verification and pipeline fixtures; do not test against
  production emails or call paid providers as part of routine tests.
- Swift unit tests: response decoding, unknown statuses, date/estimate formatting,
  filter predicates, ordering, session transitions, household response races,
  cache isolation, API error handling, and duplicate-save prevention.
- UI tests using injected fixtures: sign-in landing, packages/search/filter,
  detail/actions, create/edit validation, inbox, settings, and offline/error states.
- Run `npm run typecheck`, `npm test`, `npm run test:integration`, and `npm run build`
  when changing backend code. Run the native build and unit/UI tests using a
  discovered installed simulator, and document the exact commands in `ios/README.md`.

### Live acceptance and release evidence

Keep separate evidence for compilation, mocked tests, simulator UI, physical
iPhone Google consent, real provider updates, and calendar appearance on a device.
Only call each verified when it actually happened. Do not automate around a user
Google/MFA prompt or invent successful provider acceptance.

Backend changes ship through the existing GitHub workflow and consolidated EC2
deployment. Verify exact pushed SHA, public health/database status, homepage, and
both web/worker container health. Keep iOS build outputs out of Docker context;
review `.dockerignore` when adding the native directory. Never alter unrelated
services or copy server secrets into iOS configuration.

Prepare signing using the user's existing Apple team/conventions when available.
Record bundle identifier, URL scheme, development setup, simulator commands, and
device installation steps. TestFlight availability and App Store acceptance are
separate from a successful archive or upload.

Public distribution needs an explicit authentication-policy decision if required:
Apple's current [Login Services guideline 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services)
places conditions on Google-only primary login and lists exceptions. Do not assume
Doorstep qualifies for an exception or silently add Apple login against the
Google-only product requirement. Before public submission, resolve that decision
and applicable account-deletion/privacy requirements. This does not block native
development and direct device testing.

## 9. Implementation order and completion

1. Inspect current repo state, relevant source, installed Xcode, and established
   iOS project/signing conventions in the user's existing apps under `~/code`.
   Follow `AGENTS.md`; use that inspection to select tooling, not to import unrelated
   product behavior or credentials.
2. Scaffold `ios/`, models, configuration, and fixture-driven previews/tests.
3. Implement native session exchange and a working Google login → existing
   household → dashboard slice, with backend authentication tests.
4. Build package list/detail/actions and manual editing, including creation
   idempotency and server reconciliation.
5. Build inbox and settings, including read-only Gmail/Calendar connection status,
   membership management, household switching, export, and a link to web settings.
6. Add offline read-only behavior, accessibility, error handling, and regression
   coverage; inspect the actual simulator screens.
7. Complete required checks, deploy any backend changes through the existing
   pipeline, and prepare/verify the native device build as signing permits.
8. Finish with changed files, commands/results, release evidence, and any exact
   user-only action remaining. A mockup or fixture-only dashboard is not completion.

Native Gmail/Calendar connection setup is explicitly outside this release.
Defer push notifications, widgets, Live Activities, Siri/App Intents, share
extensions, Apple Watch, iPad-specific layouts, barcode scanning, on-device email
parsing, and offline mutation queues. They can follow once the complete native
core works against the existing service.
