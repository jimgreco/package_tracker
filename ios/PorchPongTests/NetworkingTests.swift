import XCTest

@testable import PorchPong

final class StubProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, [String: String], Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let (status, headers, data) = Self.handler!(request)
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
final class NetworkingTests: XCTestCase {
  func client() async -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    let client = APIClient(configuration: config)
    await client.configure(Fixture.session)
    return client
  }
  func testCredentialsAreScopedAndHouseholdIdentityRequired() async throws {
    let client = await client()
    StubProtocol.handler = { request in
      XCTAssertEqual(request.url?.host, "packages.jim-greco.com")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture")
      XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
      return (
        200, ["X-Doorstep-User": Fixture.user, "X-Doorstep-Household": "other"], Data("{}".utf8)
      )
    }
    do {
      _ = try await client.request("dashboard", household: Fixture.household)
      XCTFail("Must reject other household")
    } catch let e as APIError { XCTAssertEqual(e.status, 409) }
    do {
      _ = try await client.request("https://evil.test")
      XCTFail("Must reject foreign address")
    } catch let e as APIError { XCTAssertEqual(e.status, 400) }
  }
  func testRateLimitAndPublicRequestsNeverSendCredentials() async throws {
    let client = await client()
    StubProtocol.handler = { request in
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      return (429, ["Retry-After": "120"], Data(#"{"error":"Try later"}"#.utf8))
    }
    do {
      _ = try await client.request("native/auth/start", method: "POST", body: Data("{}".utf8))
      XCTFail("Rate limit expected")
    } catch let e as APIError {
      XCTAssertEqual(e.status, 429)
      XCTAssertEqual(e.retryAfter, 120)
      XCTAssertEqual(e.message, "Try later")
    }
  }
}
