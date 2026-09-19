# iPhone implementation verification — 2026-09-19

## Automated and simulator evidence

| Layer | Evidence |
| --- | --- |
| Backend typecheck | `npm run typecheck` passed |
| Backend unit tests | 21 passed |
| Backend integration | 47 passed, isolated local databases, mocked Google/provider requests |
| Production web build | `npm run build` passed; no iOS/local-data paths in standalone output |
| Native compiler | Xcode 26.2, Swift 6, iOS 18 deployment target, simulator and Release device builds |
| Native unit tests | 14 passed. Decoding, dates/DST, filters/order, cache isolation, auth/household transitions, stale responses, API identity/errors, duplicate and lost-response saves; final result in `output/ios/unit-final.xcresult` |
| iPhone 17 Pro, iOS 26.2 | 7 UI tests passed; light appearance and largest accessibility text inspected |
| iPhone 16e, iOS 26.2 | 13 unit and 8 UI tests passed in dark appearance; includes deliver and edit persistence |
| Focused final accessibility | 2 UI tests passed after fixing picker truncation and dark sign-in contrast; text-clipping and sufficient-description audit passed |
| Signing | Existing Apple Development identity, team `V6JPQCD336`, wildcard team profile; `ARCHIVE SUCCEEDED` and `EXPORT SUCCEEDED` |

The final unit pass additionally covers polling during a mutation: no stale
background read is started before the write is acknowledged and reconciled.
XCTest screenshots are exported under `output/ios/inspection-iphone17pro/` and
`output/ios/inspection-iphone16e/`; final accessibility attachments are in
`output/ios/accessibility-final.xcresult`. These contain synthetic data only.

The code includes the real production API client and system Google sign-in;
fixtures are Debug-only dependency injection, not a replacement backend.
Native fixture tests do not establish successful live Google consent.

## Backend release gate

The exact pushed SHA must pass the existing **Deploy to EC2** workflow. Its deploy
step verifies the pinned ARM64 image and health of both `doorstep` and
`doorstep-worker`; its public step verifies `/api/health` build/database and the
homepage. The local delivery record `output/ios/backend-release.json` records the
actual workflow URL, exact deployed SHA and public checks after the release runs.
The final delivery message also links that workflow. No unrelated Compose services
are changed, and `ios/` is excluded from the Docker context.

## Signed device artifact

Final archive and development IPA:

- `~/Library/Developer/Xcode/Archives/2026-09-19/Doorstep.xcarchive`
- `~/Library/Developer/Xcode/Archives/2026-09-19/Doorstep-device/Doorstep.ipa`

These are development distribution artifacts, not a TestFlight or App Store
submission. Device build outputs stay outside Git and Docker. The source uses the
existing Doorstep icon, production origin, native callback, and Apple team.

## Still requires the user/device

The device inventory reported Jim's iPhone as **unavailable**. Connect and unlock
it, install/run the development build using `ios/README.md`, and complete Google
consent/MFA personally. Then confirm the existing household and source emails,
real provider updates, and Doorstep calendar appearance in Apple Calendar.

No physical-device login, live provider acceptance, TestFlight availability,
App Store acceptance, or audible VoiceOver walkthrough is claimed. The simulator
accessibility audit and labeled native controls are distinct from that walkthrough.
The public-distribution Google-only authentication/deletion/privacy decision is
still a separate milestone under the specification.
