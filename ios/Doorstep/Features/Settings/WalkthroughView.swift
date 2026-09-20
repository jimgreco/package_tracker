import SwiftUI

struct WalkthroughProgress {
  static func key(user: String, household: String) -> String {
    "doorstep.walkthrough.v1.\(user).\(household)"
  }
  static func step(user: String, household: String, defaults: UserDefaults = .standard) -> Int {
    min(4, max(0, defaults.integer(forKey: key(user: user, household: household))))
  }
}

struct WalkthroughView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  let user: String
  let household: String
  @State private var step = 0
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var calendar = GoogleCalendarConnection()
  @State private var preferences: NotificationPreferences?
  private var titles: [String] {
    [
      "Welcome to Doorstep", "A heads-up when it matters", "Deliveries, on your calendar",
      "Make yourself at home",
    ]
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Text("GETTING STARTED · \(step + 1) OF 4").font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
          Image(
            systemName: [
              "shippingbox.fill", "bell.badge.fill", "calendar", "checkmark.circle.fill",
            ][step]
          )
          .font(.system(size: 52)).foregroundStyle(Color.doorstep).accessibilityHidden(true)
          Text(titles[step]).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
          if step == 0 {
            Text("Everything coming to \(store.householdName), together in one place.")
            feature(
              "Packages",
              "See what’s on the way, check delivery details, and mark packages collected when you bring them inside.",
              "shippingbox")
            feature(
              "Inbox",
              "Review order and delivery emails, including messages that need your attention.",
              "tray")
            feature(
              "Settings", "Manage your household, notifications, and calendar connections.",
              "gearshape")
            Text("Gmail import is optional and managed on the Doorstep website.").font(.footnote)
              .foregroundStyle(.secondary)
          } else if step == 1 {
            Text(
              "Get alerts for deliveries, pickups, delays, and packages that need attention. Package details stay inside the app."
            )
            Text(
              "Tap Enable notifications, then Allow on the iPhone permission prompt. You can change alert types in Settings anytime."
            )
            if preferences?.enabled == true && PushNotifications.shared.authorization == .authorized
            {
              Label("Notifications are allowed on this iPhone.", systemImage: "checkmark.circle")
            }
            Button("Enable notifications") { enableNotifications() }
              .buttonStyle(.borderedProminent).foregroundStyle(Color(uiColor: .systemBackground))
              .disabled(
                busy || !store.canWrite || preferences == nil
              )
              .accessibilityIdentifier("walkthroughEnableNotifications")
            if PushNotifications.shared.authorization == .denied {
              Text(
                "Notifications are blocked. Open iPhone settings and turn on Allow Notifications for Doorstep."
              )
              Link(
                "Open iPhone notification settings",
                destination: URL(string: UIApplication.openNotificationSettingsURLString)!)
            }
            if let preferences, !preferences.configured {
              Text(
                "Notification delivery is temporarily unavailable. You can continue and finish setup in Settings later."
              ).font(.footnote)
            }
            if let pushError = PushNotifications.shared.error {
              Text(pushError).foregroundStyle(.red)
            }
          } else if step == 2 {
            Text(
              "Doorstep adds a Package Deliveries calendar to Google Calendar and keeps delivery estimates up to date for this household."
            )
            Text(
              "Access is limited to calendars Doorstep creates. Your other calendars stay private."
            ).font(.footnote).foregroundStyle(.secondary)
            if store.dashboard?.settings.google.connected == true {
              Label("Google Calendar connected", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Color.doorstep)
            }
            if let message = store.dashboard?.settings.google.error {
              Text(message).foregroundStyle(.red)
            }
            Button(
              store.dashboard?.settings.google.connected == true
                ? "Reconnect Google Calendar" : "Connect Google Calendar"
            ) {
              connectCalendar()
            }.buttonStyle(.borderedProminent).foregroundStyle(Color(uiColor: .systemBackground))
              .disabled(busy || calendar.busy || !store.canWrite)
              .accessibilityIdentifier("walkthroughConnectCalendar")
            Text(
              "Choose your Google account and allow calendar access. You’ll return here when you’re done."
            )
            Text(
              "Use Apple Calendar? Add your Google account in iPhone Calendar settings, then enable the Package Deliveries calendar."
            ).font(.footnote).foregroundStyle(.secondary)
          } else {
            Text(
              "Open Packages to see your deliveries. Both setup steps are optional, and you can revisit them in Settings → Getting started."
            )
            Text(
              "Delivery and calendar updates continue while Doorstep is closed. When offline, you can browse saved packages; changes need a connection."
            )
          }
          if busy || calendar.busy { ProgressView("Working…") }
          if let error {
            Text(error).foregroundStyle(.red).accessibilityIdentifier("walkthroughError")
          }
          if let notice { Text(notice).foregroundStyle(.secondary) }
          if !store.canWrite && step > 0 && step < 3 {
            Text("Connect to the internet to finish this step, or continue for now.").font(
              .footnote)
          }
          Button(step == 3 ? "Explore packages" : step == 0 ? "Get started" : "Continue") {
            if step == 3 { finish() } else { move(to: step + 1) }
          }.buttonStyle(.borderedProminent).foregroundStyle(Color(uiColor: .systemBackground))
            .controlSize(.large).disabled(busy || calendar.busy)
            .accessibilityIdentifier("walkthroughContinue")
          if step > 0 {
            Button("Back") { move(to: step - 1) }.disabled(busy || calendar.busy)
          }
        }.frame(maxWidth: 560, alignment: .leading).padding(28).frame(maxWidth: .infinity)
      }.id(step).background(Color.canvas)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Set up later") { finish() }.disabled(busy || calendar.busy)
          }
        }
    }.interactiveDismissDisabled()
      .onAppear {
        let saved = WalkthroughProgress.step(user: user, household: household)
        step = saved < 4 ? saved : 0
      }
      .task {
        await PushNotifications.shared.refreshAuthorization()
        do {
          preferences = try await store.api.get("notifications/preferences", household: household)
        } catch {
          self.error = "Could not load notification preferences. Reopen this guide when connected."
        }
      }
      .onChange(of: store.epoch) { _, _ in
        calendar.cancel()
        dismiss()
      }
  }
  private func feature(_ title: String, _ text: String, _ icon: String) -> some View {
    HStack(alignment: .top, spacing: 16) {
      Image(systemName: icon).font(.title2).foregroundStyle(Color.doorstep).frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 5) {
        Text(title).font(.headline)
        Text(text).foregroundStyle(.secondary)
      }
    }
  }
  private func move(to value: Int) {
    step = value
    error = nil
    notice = nil
    UserDefaults.standard.set(
      value, forKey: WalkthroughProgress.key(user: user, household: household))
  }
  private func finish() {
    UserDefaults.standard.set(4, forKey: WalkthroughProgress.key(user: user, household: household))
    dismiss()
  }
  private func enableNotifications() {
    guard var prefs = preferences else { return }
    busy = true
    error = nil
    let epoch = store.epoch
    Task {
      defer { busy = false }
      do {
        try await PushNotifications.shared.enable()
        guard store.epoch == epoch else { return }
        prefs.enabled = true
        let result = try await store.api.request(
          "notifications/preferences", method: "POST", body: JSONEncoder().encode(prefs), key: nil,
          household: household)
        guard store.epoch == epoch else { return }
        preferences = try JSONDecoder().decode(NotificationPreferences.self, from: result)
        await PushNotifications.shared.sync(store: store)
        notice = "Permission saved. You can adjust notification types in Settings."
      } catch { if store.epoch == epoch { self.error = store.friendly(error) } }
    }
  }
  private func connectCalendar() {
    error = nil
    let epoch = store.epoch
    Task {
      do {
        let connected = try await calendar.connect(api: store.api, household: household)
        guard store.epoch == epoch else { return }
        await store.refresh()
        notice =
          connected
          ? "Google Calendar connected. Delivery sync is queued."
          : "Calendar connection cancelled. You can try again or continue."
        if connected { store.scheduleFollowUp() }
      } catch { if store.epoch == epoch { self.error = store.friendly(error) } }
    }
  }
}
