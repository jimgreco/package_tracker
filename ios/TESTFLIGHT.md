# TestFlight releases

Doorstep follows Wardrobe's GitHub Actions release pattern: a dedicated Mac
runner, App Store Connect API authentication, temporary distribution signing,
archive/export/upload, and verification of the exact build's internal testing
availability. The app remains Google-login-only. Gmail and Calendar connection
management stays on the website.

## Release a tested commit

1. Commit the intended source on `main` and run the complete simulator suite in
   [README.md](README.md#build-and-automated-tests), including both iPhone sizes,
   light/dark appearance, and accessibility. Keep the result bundles under ignored
   `output/ios/`. The SHA input below attests these local checks; CI does not repeat
   interactive simulator inspection.
2. Run the backend checks in the same README and push the tested commit. Verify
   the matching **Deploy to EC2** run and public `/api/health` build/database before
   releasing a native build that needs new backend behavior.
3. Dispatch the release for the full tested SHA:

   ```sh
   gh workflow run testflight.yml --ref main -f local_verification_sha=<FULL_TESTED_SHA>
   ```

4. Verify all three TestFlight jobs complete. The upload receipt must say
   `UPLOAD SUCCEEDED`; the final API check must report the exact build as `VALID`
   and `IN_BETA_TESTING`. Confirm the build in App Store Connect's internal group.
   This proves internal availability, while physical iPhone installation and real
   Google sign-in remain separate acceptance checks.

To verify signing/archive/export without uploading another build, add
`-f upload_build=false`. The final job reports the latest existing Apple build,
explicitly without attributing that build to the verification run. For a first
release, an existing build is required for this verification-only check.

Releases are manual-only on `main` and serialized. If Apple processing times out
after an upload, inspect the uploaded build and rerun only the failed processing
job; avoid uploading another build just to repeat that check. Build numbers are
at least the commit count and greater than every prior uploaded integer build.

## Apple and GitHub setup

- Apple team: `V6JPQCD336`; bundle and callback scheme: `com.jimgreco.doorstep`.
- Version: 1.0; minimum iOS 18.0; one iPhone app target, no extension or additional
  signing capabilities. Google login uses the server's existing web OAuth flow.
- App Store Connect: [Doorstep Package Tracker, 6813927476](https://appstoreconnect.apple.com/apps/6813927476/testflight/ios).
  The explicit identifier and Owner internal group were created on Apple’s website;
  automatic distribution is enabled. Add only the account owner as an internal tester.
- Standard system encryption is declared in `ITSAppUsesNonExemptEncryption=false`.
- Repository: `jimgreco/package_tracker`; environment: `production`, restricted to
  branch `main`. Its six signing secret names match the sister projects:
  `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
  `APP_STORE_CONNECT_API_KEY`, `IOS_DIST_CERT_P12`, `IOS_DIST_CERT_PASSWORD`, and
  `KEYCHAIN_PASSWORD`.

The existing team credentials were transferred from Wardrobe by sealing their
values to Doorstep's GitHub environment public key on the source runner. Plaintext
values did not leave that runner or enter source, logs, or local credential files.
The temporary source branch was removed; Wardrobe's main branch was unchanged.
The workflow never adds testers, submits an App Store release, or manages Google
provider connections.

## Mac runner

Repository-scoped runner `doorstep-mac` lives at
`/Users/jgreco/actions-runner-doorstep` with labels
`self-hosted`, `macOS`, `ARM64`, `doorstep-release`. Its official GitHub runner
archive was verified against GitHub's SHA-256 digest. The user launch agent starts
at login. This Mac must be awake and online. All three TestFlight jobs use it;
there are no GitHub-hosted Mac jobs or uploaded build artifacts. Never route
untrusted pull-request code to this runner.

```sh
cd /Users/jgreco/actions-runner-doorstep
./svc.sh status
./svc.sh stop
./svc.sh start
```

The separate runner checkout preserves the owner's working tree. Xcode selection
is job-local. `ios/ci-project.yml` adds ignored manual Release signing overrides;
normal local development keeps automatic signing. Generated build products live
outside Documents so the file provider cannot attach metadata that breaks signing.

Signing validates the exact registered bundle, team, expiration, distribution
permissions and matching certificate. Temporary assets live under `RUNNER_TEMP`;
cleanup restores the keychain search list and removes this job's keychain, API key,
P12 and installed profile. The Release archive check verifies the production
origin, callback, iOS version, signature, and absence of fixtures/ATS exceptions.

Evidence, IPA and archive are retained locally in
`~/Library/Logs/DoorstepReleases/<run-id>-<attempt>/<job>/`. These files are not
selected as GitHub artifacts or included in backend images. Release-helper tests
use synthetic keys and mocked Apple responses:

```sh
node --test .github/scripts/tests/*.test.mjs
python3 -m unittest discover -s .github/scripts/tests -p 'test_*.py'
actionlint .github/workflows/testflight.yml
```
