# Doorstep for iPhone

SwiftUI client for the existing Doorstep server. iPhone, iOS 18 or later, Swift 6.
The three tabs provide packages, original emails, and household settings. Tracking,
extraction, Gmail imports and Google Calendar projections remain on the server.
Google account login is the only native Google authorization. Connection management
opens the website in the system browser and may require a separate website login.

## Project and configuration

- Xcode 26.2 (17C52), iOS 26.2 SDK; XcodeGen is installed locally.
- Open `ios/Doorstep.xcodeproj`; regenerate with `xcodegen generate --spec ios/project.yml`.
- Bundle ID / callback scheme: `com.jimgreco.doorstep`.
- Exact callback: `com.jimgreco.doorstep:/auth/callback`.
- Existing signing team: `V6JPQCD336`. The existing Apple Development identity and
  wildcard team provisioning profile support direct device builds for this ID.
  No App Store app record or new explicit bundle registration is required for this
  development delivery. Confirm/register the explicit identifier before distribution.
- Release origin is fixed to `https://packages.jim-greco.com` in code. Release has
  no ATS exceptions, fixture bypass, or configurable server switch.
- Debug reads the `DOORSTEP_API_ORIGIN` build setting (production by default).
  For the simulator, override it with `http://127.0.0.1:4317`; Debug alone allows
  local networking. Run the existing local setup, web, and worker separately.
  On a physical phone use a reachable development host with HTTPS; the phone's
  loopback is not the Mac. No provider secrets belong in the app configuration.
- Native login reuses the existing Google web client and web callback. No Gmail or
  Calendar OAuth callback, scope, or grant configuration needs to change.
- `Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png` reproduces `app/icon.svg`.
  Regenerate with `swift ios/scripts/generate-icon.swift ios/Doorstep/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.

## Build and automated tests

Run from the repository root. Discover installed devices with
`xcrun simctl list devices available` before substituting a different simulator.

```sh
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Doorstep.xcodeproj -scheme Doorstep -configuration Debug \
  -destination 'platform=iOS Simulator,id=2399DE10-E7FA-4085-9A27-4BF05243023B' \
  -derivedDataPath ios/build build CODE_SIGNING_ALLOWED=NO
xcodebuild -project ios/Doorstep.xcodeproj -scheme Doorstep -configuration Debug \
  -destination 'platform=iOS Simulator,id=2399DE10-E7FA-4085-9A27-4BF05243023B' \
  -derivedDataPath ios/build -resultBundlePath output/ios/tests-iphone17pro.xcresult \
  test CODE_SIGNING_ALLOWED=NO
xcrun simctl boot ADC134FF-52D5-47AB-B22D-51785ED07B81
xcrun simctl ui ADC134FF-52D5-47AB-B22D-51785ED07B81 appearance dark
xcodebuild -project ios/Doorstep.xcodeproj -scheme Doorstep -configuration Debug \
  -destination 'platform=iOS Simulator,id=ADC134FF-52D5-47AB-B22D-51785ED07B81' \
  -derivedDataPath ios/build -resultBundlePath output/ios/tests-iphone16e-dark.xcresult \
  test CODE_SIGNING_ALLOWED=NO
npm run typecheck
npm test
npm run test:integration
npm run build
```

Choose a new result bundle path for each run; Xcode does not overwrite one.
Tests inject a clock and API. The backend uses unique local test databases and
signed synthetic Google identities, never production email or paid providers.
The existing pipeline fixtures cover the four-source `700100` / `T700100` sequence,
distinct CDL packages, physical-only ingestion, and protected manual updates.

Unit coverage includes decoding source emails separately from inbox records,
unknown statuses, filters/search/timeline, all estimate kinds and DST, cache and
household isolation, stale responses, auth transitions, API identity/rate errors,
and duplicate saves including a lost response. UI coverage includes login,
packages/search/filter, detail, deliver/dismiss/restore, create/edit validation,
inbox, settings, large text, and offline/malformed-response recovery.

For synthetic visual inspection only, launch a Debug build with `--fixture`.
Optional flags: `--offline`, `--malformed`, `--signed-out`. Tests also use
`-UIPreferredContentSizeCategoryName UICTContentSizeCategoryAccessibilityXXXL`.
These fixtures cannot be activated in Release. Screenshots and result bundles
stay in ignored `output/ios/`; never publish screenshots of real emails/feed links.

## Native authentication and data boundaries

Migration `009_native_sessions.sql` adds native attempts, hashed 30-day bearer
sessions, and manual-create idempotency records. The app generates state and S256
PKCE material, opens the server authorization entry in `ASWebAuthenticationSession`,
validates the callback, and exchanges the single-use code within two minutes.
Google's own separate nonce/PKCE/token verification and membership rules remain
in the existing server flow. No session token is put in a URL.

Only validated native credentials bypass browser Origin validation. Mixed browser
session and bearer credentials are rejected. Native bearer requests cannot manage
Gmail/Calendar grants. Each API response identifies the user and household; native
requests carry their expected household. A changed selection clears the previous
view, and stale responses cannot repopulate it. Current membership is checked for
every request. Sign-out clears local data immediately and reports failed remote
revocation; it leaves household provider grants intact.

`URLSession` is ephemeral, with cookies and URL caching disabled. It sends bearer
credentials only to the configured origin and refuses redirects. Authenticated
asset loading accepts only the household asset route. Tracking URLs open separately
in the system browser. Source emails are rendered as text.

Keychain storage is `WhenUnlockedThisDeviceOnly`. The protected, backup-excluded
cache explicitly contains only package lists and tracking history, partitioned by
user/household. It excludes inbox bodies, settings, feed secrets, exports, and auth
material. Offline edits are disabled. App-switcher privacy uses a window above
presented sheets. JSON exports are protected temporary files, removed when sharing
finishes, the sheet closes, or the next launch cleans up an interrupted share.

## Device archive and installation

Use Xcode's directory outside Documents for signed builds. The Documents file
provider adds Finder metadata to generated bundles, which codesign rejects.

```sh
xcodebuild -project ios/Doorstep.xcodeproj -scheme Doorstep -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/Doorstep-device" \
  -archivePath "$HOME/Library/Developer/Xcode/Archives/2026-09-19/Doorstep.xcarchive" \
  archive -allowProvisioningUpdates
xcodebuild -exportArchive \
  -archivePath "$HOME/Library/Developer/Xcode/Archives/2026-09-19/Doorstep.xcarchive" \
  -exportPath "$HOME/Library/Developer/Xcode/Archives/2026-09-19/Doorstep-device" \
  -exportOptionsPlist ios/ExportOptions-Development.plist -allowProvisioningUpdates
xcrun devicectl list devices
```

Connect and unlock a registered iPhone, enable Developer Mode, then select it in
Xcode and Run, or install the signed archived app with:

```sh
xcrun devicectl device install app --device '<device identifier>' \
  "$HOME/Library/Developer/Xcode/Archives/2026-09-19/Doorstep.xcarchive/Products/Applications/Doorstep.app"
```

The exported development IPA is `Doorstep-device/Doorstep.ipa`. Development signing
is not TestFlight upload or App Store distribution. No upload/submission is part of
this delivery. The connected-device inventory showed Jim's iPhone as unavailable;
physical sign-in must be completed by the user when the phone is connected.

## Release and acceptance

Backend changes deploy through `.github/workflows/deploy.yml`, the `doorstep`
Compose profile, and `scripts/deploy-ec2.sh`. The workflow runs all backend checks,
migrates, checks both exact-image container health states, then checks public
health/build/database and homepage. `ios/` is excluded from Docker context.

Local and simulator results, signed archive/export, deployment, and live provider
acceptance are separate evidence. `ios/VERIFICATION.md` records this delivery.
Remaining user-only acceptance: Google consent/MFA on a physical iPhone, returning
account/household contents, real imported/tracking updates, and the generated
calendar's appearance in Apple Calendar. Do not infer these from fixtures.

Before any public submission, resolve the Google-only login policy under
[Apple guideline 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services)
and applicable account-deletion/privacy requirements. This implementation does not
assume an exception or silently add Apple login. Authentication uses the system
session described by [Apple](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
and follows [Google's external-user-agent guidance](https://developers.google.com/identity/protocols/oauth2/native-app).
