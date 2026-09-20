#if DEBUG
  import Foundation

  enum Fixture {
    static let household = "10000000-0000-0000-0000-000000000001"
    static let user = "20000000-0000-0000-0000-000000000001"
    static let clock = Dates.instant("2026-09-19T16:00:00Z")!
    static let session = NativeSession(
      token: "fixture", expiresAt: "2099-01-01T00:00:00Z", userId: user, householdId: household)
    static func shipment(
      id: String = "30000000-0000-0000-0000-000000000001", merchant: String = "Cometeer",
      status: String = "delivered"
    ) -> Shipment {
      Shipment(
        id: id, orderId: "40000000-0000-0000-0000-000000000001", merchant: merchant,
        orderNumber: "700100", orderedAt: "2026-09-14",
        items: [PackageItem(name: "House blend coffee · 32 capsules", quantity: 1)], carrier: "CDL",
        trackingNumber: "CDL12345678", trackingUrl: "https://example.com/tracking/CDL12345678",
        status: status,
        estimate: Estimate(
          kind: "date_range", start: "2026-09-19", end: "2026-09-21", timeZone: "America/New_York"),
        deliveredAt: status == "delivered" ? "2026-09-18T15:00:00Z" : nil,
        createdAt: "2026-09-15T00:00:00Z", timelineAt: "2026-09-14T12:00:00Z",
        firstEmailAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-19T10:00:00Z",
        statusAt: "2026-09-18T15:00:00Z", lastCheckedAt: "2026-09-18T15:00:00Z",
        trackingState: "active", needsReview: false, manualOverride: false, isDemo: false)
    }
    static func dashboard() -> Dashboard {
      var moving = shipment(
        id: "30000000-0000-0000-0000-000000000002", merchant: "Schoolhouse",
        status: "out_for_delivery")
      moving.items = [
        PackageItem(
          name: "A very long product name: cotton woven throw for the living room", quantity: 2)
      ]
      moving.orderNumber = "SH-20916"
      moving.timelineAt = "2026-09-17T12:00:00Z"
      moving.estimate = Estimate(
        kind: "window", start: "2026-09-19T14:00:00", end: "2026-09-19T18:00:00",
        timeZone: "America/New_York")
      var delayed = shipment(
        id: "30000000-0000-0000-0000-000000000003", merchant: "Muji", status: "delayed")
      delayed.attentionReasons = [
        "The carrier reported a weather delay.", "Tracking is overdue for a fresh check.",
      ]
      delayed.needsReview = true
      delayed.reviewReason = "The carrier reported a weather delay."
      delayed.estimate = nil
      delayed.items = [PackageItem(name: "Notebook", quantity: 3)]
      var dismissed = shipment(
        id: "30000000-0000-0000-0000-000000000004", merchant: "Archived from view",
        status: "ordered")
      dismissed.dismissedAt = "2026-09-18T00:00:00Z"
      let settings = Settings(
        householdName: "Sample household", timeZone: "America/New_York",
        forwardingAddress: "sample@example.test",
        calendarFeedUrl: "https://example.test/private-fixture-feed.ics", demo: false,
        google: .init(connected: true, calendarId: "fixture", lastSyncedAt: "2026-09-19T15:55:00Z"),
        gmail: .init(
          connected: true, email: "sample@example.test", enabled: true, needsReconnect: false,
          lastSyncedAt: "2026-09-19T15:50:00Z", importedCount: 24, importing: false),
        worker: .init(lastSeenAt: "2026-09-19T15:59:00Z", failedJobs: 0), userName: "Sample member",
        account: .init(email: "sample@example.test"), householdId: household, role: "owner",
        households: [Household(id: household, name: "Sample household", role: "owner")],
        members: [
          Member(
            userId: user, name: "Sample member", email: "sample@example.test", role: "owner",
            pending: false), Member(email: "pending@example.test", role: "member", pending: true),
        ])
      return Dashboard(
        shipments: [moving, shipment(), delayed, dismissed],
        emails: [
          InboxEmail(
            id: "50000000-0000-0000-0000-000000000001", subject: "Your Cometeer delivery arrived",
            from: "orders@example.test", receivedAt: "2026-09-19T15:00:00Z",
            sentAt: "2026-09-18T15:00:00Z", status: "processed",
            text:
              "Your order T700100 has been delivered. This synthetic email is used only for local app verification.",
            shipments: [PackageReference(id: shipment().id, merchant: "Cometeer")]),
          InboxEmail(
            id: "50000000-0000-0000-0000-000000000002",
            subject: "Your digital subscription receipt", from: "billing@example.test",
            receivedAt: "2026-09-18T10:00:00Z", status: "ignored",
            text: "This receipt is for an online digital subscription.",
            extraction: .init(
              relevant: false, reviewReason: "Digital subscription, no physical delivery.")),
        ], settings: settings)
    }
    static func detail(_ s: Shipment) -> PackageDetail {
      let sources = ["Order confirmed", "Your order shipped", "Out for delivery", "Delivered"]
      return PackageDetail(
        shipment: s,
        events: [
          TrackingEvent(
            id: "event", status: s.status, message: "Package delivered at the front door.",
            occurredAt: "2026-09-18T15:00:00Z", source: "CDL")
        ],
        emails: sources.enumerated().map { index, subject in
          SourceEmail(
            id: "email-\(index)", subject: subject, from: "orders@example.test",
            text: "Synthetic source \(index + 1) for order \(index < 2 ? "700100" : "T700100").",
            receivedAt: "2026-09-19T15:00:00Z", sentAt: "2026-09-\(14 + index)T12:00:00Z")
        })
    }
    @MainActor static func makeStore() -> AppStore {
      let args = ProcessInfo.processInfo.arguments
      let api = FixtureAPI(
        offline: args.contains("--offline"), malformed: args.contains("--malformed"))
      let cache = PackageCache(
        directory: FileManager.default.temporaryDirectory.appendingPathComponent("DoorstepFixture"))
      let dashboard = dashboard()
      if args.contains("--offline") {
        try? cache.save(
          PackageSnapshot(
            userId: user, householdId: household, householdName: dashboard.settings.householdName,
            timeZone: dashboard.settings.timeZone, savedAt: clock, shipments: dashboard.shipments,
            details: [:]))
      }
      return AppStore(
        api: api, session: args.contains("--signed-out") ? nil : session, cache: cache,
        persistent: false, now: { clock })
    }
  }
  actor FixtureAPI: DoorstepAPI {
    var value = Fixture.dashboard()
    var offline: Bool
    var malformed: Bool
    var keys: [String: String] = [:]
    var writes = 0
    init(offline: Bool = false, malformed: Bool = false) {
      self.offline = offline
      self.malformed = malformed
    }
    func configure(_ session: NativeSession?) {}
    func revoke(_ session: NativeSession) throws {
      if offline { throw URLError(.notConnectedToInternet) }
    }
    func request(_ path: String, method: String, body: Data?, key: String?, household: String?)
      async throws -> Data
    {
      if path == "auth/config" { return Data(#"{"google":true}"#.utf8) }
      if offline { throw URLError(.notConnectedToInternet) }
      if malformed { return Data("malformed".utf8) }
      if path == "notifications/preferences" {
        if method == "POST", let body { return body }
        return try JSONEncoder().encode(NotificationPreferences())
      }
      if path == "native/calendar/disconnect" {
        value.settings.google.connected = false
        value.settings.google.calendarId = nil
        return Data(#"{"ok":true}"#.utf8)
      }
      if path == "native/calendar/sync" { return Data(#"{"queued":true}"#.utf8) }
      if path == "dashboard" { return try JSONEncoder().encode(value) }
      let parts = path.split(separator: "/").map(String.init)
      if parts.first == "shipments" {
        if method == "GET", let s = value.shipments.first(where: { $0.id == parts.last }) {
          return try JSONEncoder().encode(Fixture.detail(s))
        }
        if parts.count == 3, let index = value.shipments.firstIndex(where: { $0.id == parts[1] }) {
          if parts[2] == "dismiss" { value.shipments[index].dismissedAt = "2026-09-19T16:00:00Z" }
          if parts[2] == "restore" { value.shipments[index].dismissedAt = nil }
          if parts[2] == "collect" {
            value.shipments[index].collectedAt = "2026-09-19T16:00:00Z"
            value.shipments[index].collectedByName = "Sample member"
          }
          if parts[2] == "uncollect" {
            value.shipments[index].collectedAt = nil
            value.shipments[index].collectedByName = nil
          }
          if parts[2] == "deliver" { value.shipments[index].status = "delivered" }
          if parts[2] == "merge", let body {
            let target = try JSONDecoder().decode([String: String].self, from: body)["targetId"]!
            value.shipments.remove(at: index)
            return try JSONEncoder().encode(["id": target])
          }
        }
        if parts.count <= 2, let body {
          if let key, let id = keys[key] { return try JSONEncoder().encode(["id": id]) }
          let manual = try JSONDecoder().decode(ManualPackage.self, from: body)
          var shipment = Fixture.shipment(
            id: parts.count == 2 ? parts[1] : UUID().uuidString, merchant: manual.merchant,
            status: manual.status)
          shipment.items = manual.items
          shipment.estimate = manual.estimate
          shipment.manualOverride = manual.manualOverride
          if let i = value.shipments.firstIndex(where: { $0.id == shipment.id }) {
            value.shipments[i] = shipment
          } else {
            value.shipments.insert(shipment, at: 0)
          }
          if let key { keys[key] = shipment.id }
          writes += 1
          return try JSONEncoder().encode(["id": shipment.id])
        }
      }
      if parts.first == "emails", method == "GET",
        let email = value.emails.first(where: { $0.id == parts.last })
      {
        return try JSONEncoder().encode(email)
      }
      return Data(#"{"ok":true}"#.utf8)
    }
  }
#endif
