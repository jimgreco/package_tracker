import XCTest

@testable import Doorstep

final class ModelTests: XCTestCase {
  func testDashboardAndSeparateSourceEmailDecoding() throws {
    let data = try JSONEncoder().encode(Fixture.dashboard())
    let decoded = try JSONDecoder().decode(Dashboard.self, from: data)
    XCTAssertEqual(decoded.shipments.count, 4)
    let detail = try JSONDecoder().decode(
      PackageDetail.self, from: JSONEncoder().encode(Fixture.detail(Fixture.shipment())))
    XCTAssertEqual(detail.emails.count, 4)
    XCTAssertEqual(detail.emails[0].subject, "Order confirmed")
    var value = Fixture.shipment()
    value.status = "carrier_custom_state"
    let unknown = try JSONDecoder().decode(Shipment.self, from: JSONEncoder().encode(value))
    XCTAssertEqual(PackageStatus.label(unknown.status), "Carrier Custom State")
  }
  func testFilterParitySearchAndStableTimeline() {
    let shipments = Fixture.dashboard().shipments
    XCTAssertEqual(PackageFilter.all.results(shipments).count, 3)
    XCTAssertEqual(PackageFilter.onTheWay.results(shipments).count, 2)
    XCTAssertEqual(PackageFilter.attention.results(shipments).count, 1)
    XCTAssertEqual(PackageFilter.delivered.results(shipments).count, 1)
    XCTAssertEqual(PackageFilter.dismissed.results(shipments).count, 1)
    XCTAssertEqual(PackageFilter.all.results(shipments, search: "700100").count, 2)
    XCTAssertEqual(PackageFilter.all.results(shipments, search: "capsules").count, 1)
    var noTracking = shipments[0]
    noTracking.trackingNumber = nil
    XCTAssertFalse(PackageFilter.attention.includes(noTracking))
    var updated = shipments[1]
    updated.updatedAt = "2099-01-01T00:00:00Z"
    XCTAssertEqual(
      [updated, shipments[0]].sorted(by: Shipment.newestFirst).first?.id, shipments[0].id)
    updated.archivedAt = "2026-09-19T00:00:00Z"
    XCTAssertFalse(PackageFilter.all.includes(updated))
  }
  func testDateAndEstimateKindsDestinationZoneAndDST() {
    let now = Fixture.clock
    XCTAssertEqual(Dates.instant("2026-09-19T16:00:00.000Z"), Dates.instant("2026-09-19T16:00:00Z"))
    XCTAssertNil(Dates.instant("2026-09-19"))
    XCTAssertNil(Dates.dateOnly("2026-02-30", zone: "UTC"))
    XCTAssertTrue(Dates.day("2026-09-19", zone: "Pacific/Honolulu").contains("Sep 19"))
    func estimate(_ kind: String, _ start: String, _ end: String? = nil) -> String {
      Dates.estimate(
        Estimate(kind: kind, start: start, end: end, timeZone: "America/New_York"), now: now,
        phoneZone: "America/New_York")
    }
    XCTAssertEqual(estimate("date", "2026-09-22"), "Expected Sep 22")
    XCTAssertEqual(estimate("date_range", "2026-09-22", "2026-09-24"), "Expected Sep 22–Sep 24")
    XCTAssertEqual(
      estimate("window", "2026-09-19T14:00:00", "2026-09-19T18:00:00"), "Today, 2:00 PM–6:00 PM")
    XCTAssertEqual(estimate("point", "2026-09-19T14:00:00"), "Expected Today, 2:00 PM")
    XCTAssertEqual(estimate("deadline", "2026-09-19T18:00:00"), "By Today, 6:00 PM")
    XCTAssertEqual(Dates.estimate(nil, now: now), "Delivery date not yet known")
    XCTAssertTrue(
      Dates.estimate(
        Estimate(kind: "point", start: "2026-09-19T14:00:00", timeZone: "America/Los_Angeles"),
        now: now, phoneZone: "America/New_York"
      ).contains("America/Los Angeles"))
    XCTAssertNil(Dates.local("2026-03-08T02:30:00", zone: "America/New_York"))
    XCTAssertNil(Dates.local("2026-11-01T01:30:00", zone: "America/New_York"))
    XCTAssertNotNil(Dates.local("2026-11-01T01:30:00-04:00", zone: "America/New_York"))
    var s = Fixture.shipment(status: "in_transit")
    s.estimate = nil
    XCTAssertFalse(Dates.arrivingToday(s, zone: "America/New_York", now: now))
    s.estimate = Estimate(
      kind: "date_range", start: "2026-09-18", end: "2026-09-19", timeZone: "America/New_York")
    XCTAssertTrue(Dates.arrivingToday(s, zone: "America/New_York", now: now))
  }
  func testManualPayloadPreservesNullsAndOverride() throws {
    var source = Fixture.shipment()
    source.manualOverride = true
    let manual = ManualPackage(source)
    let data = try manual.payload()
    let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    XCTAssertEqual(object["manualOverride"] as? Bool, true)
    XCTAssertTrue(object["shippedAt"] is NSNull)
    XCTAssertEqual(manual.items, source.items)
    XCTAssertNotNil(ManualPackage().validation)
  }
  func testCacheIsolationAndExcludesSecrets() throws {
    let cache = PackageCache(
      directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    defer { cache.clear() }
    let d = Fixture.dashboard()
    let snapshot = PackageSnapshot(
      userId: "one", householdId: "house", householdName: "Sample", timeZone: "UTC",
      savedAt: Fixture.clock, shipments: d.shipments,
      details: ["detail": CachedDetail(shipment: d.shipments[0], events: [])])
    try cache.save(snapshot)
    XCTAssertNotNil(cache.load(user: "one", household: "house"))
    XCTAssertNil(cache.load(user: "two", household: "house"))
    XCTAssertNil(cache.load(user: "one", household: "other"))
    let text = String(
      data: try Data(contentsOf: cache.path(user: "one", household: "house")), encoding: .utf8)!
    for forbidden in [
      "calendarFeedUrl", "private-fixture-feed", "Original email", "token", "sample@example.test",
    ] { XCTAssertFalse(text.contains(forbidden)) }
    cache.clear()
    XCTAssertNil(cache.load(user: "one", household: "house"))
  }
}
@MainActor final class SessionTests: XCTestCase {
  func testNativeCallbackValidation() throws {
    let state = String(repeating: "a", count: 43)
    let code = String(repeating: "b", count: 64)
    XCTAssertEqual(
      try GoogleSignIn.validate(
        URL(string: "com.jimgreco.doorstep:/auth/callback?state=\(state)&code=\(code)")!,
        state: state), code)
    XCTAssertThrowsError(
      try GoogleSignIn.validate(
        URL(string: "com.jimgreco.doorstep:/auth/callback?state=wrong&code=\(code)")!, state: state)
    )
    XCTAssertThrowsError(
      try GoogleSignIn.validate(
        URL(string: "evil:/auth/callback?state=\(state)&code=\(code)")!, state: state))
    XCTAssertThrowsError(
      try GoogleSignIn.validate(
        URL(string: "com.jimgreco.doorstep:/auth/callback?state=\(state)&error=signin_failed")!,
        state: state))
  }
  func testSessionExpiryAndOfflineSignout() async throws {
    var expired = Fixture.session
    expired.expiresAt = "2020-01-01T00:00:00Z"
    let store = AppStore(
      api: FixtureAPI(), session: expired, persistent: false, now: { Fixture.clock })
    XCTAssertNil(store.session)
    let offline = AppStore(
      api: FixtureAPI(offline: true), session: Fixture.session, persistent: false,
      now: { Fixture.clock })
    await offline.start()
    XCTAssertTrue(offline.offline)
    XCTAssertFalse(offline.canWrite)
    await offline.signOut()
    XCTAssertNil(offline.session)
    XCTAssertTrue(offline.shipments.isEmpty)
    XCTAssertTrue(offline.errorMessage?.contains("could not revoke") == true)
  }
  func testDuplicateSaveAndPreservedServerData() async throws {
    let api = FixtureAPI()
    let store = AppStore(
      api: FixtureAPI(), session: Fixture.session, persistent: false, now: { Fixture.clock })
    let target = AppStore(
      api: api, session: Fixture.session, persistent: false, now: { Fixture.clock })
    await target.start()
    let attempt = SaveAttempt()
    var manual = ManualPackage()
    manual.merchant = "New merchant"
    manual.items = [PackageItem(name: "Book", quantity: 1)]
    try await attempt.save(manual, id: nil, store: target)
    try await attempt.save(manual, id: nil, store: target)
    let count = await api.writes
    XCTAssertEqual(count, 1)
    XCTAssertEqual(target.shipments.filter { $0.merchant == "New merchant" }.count, 1)
    await store.start()
    let source = store.shipments[0]
    await store.action(source, "dismiss")
    XCTAssertEqual(store.shipments.first { $0.id == source.id }?.status, source.status)
    await store.undo()
    XCTAssertNil(store.shipments.first { $0.id == source.id }?.dismissedAt)
  }
  func testMalformedResponseAndPermissionFailureClearData() async {
    let malformed = AppStore(
      api: FixtureAPI(malformed: true), session: Fixture.session, persistent: false,
      now: { Fixture.clock })
    await malformed.start()
    XCTAssertTrue(malformed.offline)
    XCTAssertTrue(malformed.errorMessage?.contains("could not read") == true)
    let store = AppStore(
      api: FixtureAPI(), session: Fixture.session, persistent: false, now: { Fixture.clock })
    await store.start()
    XCTAssertFalse(store.shipments.isEmpty)
    await store.handle(APIError(status: 401, message: "expired"), capturedEpoch: store.epoch)
    XCTAssertNil(store.session)
    XCTAssertNil(store.snapshot)
    XCTAssertTrue(store.shipments.isEmpty)
  }
  func testPollingWaitsForMutationBeforeReconciliation() async throws {
    let api = BlockingWriteAPI()
    let store = AppStore(
      api: api, session: Fixture.session, persistent: false, now: { Fixture.clock })
    await store.start()
    let write = Task { try await store.mutate("settings/retry-jobs") }
    while !(await api.waiting) { await Task.yield() }
    await store.refresh()
    let before = await api.reads
    XCTAssertEqual(before, 1)
    await api.finish()
    _ = try await write.value
    let after = await api.reads
    XCTAssertEqual(after, 2)
    XCTAssertFalse(store.writing)
  }
  func testLostCreateResponseRetriesSameAttempt() async throws {
    let api = LostResponseAPI()
    let store = AppStore(
      api: LostResponseAPI(), session: Fixture.session, persistent: false, now: { Fixture.clock })
    let target = AppStore(
      api: api, session: Fixture.session, persistent: false, now: { Fixture.clock })
    await target.start()
    let save = SaveAttempt()
    var manual = ManualPackage()
    manual.merchant = "Lost response fixture"
    manual.items = [PackageItem(name: "Book", quantity: 1)]
    do {
      try await save.save(manual, id: nil, store: target)
      XCTFail("First reply should be lost")
    } catch {}
    let key = save.key
    try await save.save(manual, id: nil, store: target)
    XCTAssertEqual(key, save.key)
    let count = await api.savedCount()
    XCTAssertEqual(count, 1)
    XCTAssertEqual(target.shipments.filter { $0.merchant == "Lost response fixture" }.count, 1)
    XCTAssertNotNil(store.session)
  }
  func testStaleHouseholdResponseIsDiscarded() async throws {
    let api = DelayedAPI()
    let store = AppStore(
      api: DelayedAPI(), session: Fixture.session, persistent: false, now: { Fixture.clock })
    let target = AppStore(
      api: api, session: Fixture.session, persistent: false, now: { Fixture.clock })
    let load = Task { await target.refresh() }
    while !(await api.waiting) { await Task.yield() }
    target.clearViews()
    try await api.complete(Fixture.dashboard())
    await load.value
    XCTAssertNil(target.dashboard)
    XCTAssertNil(target.snapshot)
    XCTAssertEqual(store.session?.householdId, Fixture.household)
  }
}
actor DelayedAPI: DoorstepAPI {
  var continuation: CheckedContinuation<Data, any Error>?
  var waiting: Bool { continuation != nil }
  func configure(_ session: NativeSession?) {}
  func revoke(_ session: NativeSession) {}
  func request(_ path: String, method: String, body: Data?, key: String?, household: String?)
    async throws -> Data
  { try await withCheckedThrowingContinuation { continuation = $0 } }
  func complete(_ dashboard: Dashboard) throws {
    continuation?.resume(returning: try JSONEncoder().encode(dashboard))
    continuation = nil
  }
}

actor LostResponseAPI: DoorstepAPI {
  let base = FixtureAPI()
  var lose = true
  func configure(_ session: NativeSession?) async { await base.configure(session) }
  func revoke(_ session: NativeSession) async throws { try await base.revoke(session) }
  func savedCount() async -> Int { await base.writes }
  func request(_ path: String, method: String, body: Data?, key: String?, household: String?)
    async throws -> Data
  {
    let response = try await base.request(
      path, method: method, body: body, key: key, household: household)
    if path == "shipments", method == "POST", lose {
      lose = false
      throw URLError(.networkConnectionLost)
    }
    return response
  }
}

actor BlockingWriteAPI: DoorstepAPI {
  var continuation: CheckedContinuation<Data, Never>?
  var waiting: Bool { continuation != nil }
  var reads = 0
  func configure(_ session: NativeSession?) {}
  func revoke(_ session: NativeSession) {}
  func request(_ path: String, method: String, body: Data?, key: String?, household: String?)
    async throws -> Data
  {
    if method == "GET" {
      reads += 1
      return try JSONEncoder().encode(Fixture.dashboard())
    }
    return await withCheckedContinuation { continuation = $0 }
  }
  func finish() {
    continuation?.resume(returning: Data("{}".utf8))
    continuation = nil
  }
}
