import Foundation
import Observation

@MainActor @Observable final class AppStore {
  let api: any DoorstepAPI
  let now: @Sendable () -> Date
  private let cache: PackageCache
  private let persistent: Bool
  private let vault = CredentialVault()
  var session: NativeSession?
  var dashboard: Dashboard?
  var snapshot: PackageSnapshot?
  var details: [String: PackageDetail] = [:]
  var loading = false
  var writing = false
  var offline = false
  var message: String?
  var errorMessage: String?
  var undoDismissal: String?
  var trackingRequested: Set<String> = []
  private var trackingBaselines: [String: String] = [:]
  var epoch = UUID()
  var retryDelay: Double = 60
  private var failures = 0
  private var followUp: Task<Void, Never>?
  var shipments: [Shipment] { dashboard?.shipments ?? snapshot?.shipments ?? [] }
  var householdId: String? { session?.householdId }
  var timeZone: String { dashboard?.settings.timeZone ?? snapshot?.timeZone ?? "America/New_York" }
  var householdName: String {
    dashboard?.settings.householdName ?? snapshot?.householdName ?? "Your household"
  }
  var canWrite: Bool { session != nil && dashboard != nil && !offline && !loading && !writing }
  init(
    api: any DoorstepAPI = APIClient(), session: NativeSession? = nil,
    cache: PackageCache = PackageCache(), persistent: Bool = true,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.api = api
    self.cache = cache
    self.persistent = persistent
    self.now = now
    self.session = session ?? (persistent ? vault.load() : nil)
    if let current = self.session {
      if (Dates.instant(current.expiresAt) ?? .distantPast) <= now() {
        self.session = nil
        if persistent {
          vault.clear()
          cache.clear()
        }
      } else {
        snapshot = cache.load(user: current.userId, household: current.householdId)
        offline = snapshot != nil
      }
    }
  }
  func start() async {
    await api.configure(session)
    if session != nil { await refresh() }
  }
  func accept(_ value: NativeSession) async throws {
    if persistent { try vault.save(value) }
    clearViews()
    session = value
    await api.configure(value)
    await refresh()
  }
  func clearViews() {
    epoch = UUID()
    dashboard = nil
    snapshot = nil
    details = [:]
    undoDismissal = nil
    trackingRequested = []
    trackingBaselines = [:]
    followUp?.cancel()
    offline = false
    message = nil
    errorMessage = nil
  }
  func signOut() async {
    guard let old = session else { return }
    PushNotifications.shared.signOut()
    clearViews()
    session = nil
    loading = false
    writing = false
    if persistent { vault.clear() }
    cache.clear()
    await api.configure(nil)
    do { try await api.revoke(old) } catch {
      if session == nil {
        errorMessage =
          "Signed out on this iPhone. Doorstep could not revoke the server session; it will expire automatically."
      }
    }
  }
  func handle(_ error: Error, capturedEpoch: UUID) async {
    guard epoch == capturedEpoch, !(error is CancellationError) else { return }
    if let failure = error as? APIError {
      if failure.status == 401 || failure.status == 403 {
        PushNotifications.shared.signOut()
        clearViews()
        session = nil
        cache.clear()
        if persistent { vault.clear() }
        await api.configure(nil)
        errorMessage = "Your sign-in or household access changed. Sign in again to continue."
        return
      }
      if failure.status == 409 && failure.message.contains("household changed") {
        clearViews()
        cache.clear()
        errorMessage = failure.message
        return
      }
      retryDelay =
        failure.status == 429 ? failure.retryAfter : min(300, 60 * pow(2, Double(failures)))
    }
    errorMessage = friendly(error)
  }
  func friendly(_ error: Error) -> String {
    if error is DecodingError {
      return
        "Doorstep returned data this version could not read. Pull to refresh, or try again later."
    }
    if error is URLError { return "Could not reach Doorstep. Check your connection and try again." }
    if let failure = error as? APIError, failure.status >= 500 {
      return
        "This service is temporarily unavailable. Try again later or check connections on the website."
    }
    return error.localizedDescription
  }
  func refresh() async {
    guard session != nil, !loading, !writing else { return }
    let captured = epoch
    loading = true
    defer { loading = false }
    do {
      let result: Dashboard = try await api.get("dashboard")
      guard captured == epoch, var current = session else { return }
      if result.settings.householdId != current.householdId {
        clearViews()
        cache.clear()
        current.householdId = result.settings.householdId
        session = current
        if persistent { try vault.save(current) }
        await api.configure(current)
      }
      for shipment in result.shipments where trackingRequested.contains(shipment.id) {
        if (shipment.lastCheckedAt ?? "") != trackingBaselines[shipment.id] {
          trackingRequested.remove(shipment.id)
          trackingBaselines.removeValue(forKey: shipment.id)
        }
      }
      dashboard = result
      offline = false
      failures = 0
      retryDelay = 60
      errorMessage = nil
      saveSnapshot()
    } catch {
      guard captured == epoch else { return }
      offline = true
      failures += 1
      retryDelay = min(300, 60 * pow(2, Double(failures)))
      // Source emails and settings are available only after a live authenticated response.
      dashboard = nil
      details = [:]
      await handle(error, capturedEpoch: captured)
    }
  }
  func saveSnapshot() {
    guard let session, let dashboard else { return }
    var cachedDetails = snapshot?.details ?? [:]
    for (id, detail) in details {
      cachedDetails[id] = CachedDetail(shipment: detail.shipment, events: detail.events)
    }
    snapshot = PackageSnapshot(
      userId: session.userId, householdId: session.householdId,
      householdName: dashboard.settings.householdName, timeZone: dashboard.settings.timeZone,
      savedAt: now(), shipments: dashboard.shipments, details: cachedDetails)
    if persistent, let snapshot { try? cache.save(snapshot) }
  }
  func loadDetail(_ id: String) async -> PackageDetail? {
    if offline, let cached = snapshot?.details[id] {
      return PackageDetail(shipment: cached.shipment, events: cached.events, emails: [])
    }
    guard let household = householdId else { return nil }
    let captured = epoch
    do {
      let detail: PackageDetail = try await api.get("shipments/" + id, household: household)
      guard captured == epoch else { return nil }
      details[id] = detail
      saveSnapshot()
      return detail
    } catch {
      await handle(error, capturedEpoch: captured)
      if let cached = snapshot?.details[id] {
        return PackageDetail(shipment: cached.shipment, events: cached.events, emails: [])
      }
      return nil
    }
  }
  func loadEmail(_ id: String) async -> InboxEmail? {
    guard !offline, let household = householdId else { return nil }
    let captured = epoch
    do {
      let email: InboxEmail = try await api.get("emails/" + id, household: household)
      return epoch == captured ? email : nil
    } catch {
      await handle(error, capturedEpoch: captured)
      return nil
    }
  }
  @discardableResult func mutate(
    _ path: String, method: String = "POST", body: Data = Data("{}".utf8), key: String? = nil
  ) async throws -> Data {
    guard canWrite, let household = householdId else {
      throw APIError(status: 0, message: "Refresh your connection before making changes.")
    }
    writing = true
    let captured = epoch
    defer { writing = false }
    do {
      let data = try await api.request(
        path, method: method, body: body, key: key, household: household)
      guard epoch == captured else { throw CancellationError() }
      details = [:]
      // Do not preserve stale detail records after a successful mutation.
      snapshot?.details = [:]
      writing = false
      await refresh()
      return data
    } catch {
      await handle(error, capturedEpoch: captured)
      throw error
    }
  }
  func action(_ shipment: Shipment, _ action: String) async {
    do {
      try await mutate("shipments/\(shipment.id)/\(action)")
      if action == "dismiss" {
        undoDismissal = shipment.id
        message = "Package dismissed."
      } else if action == "restore" {
        undoDismissal = nil
        message = "Package restored."
      } else if action == "collect" {
        message = "Package marked collected."
      } else if action == "uncollect" {
        message = "Collection undone."
      } else if action == "deliver" {
        message = "Marked delivered. Correct the delivery date in Edit details."
      } else if action == "refresh" {
        trackingRequested.insert(shipment.id)
        trackingBaselines[shipment.id] = shipment.lastCheckedAt ?? ""
        message = "Tracking check requested. Waiting for the carrier update."
        scheduleFollowUp()
      }
    } catch {}
  }
  func undo() async {
    guard let id = undoDismissal else { return }
    do {
      try await mutate("shipments/\(id)/restore")
      undoDismissal = nil
      message = "Package restored."
    } catch {}
  }
  func switchHousehold(_ id: String) async {
    guard canWrite, let previous = session else { return }
    let body = try? JSONEncoder().encode(["householdId": id])
    clearViews()
    cache.clear()
    loading = true
    let captured = epoch
    do {
      _ = try await api.request(
        "settings/household-switch", method: "POST", body: body, key: nil,
        household: previous.householdId)
      guard captured == epoch else { return }
      var next = previous
      next.householdId = id
      session = next
      if persistent { try vault.save(next) }
      await api.configure(next)
      loading = false
      await refresh()
    } catch {
      loading = false
      await handle(error, capturedEpoch: captured)
      await refresh()
    }
  }
  func scheduleFollowUp() {
    followUp?.cancel()
    followUp = Task { [weak self] in
      for delay in [5.0, 15.0, 30.0] {
        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
        guard let self, !self.offline else { return }
        await self.refresh()
      }
    }
  }
  func stopPolling() { followUp?.cancel() }
  func export() async throws -> URL {
    guard canWrite, let household = householdId else {
      throw APIError(status: 0, message: "Connect to Doorstep to export your household.")
    }
    let captured = epoch
    let data = try await api.request(
      "settings/export", method: "GET", body: nil, key: nil, household: household)
    guard captured == epoch else { throw CancellationError() }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("DoorstepExports")
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    let url = directory.appendingPathComponent("doorstep-\(UUID()).json")
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    return url
  }
}
@MainActor @Observable final class SaveAttempt {
  private(set) var key = UUID().uuidString
  private var body: Data?
  private var unresolved = false
  private(set) var saving = false
  func save(_ value: ManualPackage, id: String?, store: AppStore) async throws {
    guard !saving else { throw CancellationError() }
    if let validation = value.validation { throw APIError(status: 400, message: validation) }
    let payload = try value.payload()
    if let body, body != payload {
      if unresolved {
        throw APIError(
          status: 0,
          message:
            "The previous save may have reached Doorstep. Restore the previous details and retry that save before starting another package."
        )
      }
      key = UUID().uuidString
    }
    body = payload
    saving = true
    defer { saving = false }
    do {
      try await store.mutate(
        id.map { "shipments/" + $0 } ?? "shipments", method: id == nil ? "POST" : "PATCH",
        body: payload, key: id == nil ? key : nil)
      unresolved = false
    } catch {
      unresolved = error is URLError || (error as? APIError).map { $0.status >= 500 } == true
      throw error
    }
  }
}
