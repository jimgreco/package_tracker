import SwiftUI
import UIKit
import UserNotifications

struct NotificationPreferences: Codable, Sendable {
  var configured: Bool = false
  var enabled = false
  var outForDelivery = true
  var delivered = true
  var pickup = true
  var problems = true
}
struct PushDestination: Identifiable, Equatable {
  var id: String
  var householdId: String
}
@MainActor @Observable final class PushNotifications {
  static let shared = PushNotifications()
  var token: String?
  var destination: PushDestination?
  var error: String?
  var authorization: UNAuthorizationStatus = .notDetermined
  private var registeredSession: String?
  private var registeredToken: String?
  func refreshAuthorization() async {
    authorization = await UNUserNotificationCenter.current().notificationSettings()
      .authorizationStatus
  }
  func enable() async throws {
    guard
      try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound, .badge,
      ])
    else {
      await refreshAuthorization()
      throw APIError(status: 0, message: "Allow notifications for PorchPong in iPhone Settings.")
    }
    await refreshAuthorization()
    UIApplication.shared.registerForRemoteNotifications()
  }
  func sync(store: AppStore) async {
    #if DEBUG
      guard !ProcessInfo.processInfo.arguments.contains("--fixture") else { return }
    #endif
    guard let session = store.session, !store.offline else { return }
    await refreshAuthorization()
    guard authorization == .authorized || authorization == .provisional else {
      _ = try? await store.api.request(
        "notifications/device/disable", method: "POST", body: nil, key: nil,
        household: session.householdId)
      registeredSession = nil
      registeredToken = nil
      return
    }
    UIApplication.shared.registerForRemoteNotifications()
    guard let token, registeredSession != session.token || registeredToken != token else { return }
    #if DEBUG
      let environment = "sandbox"
    #else
      let environment = "production"
    #endif
    do {
      let body = try JSONEncoder().encode(["token": token, "environment": environment])
      _ = try await store.api.request(
        "notifications/device", method: "POST", body: body, key: nil, household: session.householdId
      )
      guard store.session?.token == session.token else { return }
      registeredSession = session.token
      registeredToken = token
      error = nil
    } catch {
      self.error = "Could not register this iPhone for notifications. Try again when connected."
    }
  }
  func signOut() {
    UIApplication.shared.unregisterForRemoteNotifications()
    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    registeredSession = nil
    registeredToken = nil
    destination = nil
    token = nil
  }
}
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }
  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    PushNotifications.shared.token = deviceToken.map { String(format: "%02x", $0) }.joined()
  }
  func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    PushNotifications.shared.error =
      "This iPhone could not register for notifications. Check your connection and try again."
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let info = response.notification.request.content.userInfo
    guard let id = info["shipmentId"] as? String, UUID(uuidString: id) != nil,
      let household = info["householdId"] as? String, UUID(uuidString: household) != nil
    else { return }
    await MainActor.run {
      PushNotifications.shared.destination = PushDestination(id: id, householdId: household)
    }
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound, .list]
  }
}
struct NotificationSettingsSection: View {
  @Environment(AppStore.self) private var store
  @State private var prefs: NotificationPreferences?
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    Section("Notifications") {
      Text(
        "Your preferences for this household. Alerts show a general message; package details stay in PorchPong."
      ).font(.footnote)
      if let prefs {
        if !prefs.configured {
          Text("Push delivery is not configured yet. You can save your preferences.").font(
            .footnote)
        }
        preference("Send me notifications", key: \.enabled)
        preference("Out for delivery", key: \.outForDelivery)
        preference("Delivered", key: \.delivered)
        preference("Ready for pickup", key: \.pickup)
        preference("Delays and packages needing attention", key: \.problems)
        if prefs.enabled {
          Button("Enable notifications on this iPhone") {
            Task {
              do {
                try await PushNotifications.shared.enable()
                await PushNotifications.shared.sync(store: store)
              } catch { self.error = store.friendly(error) }
            }
          }.disabled(!store.canWrite || busy)
          if PushNotifications.shared.authorization == .denied {
            Link(
              "Open iPhone notification settings",
              destination: URL(string: UIApplication.openNotificationSettingsURLString)!)
          }
        }
      } else if error == nil {
        ProgressView("Loading preferences…")
      }
      if let error { Text(error).foregroundStyle(.red) }
      if let error = PushNotifications.shared.error { Text(error).foregroundStyle(.red) }
    }.task(id: store.householdId) {
      do {
        prefs = try await store.api.get("notifications/preferences", household: store.householdId)
        error = nil
      } catch { self.error = "Connect to load notification preferences." }
      await PushNotifications.shared.refreshAuthorization()
    }
  }
  func preference(_ title: String, key: WritableKeyPath<NotificationPreferences, Bool>) -> some View
  {
    Toggle(
      title,
      isOn: Binding(
        get: { prefs?[keyPath: key] ?? false },
        set: { value in
          guard var updated = prefs else { return }
          updated[keyPath: key] = value
          busy = true
          error = nil
          let household = store.householdId
          let epoch = store.epoch
          Task {
            defer { busy = false }
            do {
              if key == \.enabled && value { try await PushNotifications.shared.enable() }
              guard store.epoch == epoch else { return }
              let body = try JSONEncoder().encode(updated)
              let result = try await store.api.request(
                "notifications/preferences", method: "POST", body: body, key: nil,
                household: household)
              guard store.epoch == epoch else { return }
              prefs = try JSONDecoder().decode(NotificationPreferences.self, from: result)
              await PushNotifications.shared.sync(store: store)
            } catch { self.error = store.friendly(error) }
          }
        })
    ).disabled(busy || !store.canWrite || (key != \.enabled && prefs?.enabled != true))
  }
}
