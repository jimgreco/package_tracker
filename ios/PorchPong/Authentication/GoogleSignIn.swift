import AuthenticationServices
import CryptoKit
import Observation

@MainActor @Observable
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var webSession: ASWebAuthenticationSession?
  private var pending: Attempt?
  var busy = false
  var canRetryExchange: Bool { pending?.code != nil }
  struct Attempt {
    var state: String
    var verifier: String
    var code: String?
  }
  static func random() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw APIError(status: 0, message: "Could not start secure sign-in. Try again.")
    }
    return Data(bytes).base64URL
  }
  static func validate(_ callback: URL, state: String) throws -> String {
    guard callback.scheme == "com.jimgreco.doorstep", callback.host == nil,
      callback.path == "/auth/callback",
      let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false)
    else { throw APIError(status: 400, message: "Invalid sign-in response. Please try again.") }
    let values = parts.queryItems ?? []
    guard values.filter({ $0.name == "state" }).count == 1,
      values.first(where: { $0.name == "state" })?.value == state
    else {
      throw APIError(status: 400, message: "Sign-in could not be verified. Please try again.")
    }
    guard !values.contains(where: { $0.name == "error" }),
      values.filter({ $0.name == "code" }).count == 1,
      let code = values.first(where: { $0.name == "code" })?.value,
      code.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    else {
      throw APIError(
        status: 400, message: "Google sign-in did not finish. Please try again when you’re ready.")
    }
    return code
  }
  func signIn(api: any PorchPongAPI, retry: Bool = false) async throws -> NativeSession {
    guard !busy else { throw CancellationError() }
    busy = true
    defer {
      busy = false
      webSession = nil
    }
    if !retry || pending?.code == nil {
      pending = nil
      let state = try Self.random()
      let verifier = try Self.random()
      let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
      let body = try JSONEncoder().encode(["state": state, "challenge": challenge])
      struct Start: Decodable { var url: URL }
      let data = try await api.request(
        "native/auth/start", method: "POST", body: body, key: nil, household: nil)
      let url = try JSONDecoder().decode(Start.self, from: data).url
      guard url.scheme == Configuration.origin.scheme, url.host == Configuration.origin.host,
        url.port == Configuration.origin.port, url.path == "/api/native/auth/authorize"
      else { throw APIError(status: 400, message: "Sign-in address could not be verified.") }
      pending = Attempt(state: state, verifier: verifier)
      let callback: URL = try await withCheckedThrowingContinuation { continuation in
        let session = ASWebAuthenticationSession(
          url: url, callbackURLScheme: "com.jimgreco.doorstep"
        ) { url, error in
          if let url {
            continuation.resume(returning: url)
          } else if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(throwing: CancellationError())
          }
        }
        session.presentationContextProvider = self
        webSession = session
        if !session.start() {
          continuation.resume(
            throwing: APIError(status: 0, message: "Could not open Google sign-in. Try again."))
        }
      }
      pending?.code = try Self.validate(callback, state: state)
    }
    guard let attempt = pending, let code = attempt.code else { throw CancellationError() }
    do {
      let body = try JSONEncoder().encode([
        "state": attempt.state, "verifier": attempt.verifier, "code": code,
      ])
      let data = try await api.request(
        "native/auth/exchange", method: "POST", body: body, key: nil, household: nil)
      let session = try JSONDecoder().decode(NativeSession.self, from: data)
      pending = nil
      return session
    } catch let error as APIError {
      if error.status == 401 { pending = nil }
      throw error
    }
  }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }
}
extension Data {
  var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
}
