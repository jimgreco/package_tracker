import Foundation

struct APIError: Error, LocalizedError, Sendable {
  var status: Int
  var message: String
  var retryAfter: TimeInterval = 60
  var errorDescription: String? { message }
  static let changed = APIError(
    status: 409, message: "Your household changed. Refresh to continue.")
}
protocol DoorstepAPI: Sendable {
  func revoke(_ session: NativeSession) async throws
  func configure(_ session: NativeSession?) async
  func request(_ path: String, method: String, body: Data?, key: String?, household: String?)
    async throws -> Data
}
extension DoorstepAPI {
  func get<T: Decodable & Sendable>(_ path: String, household: String? = nil) async throws -> T {
    try JSONDecoder().decode(
      T.self, from: await request(path, method: "GET", body: nil, key: nil, household: household))
  }
}
final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
actor APIClient: DoorstepAPI {
  let origin: URL
  private var credentials: NativeSession?
  private let transport: URLSession
  init(origin: URL = Configuration.origin, configuration: URLSessionConfiguration = .ephemeral) {
    self.origin = origin
    let config = configuration
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 45
    transport = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
  }
  func configure(_ session: NativeSession?) { credentials = session }
  func revoke(_ session: NativeSession) async throws {
    let revoker = APIClient(origin: origin)
    await revoker.configure(session)
    _ = try await revoker.request("native/auth/logout", method: "POST", body: Data("{}".utf8))
  }
  func request(
    _ path: String, method: String = "GET", body: Data? = nil, key: String? = nil,
    household: String? = nil
  ) async throws -> Data {
    guard !path.contains(".."), !path.contains(":"), !path.hasPrefix("/"),
      let url = URL(string: "api/" + path, relativeTo: origin.appendingPathComponent("/"))?
        .absoluteURL,
      url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port
    else { throw APIError(status: 400, message: "Invalid Doorstep address.") }
    let isPublic = ["auth/config", "native/auth/start", "native/auth/exchange"].contains(path)
    let captured = credentials
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.httpBody = body
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if !isPublic {
      guard let captured else { throw APIError(status: 401, message: "Sign in to your household.") }
      req.setValue("Bearer " + captured.token, forHTTPHeaderField: "Authorization")
      if let household { req.setValue(household, forHTTPHeaderField: "X-Doorstep-Household") }
    }
    if let key { req.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
    let (data, response) = try await transport.data(for: req)
    guard captured == credentials else { throw CancellationError() }
    guard let http = response as? HTTPURLResponse else {
      throw APIError(status: 502, message: "Doorstep returned an unreadable response.")
    }
    guard (200..<300).contains(http.statusCode) else {
      struct Failure: Decodable { var error: String }
      let message =
        (try? JSONDecoder().decode(Failure.self, from: data).error)
        ?? "Doorstep is unavailable. Try again shortly."
      throw APIError(
        status: http.statusCode, message: message,
        retryAfter: max(1, Double(http.value(forHTTPHeaderField: "Retry-After") ?? "60") ?? 60))
    }
    if !isPublic {
      guard http.value(forHTTPHeaderField: "X-Doorstep-User") == captured?.userId else {
        throw APIError(status: 401, message: "Your account changed. Please sign in again.")
      }
      if let household, http.value(forHTTPHeaderField: "X-Doorstep-Household") != household {
        throw APIError.changed
      }
    }
    guard data.count <= 30_000_000 else {
      throw APIError(status: 413, message: "This response is too large to open on your phone.")
    }
    return data
  }
}
enum Configuration {
  static let origin: URL = {
    #if DEBUG
      let configured =
        Bundle.main.object(forInfoDictionaryKey: "DoorstepAPIOrigin") as? String
        ?? "https://packages.jim-greco.com"
      return URL(string: configured)!
    #else
      return URL(string: "https://packages.jim-greco.com")!
    #endif
  }()
  static var websiteSettings: URL {
    URL(string: "/?view=settings", relativeTo: origin)!.absoluteURL
  }
}
