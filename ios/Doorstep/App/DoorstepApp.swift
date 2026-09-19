import SwiftUI

@main struct DoorstepApp: App {
  @State private var store: AppStore
  @State private var privacy = PrivacyShield()
  @Environment(\.scenePhase) private var phase
  init() {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--fixture") {
        _store = State(initialValue: Fixture.makeStore())
      } else {
        _store = State(initialValue: AppStore())
      }
    #else
      _store = State(initialValue: AppStore())
    #endif
    // Clean up exports left behind by an interrupted share or process termination.
    try? FileManager.default.removeItem(
      at: FileManager.default.temporaryDirectory.appendingPathComponent("DoorstepExports"))
  }
  var body: some Scene {
    WindowGroup {
      RootView().environment(store).tint(.doorstep)
        .onChange(of: phase, initial: true) { _, phase in privacy.setHiddenContent(phase != .active)
        }
        .task(id: phase) {
          guard phase == .active else {
            store.stopPolling()
            return
          }
          await store.start()
          while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(store.retryDelay)) } catch { return }
            await store.refresh()
          }
        }
    }
  }
}
struct RootView: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    Group {
      if store.session == nil {
        SignInView()
      } else {
        TabView {
          Tab("Packages", systemImage: "shippingbox") { NavigationStack { PackagesView() } }
          Tab("Inbox", systemImage: "tray") { NavigationStack { InboxView() } }
          Tab("Settings", systemImage: "gearshape") { NavigationStack { SettingsView() } }
        }.id(store.epoch)
      }
    }
  }
}
struct SignInView: View {
  @Environment(AppStore.self) private var store
  @State private var auth = GoogleSignIn()
  @State private var googleAvailable = true
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        Image(systemName: "shippingbox.fill").font(.system(size: 66)).foregroundStyle(
          Color.doorstep
        ).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 12) {
          Text("Doorstep").font(.system(.largeTitle, design: .rounded, weight: .bold))
          Text("A little less wondering.\nEverything on its way.").font(.title2).foregroundStyle(
            .secondary)
        }
        Text(
          "Your household’s packages, delivery updates, and original emails, together in one place."
        ).font(.body)
        Button {
          Task {
            do {
              let session = try await auth.signIn(api: store.api)
              try await store.accept(session)
            } catch { store.errorMessage = store.friendly(error) }
          }
        } label: {
          HStack {
            Image(systemName: "person.crop.circle")
            Text(auth.busy ? "Signing in…" : "Continue with Google")
            Spacer()
            if auth.busy { ProgressView() } else { Image(systemName: "arrow.right") }
          }.padding(.vertical, 8)
        }
        .buttonStyle(.borderedProminent).foregroundStyle(Color(uiColor: .systemBackground))
        .disabled(auth.busy || !googleAvailable).accessibilityIdentifier("googleSignIn")
        if auth.canRetryExchange {
          Button("Finish sign-in") {
            Task {
              do {
                let session = try await auth.signIn(api: store.api, retry: true)
                try await store.accept(session)
              } catch { store.errorMessage = store.friendly(error) }
            }
          }.disabled(auth.busy)
        }
        if let error = store.errorMessage {
          Text(error).foregroundStyle(.red).accessibilityIdentifier("signInError")
        }
        Text(
          "Use the same Google account as the website. Gmail and Google Calendar connections are managed there."
        ).font(.footnote).foregroundStyle(.secondary)
        Link("Open Doorstep website", destination: Configuration.origin).frame(minHeight: 44)
      }.padding(28).padding(.top, 65).frame(maxWidth: 550, alignment: .leading).frame(
        maxWidth: .infinity)
    }.background(Color.canvas)
      .task {
        struct Config: Decodable, Sendable { var google: Bool }
        do {
          let config: Config = try await store.api.get("auth/config")
          googleAvailable = config.google
          if !config.google {
            store.errorMessage =
              "Google sign-in is temporarily unavailable. Please try again later."
          }
        } catch { store.errorMessage = store.friendly(error) }
      }
  }
}
extension Color {
  static let doorstep = Color(
    light: UIColor(red: 0.16, green: 0.35, blue: 0.94, alpha: 1),
    dark: UIColor(red: 0.52, green: 0.66, blue: 1, alpha: 1))
  static let canvas = Color(
    light: UIColor(red: 0.98, green: 0.97, blue: 0.94, alpha: 1), dark: UIColor.systemBackground)
  init(light: UIColor, dark: UIColor) {
    self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
  }
}
struct ServiceBanner: View {
  @Environment(AppStore.self) private var store
  var body: some View {
    if store.offline {
      Label(
        "Offline · last updated \(store.snapshot.map { Dates.formatter("MMM d, h:mm a", zone: store.timeZone).string(from: $0.savedAt) } ?? "unknown")",
        systemImage: "wifi.slash"
      ).font(.footnote)
      Text("Saved packages are read-only. Reconnect to view emails and make changes.").font(
        .caption
      ).foregroundStyle(.secondary)
    }
    if let error = store.errorMessage {
      Text(error).font(.callout).foregroundStyle(.red)
      Button("Try again") { Task { await store.refresh() } }.disabled(store.loading)
    }
    if let message = store.message {
      Text(message).font(.callout)
      if store.undoDismissal != nil {
        Button("Undo dismissal") { Task { await store.undo() } }.disabled(!store.canWrite)
      }
    }
  }
}
struct AuthenticatedThumbnail: View {
  @Environment(AppStore.self) private var store
  let path: String?
  @State private var data: Data?
  var body: some View {
    Group {
      if let data, let image = UIImage(data: data) {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: "shippingbox").font(.title2).foregroundStyle(Color.doorstep).frame(
          maxWidth: .infinity, maxHeight: .infinity
        ).background(Color.doorstep.opacity(0.08))
      }
    }.frame(width: 58, height: 58).clipShape(RoundedRectangle(cornerRadius: 13))
      .accessibilityHidden(true)
      .task(id: "\(store.epoch)-\(path ?? "")") {
        data = nil
        guard let path,
          path.range(of: #"^/api/assets/[a-fA-F0-9-]{36}$"#, options: .regularExpression) != nil,
          !store.offline, let household = store.householdId
        else { return }
        let epoch = store.epoch
        let response = try? await store.api.request(
          String(path.dropFirst(5)), method: "GET", body: nil, key: nil, household: household)
        if epoch == store.epoch { data = response }
      }
  }
}
struct StatusLabel: View {
  let status: String
  var body: some View {
    Label(PackageStatus.label(status), systemImage: PackageStatus.symbol(status)).font(
      .caption.weight(.semibold)
    ).foregroundStyle(status == "delivered" ? Color.secondary : Color.doorstep).padding(
      .vertical, 5)
  }
}
struct ShareSheet: UIViewControllerRepresentable {
  var items: [Any]
  var cleanup: (() -> Void)?
  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    controller.completionWithItemsHandler = { _, _, _, _ in cleanup?() }
    return controller
  }
  func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
