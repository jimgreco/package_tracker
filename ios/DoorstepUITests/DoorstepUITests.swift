import XCTest

@MainActor final class DoorstepUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
  }
  func launch(_ args: [String] = []) {
    app.launchArguments = ["--fixture"] + args
    app.launch()
  }
  func screenshot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func reveal(_ element: XCUIElement) {
    for _ in 0..<12 {
      if element.exists && element.isHittable { return }
      app.swipeUp()
    }
  }
  func testSignInLanding() {
    launch(["--signed-out"])
    XCTAssertTrue(app.buttons["googleSignIn"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Doorstep"].exists)
    screenshot("sign-in")
  }
  func testPackagesSearchFilterAndDetail() {
    launch()
    XCTAssertTrue(app.staticTexts["Schoolhouse"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["packageFilter"].label.hasPrefix("On the way"))
    XCTAssertFalse(app.staticTexts["Cometeer"].exists)
    screenshot("packages")
    app.buttons["packageFilter"].tap()
    let first = app.buttons["On the way (2)"]
    let last = app.buttons["All packages (3)"]
    XCTAssertTrue(first.exists)
    XCTAssertTrue(last.exists)
    XCTAssertLessThan(first.frame.minY, last.frame.minY)
    screenshot("package-filter-order")
    last.tap()
    let search = app.searchFields.firstMatch
    search.tap()
    search.typeText("Cometeer")
    XCTAssertTrue(app.staticTexts["Cometeer"].exists)
    XCTAssertFalse(app.staticTexts["Schoolhouse"].exists)
    app.staticTexts["Cometeer"].tap()
    XCTAssertTrue(app.buttons["Copy order number"].waitForExistence(timeout: 5))
    screenshot("package-detail")
    reveal(app.buttons["Edit details"])
    XCTAssertTrue(app.buttons["Edit details"].isHittable)
    app.buttons["Edit details"].tap()
    XCTAssertTrue(app.textFields["merchantField"].waitForExistence(timeout: 3))
    screenshot("edit-details")
  }
  func testMarkDeliveredAndEdit() {
    launch()
    XCTAssertTrue(app.staticTexts["Schoolhouse"].waitForExistence(timeout: 5))
    app.staticTexts["Schoolhouse"].tap()
    reveal(app.buttons["Mark delivered"])
    app.buttons["Mark delivered"].tap()
    reveal(app.buttons["Edit details"])
    app.buttons["Edit details"].tap()
    let merchant = app.textFields["merchantField"]
    XCTAssertTrue(merchant.waitForExistence(timeout: 5))
    merchant.tap()
    merchant.typeText(" Updated")
    app.buttons["savePackage"].tap()
    for _ in 0..<10 {
      app.swipeDown()
      if app.staticTexts["Schoolhouse Updated"].isHittable { break }
    }
    XCTAssertTrue(app.staticTexts["Schoolhouse Updated"].exists)
    XCTAssertTrue(app.staticTexts["Delivered"].firstMatch.exists)
    screenshot("delivered-and-edited")
  }
  func testFilterAndDismissUndo() {
    launch()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    app.buttons["packageFilter"].tap()
    app.buttons["Delivered (1)"].tap()
    XCTAssertTrue(app.staticTexts["Cometeer"].exists)
    XCTAssertFalse(app.staticTexts["Schoolhouse"].exists)
    app.staticTexts["Cometeer"].tap()
    reveal(app.buttons["Dismiss package"])
    app.buttons["Dismiss package"].tap()
    let undo = app.buttons["Undo dismissal"]
    // The confirmation is at the top of detail; scroll back to its banner.
    if !undo.isHittable {
      for _ in 0..<10 {
        app.swipeDown()
        if undo.isHittable { break }
      }
    }
    XCTAssertTrue(undo.exists)
    undo.tap()
    screenshot("dismiss-restored")
  }
  func testCreateValidationAndSave() {
    launch()
    XCTAssertTrue(app.buttons["addPackage"].waitForExistence(timeout: 5))
    app.buttons["addPackage"].tap()
    app.buttons["savePackage"].tap()
    XCTAssertTrue(app.staticTexts["formError"].waitForExistence(timeout: 3))
    app.textFields["merchantField"].tap()
    app.textFields["merchantField"].typeText("Local bookstore")
    app.textFields["itemField0"].tap()
    app.textFields["itemField0"].typeText("Novel")
    app.buttons["savePackage"].tap()
    XCTAssertTrue(app.staticTexts["Local bookstore"].waitForExistence(timeout: 5))
    screenshot("created-package")
  }
  func testInboxAndSettings() {
    launch()
    app.tabBars.buttons["Inbox"].tap()
    XCTAssertTrue(app.staticTexts["Your Cometeer delivery arrived"].waitForExistence(timeout: 5))
    screenshot("inbox")
    app.staticTexts["Your Cometeer delivery arrived"].tap()
    XCTAssertTrue(app.staticTexts["Original sent date"].waitForExistence(timeout: 5))
    screenshot("email-detail")
    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.staticTexts["sample@example.test"].firstMatch.waitForExistence(timeout: 5))
    screenshot("settings")
    let manage = app.buttons["Manage connections on website"]
    reveal(manage)
    XCTAssertTrue(manage.exists)
    screenshot("connections")
  }
  func testOfflineAndMalformedStates() {
    launch(["--offline"])
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Offline · last updated'"))
        .firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["addPackage"].isEnabled)
    screenshot("offline")
    app.terminate()
    launch(["--malformed"])
    XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 5))
    screenshot("malformed-response")
  }
  func testAccessibilityLargeText() throws {
    launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    screenshot("large-text-packages")
    app.buttons["addPackage"].tap()
    XCTAssertTrue(app.buttons["savePackage"].isHittable)
    screenshot("large-text-form")
    try app.performAccessibilityAudit(for: [.textClipped, .sufficientElementDescription])
  }
}
