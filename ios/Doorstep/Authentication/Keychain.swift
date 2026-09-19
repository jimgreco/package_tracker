import Foundation
import Security

struct CredentialVault: Sendable {
  private let service = "com.jimgreco.doorstep.session"
  func load() -> NativeSession? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return try? JSONDecoder().decode(NativeSession.self, from: data)
  }
  func save(_ session: NativeSession) throws {
    let data = try JSONEncoder().encode(session)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
    ]
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let result = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if result == errSecItemNotFound {
      let added = SecItemAdd(query.merging(update) { _, new in new } as CFDictionary, nil)
      guard added == errSecSuccess else {
        throw APIError(
          status: 0, message: "Could not securely save sign-in. Unlock your phone and try again.")
      }
    } else if result != errSecSuccess {
      throw APIError(status: 0, message: "Could not securely save sign-in. Try again.")
    }
  }
  func clear() {
    SecItemDelete(
      [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        as CFDictionary)
  }
}
