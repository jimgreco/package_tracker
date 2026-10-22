import XCTest
@testable import PorchPong

final class PackageListPreferencesTests: XCTestCase {
  func withStore(_ body: (PackageListPreferencesStore) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try body(PackageListPreferencesStore(directory: directory))
  }
  func testRoundTripAllFiltersAndReset() throws {
    try withStore { storage in
      for filter in PackageFilter.allCases {
        let expected = PackageListPreferences(filter: filter, search: "  FedEx SH-12.*  ")
        storage.save(expected, user: "user", household: "home")
        XCTAssertEqual(storage.load(user: "user", household: "home"), expected)
      }
      storage.save(.init(filter: .toCollect, search: "coffee"), user: "other", household: "home")
      storage.save(.init(), user: "user", household: "home")
      storage.save(.init(), user: "user", household: "home")
      XCTAssertEqual(storage.load(user: "user", household: "home"), .init())
      XCTAssertEqual(storage.load(user: "other", household: "home").search, "coffee")
      XCTAssertFalse(FileManager.default.fileExists(atPath: storage.path(user: "user", household: "home").path))
      XCTAssertEqual(try storage.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }
  }
  func testAccountHouseholdIsolationAndCorruptOrUnavailableStorage() throws {
    try withStore { storage in
      storage.save(.init(filter: .dismissed, search: "private"), user: "user", household: "home")
      XCTAssertEqual(storage.load(user: "other", household: "home"), .init())
      XCTAssertEqual(storage.load(user: "user", household: "other"), .init())
      XCTAssertNotEqual(storage.path(user: "a:b", household: "c"), storage.path(user: "a", household: "b:c"))
      let target = storage.path(user: "user", household: "home")
      for raw in ["{", "null", #"{"version":2,"filter":"Delivered","search":"old"}"#] {
        try Data(raw.utf8).write(to: target)
        XCTAssertEqual(storage.load(user: "user", household: "home"), .init())
      }
      try Data(#"{"version":1,"filter":"removed","search":"coffee"}"#.utf8).write(to: target)
      XCTAssertEqual(storage.load(user: "user", household: "home"), .init(filter: .onTheWay, search: "coffee"))
      let blocked = PackageListPreferencesStore(directory: target)
      blocked.save(.init(filter: .toCollect, search: "new"), user: "user", household: "home")
      XCTAssertEqual(blocked.load(user: "user", household: "home"), .init())
    }
  }
  @MainActor func testStoreRelaunchSwitchAccountSignOutAndReset() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = PackageListPreferencesStore(directory: directory)
    let cache = PackageCache(directory: directory.appendingPathComponent("cache"))
    let store = AppStore(api: FixtureAPI(), session: Fixture.session, cache: cache, persistent: false, listPreferencesStore: storage)
    store.updateListPreferences(filter: .toCollect, search: "coffee")
    let relaunched = AppStore(api: FixtureAPI(), session: Fixture.session, cache: cache, persistent: false, listPreferencesStore: storage)
    XCTAssertEqual(relaunched.listPreferences, .init(filter: .toCollect, search: "coffee"))
    var other = Fixture.session
    other.householdId = "other-home"
    relaunched.session = other
    XCTAssertEqual(relaunched.listPreferences, .init())
    relaunched.updateListPreferences(filter: .dismissed, search: "other household")
    other.userId = "other-user"
    relaunched.session = other
    XCTAssertEqual(relaunched.listPreferences, .init())
    relaunched.session = Fixture.session
    XCTAssertEqual(relaunched.listPreferences, .init(filter: .toCollect, search: "coffee"))
    await relaunched.signOut()
    XCTAssertEqual(relaunched.listPreferences, .init())
    relaunched.updateListPreferences(search: "signed out")
    relaunched.session = Fixture.session
    XCTAssertEqual(relaunched.listPreferences.search, "coffee")
    relaunched.resetListPreferences()
    XCTAssertEqual(storage.load(user: Fixture.user, household: Fixture.household), .init())
  }
  @MainActor func testHouseholdSwitchRefreshAndFailureKeepPreferencesScoped() async {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let api = PreferencesFixtureAPI()
    let store = AppStore(
      api: api, session: Fixture.session,
      cache: PackageCache(directory: directory.appendingPathComponent("cache")), persistent: false,
      listPreferencesStore: PackageListPreferencesStore(directory: directory))
    await store.start()
    store.updateListPreferences(filter: .delivered, search: "coffee")
    await store.switchHousehold("other-home")
    XCTAssertEqual(store.session?.householdId, "other-home")
    XCTAssertEqual(store.listPreferences, .init())
    store.updateListPreferences(filter: .dismissed, search: "other-home query")
    await store.refresh()
    XCTAssertEqual(store.listPreferences.search, "other-home query")
    await api.failNextSwitch()
    await store.switchHousehold(Fixture.household)
    XCTAssertEqual(store.session?.householdId, "other-home")
    XCTAssertEqual(store.listPreferences.search, "other-home query")
    await store.switchHousehold(Fixture.household)
    XCTAssertEqual(store.listPreferences, .init(filter: .delivered, search: "coffee"))
    await store.switchHousehold("other-home")
    XCTAssertEqual(store.listPreferences, .init(filter: .dismissed, search: "other-home query"))
  }
  @MainActor func testUnavailableStorageKeepsSameAccountPreferencesInMemory() throws {
    let blocked = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data().write(to: blocked)
    defer { try? FileManager.default.removeItem(at: blocked) }
    let store = AppStore(api: FixtureAPI(), session: Fixture.session,
      cache: PackageCache(directory: blocked.appendingPathComponent("cache")), persistent: false,
      listPreferencesStore: PackageListPreferencesStore(directory: blocked))
    store.updateListPreferences(filter: .toCollect, search: "coffee")
    store.session = Fixture.session
    XCTAssertEqual(store.listPreferences, .init(filter: .toCollect, search: "coffee"))
    store.session = nil
    XCTAssertEqual(store.listPreferences, .init())
  }
}

private actor PreferencesFixtureAPI: PorchPongAPI {
  var dashboard = Fixture.dashboard()
  var shouldFailSwitch = false
  func failNextSwitch() { shouldFailSwitch = true }
  func configure(_ session: NativeSession?) {}
  func revoke(_ session: NativeSession) {}
  func request(_ path: String, method: String, body: Data?, key: String?, household: String?) async throws -> Data {
    if path == "settings/household-switch" {
      if shouldFailSwitch {
        shouldFailSwitch = false
        throw URLError(.networkConnectionLost)
      }
      let value = try JSONDecoder().decode([String: String].self, from: body!)
      dashboard.settings.householdId = value["householdId"]!
      return Data(#"{"ok":true}"#.utf8)
    }
    return try JSONEncoder().encode(dashboard)
  }
}
