import AuthenticationServices
import Observation

@MainActor @Observable
final class GoogleCalendarConnection: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var webSession: ASWebAuthenticationSession?
  var busy = false
  static func validate(_ callback: URL, state: String) throws -> Bool {
    guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
      parts.scheme == "com.jimgreco.doorstep", parts.host == nil,
      parts.path == "/calendar/callback", parts.fragment == nil
    else {
      throw APIError(status: 400, message: "Calendar connection could not be verified.")
    }
    let values = parts.queryItems ?? []
    guard values.filter({ $0.name == "state" }).count == 1,
      values.first(where: { $0.name == "state" })?.value == state,
      values.filter({ $0.name == "result" }).count == 1
    else {
      throw APIError(status: 400, message: "Calendar connection could not be verified.")
    }
    switch values.first(where: { $0.name == "result" })?.value {
    case "connected": return true
    case "cancelled": return false
    default:
      throw APIError(
        status: 400,
        message:
          "Google Calendar could not connect. Try again using the Google account that owns your delivery calendar."
      )
    }
  }
  func connect(api: any DoorstepAPI, household: String) async throws -> Bool {
    guard !busy else { throw CancellationError() }
    busy = true
    defer {
      busy = false
      webSession = nil
    }
    let state = try GoogleSignIn.random()
    let body = try JSONEncoder().encode(["state": state])
    struct Start: Decodable { var url: URL }
    let data = try await api.request(
      "native/calendar/start", method: "POST", body: body, key: nil, household: household)
    let url = try JSONDecoder().decode(Start.self, from: data).url
    guard url.scheme == Configuration.origin.scheme, url.host == Configuration.origin.host,
      url.port == Configuration.origin.port, url.path == "/api/native/calendar/authorize"
    else {
      throw APIError(status: 400, message: "Calendar connection address could not be verified.")
    }
    do {
      let callback: URL = try await withCheckedThrowingContinuation { continuation in
        let session = ASWebAuthenticationSession(
          url: url, callbackURLScheme: "com.jimgreco.doorstep"
        ) { url, error in
          if let url {
            continuation.resume(returning: url)
          } else {
            continuation.resume(throwing: error ?? CancellationError())
          }
        }
        session.presentationContextProvider = self
        webSession = session
        if !session.start() {
          continuation.resume(
            throwing: APIError(status: 0, message: "Could not open Google Calendar authorization."))
        }
      }
      return try Self.validate(callback, state: state)
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      return false
    }
  }
  func cancel() { webSession?.cancel() }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
  }
}
