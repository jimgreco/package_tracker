import CryptoKit
import Foundation

struct PackageListPreferences: Equatable, Sendable {
  var filter = PackageFilter.onTheWay
  var search = ""
  var isDefault: Bool { filter == .onTheWay && search.isEmpty }
}

// Preferences are device-local and partitioned by authenticated user and household.
// Search text stays in a protected file, excluded from device backups.
struct PackageListPreferencesStore: Sendable {
  var directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("PorchPongListPreferences", isDirectory: true)
  private struct Record: Codable {
    var version: Int
    var filter: String
    var search: String
  }
  func path(user: String, household: String) -> URL {
    let scope = (try? JSONEncoder().encode([user, household])) ?? Data()
    return directory.appendingPathComponent(Data(SHA256.hash(data: scope)).base64URL + ".json")
  }
  func load(user: String, household: String) -> PackageListPreferences {
    guard !user.isEmpty, !household.isEmpty,
      let data = try? Data(contentsOf: path(user: user, household: household)),
      let value = try? JSONDecoder().decode(Record.self, from: data), value.version == 1
    else { return PackageListPreferences() }
    return PackageListPreferences(
      filter: PackageFilter(rawValue: value.filter) ?? .onTheWay,
      search: String(value.search.prefix(256)))
  }
  func save(_ preferences: PackageListPreferences, user: String, household: String) {
    guard !user.isEmpty, !household.isEmpty else { return }
    let target = path(user: user, household: household)
    if preferences.isDefault {
      try? FileManager.default.removeItem(at: target)
      return
    }
    do {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete])
      var protected = directory
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try protected.setResourceValues(values)
      let record = Record(version: 1, filter: preferences.filter.rawValue, search: String(preferences.search.prefix(256)))
      try JSONEncoder().encode(record).write(to: target, options: [.atomic, .completeFileProtection])
    } catch {
      // A locked or full device must not stop in-memory searching/filtering.
    }
  }
}
