# Package list browser regression gate

These Playwright CLI scripts exercise the built production UI with synthetic
accounts, households and packages. They intercept every API request and block
all non-loopback requests. No database, credentials, real account or provider
connection is used. The fixture captures the app's own 30-second polling
callback and triggers it explicitly, so delayed-response ordering is repeatable
without freezing browser animations or actionability checks.

Use the existing Playwright CLI (or the workspace Playwright skill wrapper).
From the repository root, build and start a standalone preview in one terminal:

```sh
CIRCLE_NODE_TOTAL=3 NEXT_TELEMETRY_DISABLED=1 npm run build
cp -R .next/static .next/standalone/.next/static
env -i PATH="$PATH" PORT=4328 HOSTNAME=127.0.0.1 NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 APP_URL=http://127.0.0.1:4328 DEMO_MODE=false \
  node .next/standalone/server.js
```

In a second terminal, run these commands sequentially in a new browser session:

```sh
mkdir -p output/playwright
playwright-cli --session porchprefs open about:blank --headed
playwright-cli --session porchprefs run-code --filename=tests/browser/package-list-fixture.js
playwright-cli --session porchprefs snapshot
playwright-cli --session porchprefs run-code --filename=tests/browser/dashboard-race-checks.js
playwright-cli --session porchprefs run-code --filename=tests/browser/package-list-checks.js
playwright-cli --session porchprefs close
```

Both check scripts must return `passed: true`. Stop the preview server with
Ctrl-C after inspection. Screenshots are saved under ignored `output/playwright/`.
The fixture intentionally blocks remote fonts and returns 404 for unrelated
APIs; those console messages are not live-service failures.

The response-order gate covers delayed household A success/401/500 after
household B loads; Reset in B preserving A's preferences; a confirmed switch
whose new dashboard fails, with the old scope hidden until retry; and latest
error precedence over an older success. The list gate covers reload, stable ID
across an email change, account/household changes, expired sessions, logout,
empty/reset recovery, denied/corrupt storage, and a 390-pixel mobile layout.

These are a manual release gate in addition to `npm test`, integrations and the
production build. They do not claim physical-device or live-provider acceptance.
