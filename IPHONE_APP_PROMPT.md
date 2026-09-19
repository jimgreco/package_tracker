# Prompt for a new Codex context

```text
Build the native Doorstep iPhone app in this repository:
/Users/jgreco/Documents/ChatGPT/package_tracker

Read AGENTS.md and IPHONE_APP_SPEC.md first, then inspect current source and git
status. Implement the complete first release described in the spec under ios/,
including the required backend changes. This is an implementation task, not a
request for another plan or a mockup.

Use SwiftUI and the existing Doorstep server at https://packages.jim-greco.com.
Preserve Google-only accounts, household membership, original-email timeline
ordering, dismiss/restore behavior, package identity rules, and Google Calendar
sync. Tracking, Gmail ingestion, and extraction stay on the server. Implement
secure native Google sign-in; do not assume the existing browser cookies work in
a native API client. Google sign-in is the only native Google authorization flow:
reuse existing server Gmail/Calendar connections and show their status. All
connection setup and management stay on the website; do not build native Gmail
or Calendar consent flows.

Use reasonable defaults from the spec. Inspect relevant existing iOS projects in
~/code for build/signing conventions. Preserve unrelated changes and keep secrets
and private data out of Git. Follow the repo's rules for tests and agent use.

Work through implementation, native unit/UI tests, simulator inspection, and the
required backend checks. Commit and push scoped changes, deploy backend changes
through the existing GitHub Action and consolidated EC2 setup, and verify the
exact live SHA and both container health checks. Prepare a device build using
existing signing where available. Do not submit to the App Store as part of this
task. Distinguish simulator/build evidence from actual iPhone, Google consent,
provider, calendar, or TestFlight verification.

Continue autonomously through routine decisions. If an actual user-only sign-in
or unavailable signing credential blocks a step, finish the independent work and
state the exact remaining action. Finish with what works, validation and release
evidence, and any real remaining blocker.
```
