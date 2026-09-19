import CryptoKit
import Foundation

// Explicit allowlist: never persist dashboard settings, feed links, inbox, email bodies or credentials.
struct CachedDetail: Codable, Sendable {
  var shipment: Shipment
  var events: [TrackingEvent]
}
struct PackageSnapshot: Codable, Sendable {
  var userId: String
  var householdId: String
  var householdName: String
  var timeZone: String
  var savedAt: Date
  var shipments: [Shipment]
  var details: [String: CachedDetail]
}
struct PackageCache: Sendable {
  var directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Doorstep", isDirectory: true)
  func path(user: String, household: String) -> URL {
    directory.appendingPathComponent(
      Data(SHA256.hash(data: Data((user + ":" + household).utf8))).base64URL + ".json")
  }
  func load(user: String, household: String) -> PackageSnapshot? {
    guard let data = try? Data(contentsOf: path(user: user, household: household)),
      let value = try? JSONDecoder().decode(PackageSnapshot.self, from: data), value.userId == user,
      value.householdId == household
    else { return nil }
    return value
  }
  func save(_ snapshot: PackageSnapshot) throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    var protected = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try protected.setResourceValues(values)
    try JSONEncoder().encode(snapshot).write(
      to: path(user: snapshot.userId, household: snapshot.householdId),
      options: [.atomic, .completeFileProtection])
  }
  func clear() { try? FileManager.default.removeItem(at: directory) }
}
