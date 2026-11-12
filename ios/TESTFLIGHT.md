# TestFlight releases

PorchPong uses the shared iOS release engine in
[release-tools](https://github.com/jimgreco/release-tools/tree/main/ios), the same
as the other apps. `.github/workflows/testflight.yml` runs `ios/prepare`,
`ios/upload` and `ios/cleanup` on a GitHub-hosted Mac, driven by
`.github/scripts/release-policy.json`. The app remains Google-login-only. Gmail
and Calendar connection management stays on the website.

## Releasing

Every push to `main` runs `release.yml`: verify (backend checks and iOS unit
tests), then the server release and a TestFlight upload. To upload only, run
**Release** on `main` with the server checkbox off. The build number is the Git
commit count.

The policy pins the app id, the Owner group, Jim and Rachel's identities, the
distribution certificate and the `PorchPong App Store 39824194094-1` profile.
Builds are `INTERNAL_ONLY`. The engine only reads App Store Connect; its one write
is the upload. It never adds testers, changes groups, creates profiles or submits
an App Store release. Rotating the profile or certificate requires a policy commit.

Physical iPhone installation and real Google sign-in remain separate acceptance
checks; internal availability does not establish them.

## Apple and GitHub setup

- Apple team: `V6JPQCD336`; bundle and callback scheme: `com.jimgreco.doorstep`.
- Version: 1.4; minimum iOS 18.0; one iPhone app target, no extension or additional
  signing capabilities. Google login uses the server's existing web OAuth flow.
- App Store Connect: [PorchPong Package Tracker, 6813927476](https://appstoreconnect.apple.com/apps/6813927476/testflight/ios).
  The explicit identifier and Owner internal group were created on Apple’s website;
  automatic distribution is enabled. Its two existing testers are Jim and Rachel;
  release guards pin exactly those identities without changing membership.
- Standard system encryption is declared in `ITSAppUsesNonExemptEncryption=false`.
- Repository: `jimgreco/package_tracker`; environment: `production`, restricted to
  branch `main`. Its six signing secret names match the sister projects:
  `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
  `APP_STORE_CONNECT_API_KEY`, `IOS_DIST_CERT_P12`, `IOS_DIST_CERT_PASSWORD`, and
  `KEYCHAIN_PASSWORD`.

The workflow never adds testers, submits an App Store release, or manages Google
provider connections.
