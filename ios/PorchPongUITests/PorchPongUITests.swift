import XCTest

@MainActor final class PorchPongUITests: XCTestCase {
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
  func testWalkthrough() {
    launch(["--walkthrough"])
    XCTAssertTrue(app.staticTexts["Welcome to PorchPong"].waitForExistence(timeout: 8))
    screenshot("walkthrough-overview")
    let next = app.buttons["walkthroughContinue"]
    reveal(next)
    next.tap()
    XCTAssertTrue(app.staticTexts["A heads-up when it matters"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["walkthroughEnableNotifications"].exists)
    screenshot("walkthrough-notifications")
    reveal(next)
    next.tap()
    XCTAssertTrue(app.staticTexts["Deliveries, on your calendar"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["walkthroughConnectCalendar"].exists)
    screenshot("walkthrough-calendar")
    reveal(next)
    next.tap()
    XCTAssertTrue(app.staticTexts["Make yourself at home"].waitForExistence(timeout: 3))
    reveal(next)
    next.tap()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Settings"].tap()
    app.buttons["Show app walkthrough"].tap()
    XCTAssertTrue(app.staticTexts["Welcome to PorchPong"].waitForExistence(timeout: 3))
    app.buttons["Set up later"].tap()
    XCTAssertTrue(app.buttons["Show app walkthrough"].waitForExistence(timeout: 3))
  }
  func testWalkthroughLargeText() {
    launch([
      "--walkthrough", "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryAccessibilityXXXL",
    ])
    XCTAssertTrue(app.staticTexts["Welcome to PorchPong"].waitForExistence(timeout: 8))
    let next = app.buttons["walkthroughContinue"]
    reveal(next)
    XCTAssertTrue(next.isHittable)
    screenshot("walkthrough-large-text")
    next.tap()
    reveal(app.buttons["walkthroughEnableNotifications"])
    XCTAssertTrue(app.buttons["walkthroughEnableNotifications"].isHittable)
    app.buttons["Set up later"].tap()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
  }
  func testCollectionAndUndo() {
    launch()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    app.buttons["packageFilter"].tap()
    app.buttons["Delivered (1)"].tap()
    app.staticTexts["Cometeer"].tap()
    reveal(app.buttons["Mark collected"])
    app.buttons["Mark collected"].tap()
    reveal(app.buttons["Undo collection"])
    XCTAssertTrue(app.buttons["Undo collection"].waitForExistence(timeout: 5))
    screenshot("collected-package")
    app.buttons["Undo collection"].tap()
    reveal(app.buttons["Mark collected"])
    XCTAssertTrue(app.buttons["Mark collected"].waitForExistence(timeout: 5))
  }
  func testAttentionReasonsAndNotificationSettings() {
    launch()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    app.buttons["packageFilter"].tap()
    app.buttons["Needs attention (1)"].tap()
    app.staticTexts["Muji"].tap()
    XCTAssertTrue(
      app.staticTexts["Tracking is overdue for a fresh check."].waitForExistence(timeout: 5))
    screenshot("attention-reasons")
    app.tabBars.buttons["Settings"].tap()
    reveal(app.switches["Send me notifications"])
    XCTAssertTrue(app.switches["Send me notifications"].exists)
    screenshot("notification-preferences")
  }
  func testSignInLanding() {
    launch(["--signed-out"])
    XCTAssertTrue(app.buttons["googleSignIn"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["PorchPong"].exists)
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
  func testPackagesHomeSections() {
    launch(["--today-sections"])
    let delivered = app.staticTexts["Delivered today"]
    let expected = app.staticTexts["Expected today"]
    let future = app.staticTexts["Future Packages"]
    let snoozed = app.staticTexts["Snoozed"]
    XCTAssertTrue(delivered.waitForExistence(timeout: 5))
    XCTAssertTrue(expected.exists)
    XCTAssertLessThan(delivered.frame.minY, expected.frame.minY)
    XCTAssertTrue(app.staticTexts["Cometeer"].exists)
    XCTAssertTrue(app.staticTexts["Schoolhouse"].exists)
    screenshot("packages-today-sections")
    reveal(future)
    XCTAssertTrue(future.exists)
    XCTAssertFalse(app.staticTexts["Other packages"].exists)
    XCTAssertTrue(app.staticTexts["Muji"].exists)
    reveal(snoozed)
    XCTAssertTrue(snoozed.exists)
    XCTAssertTrue(app.staticTexts["Snoozed parcel"].exists)
    screenshot("packages-remaining-snoozed")
  }
  func testPackagesHideEmptySections() {
    launch()
    XCTAssertTrue(app.staticTexts["Expected today"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Delivered today"].exists)
    XCTAssertTrue(app.staticTexts["Future Packages"].exists)

    let search = app.searchFields.firstMatch
    search.tap()
    search.typeText("Schoolhouse")
    XCTAssertTrue(app.staticTexts["Expected today"].exists)
    XCTAssertFalse(app.staticTexts["Future Packages"].exists)

    search.buttons["Clear text"].tap()
    search.typeText("No matching merchant")
    XCTAssertTrue(app.staticTexts["No matching packages"].exists)
    XCTAssertFalse(app.staticTexts["Expected today"].exists)
    XCTAssertFalse(app.staticTexts["Future Packages"].exists)
  }
  func testPackagesCalendarSwitchAndDates() {
    launch()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    let view = app.segmentedControls["packageView"]
    XCTAssertTrue(view.waitForExistence(timeout: 5))
    view.buttons["Calendar"].tap()
    XCTAssertTrue(app.staticTexts["September 2026"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Schoolhouse"].exists)
    XCTAssertFalse(app.staticTexts["Muji"].exists)
    screenshot("packages-calendar")
    app.staticTexts["Schoolhouse"].tap()
    XCTAssertTrue(app.buttons["Copy order number"].waitForExistence(timeout: 5))
    app.navigationBars["Package"].buttons["Packages"].tap()
    app.buttons["calendarDay-2026-09-18"].tap()
    XCTAssertTrue(app.staticTexts["Cometeer"].waitForExistence(timeout: 5))
    app.buttons["calendarNextMonth"].tap()
    XCTAssertTrue(app.staticTexts["October 2026"].waitForExistence(timeout: 5))
    app.buttons["calendarToday"].tap()
    XCTAssertTrue(app.staticTexts["Schoolhouse"].waitForExistence(timeout: 5))
    app.buttons["addPackage"].tap()
    XCTAssertTrue(app.buttons["savePackage"].waitForExistence(timeout: 5))
    app.buttons["Cancel"].tap()
    view.buttons["List"].tap()
    XCTAssertTrue(app.buttons["packageFilter"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Schoolhouse"].exists)
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
    XCTAssertTrue(undo.waitForExistence(timeout: 5))
    XCTAssertTrue(undo.isHittable)
    screenshot("dismiss-banner")
    undo.tap()
    screenshot("dismiss-restored")
  }
  func testSnoozedSectionAndShowNow() {
    launch()
    XCTAssertTrue(app.staticTexts["Schoolhouse"].waitForExistence(timeout: 5))
    app.staticTexts["Schoolhouse"].tap()
    let snooze = app.buttons["Snooze until next update"]
    reveal(snooze)
    XCTAssertTrue(snooze.isHittable)
    snooze.tap()
    XCTAssertTrue(
      app.staticTexts["Snoozed until the next email or tracking update."]
        .waitForExistence(timeout: 5))
    screenshot("snooze-banner")
    reveal(app.buttons["Show package now"])
    XCTAssertTrue(app.buttons["Show package now"].waitForExistence(timeout: 5))
    app.navigationBars["Package"].buttons["Packages"].tap()
    reveal(app.staticTexts["Snoozed"])
    XCTAssertTrue(app.staticTexts["Snoozed"].exists)
    screenshot("snoozed-packages")
    let notification = app.staticTexts["Snoozed until the next email or tracking update."]
    let expired = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"), object: notification)
    XCTAssertEqual(XCTWaiter.wait(for: [expired], timeout: 8), .completed)
    app.staticTexts["Schoolhouse"].tap()
    reveal(app.buttons["Show package now"])
    app.buttons["Show package now"].tap()
    XCTAssertTrue(app.buttons["Snooze until next update"].waitForExistence(timeout: 5))
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
  func testGoogleCalendarControls() {
    launch()
    app.tabBars.buttons["Settings"].tap()
    let sync = app.buttons["syncGoogleCalendar"]
    reveal(sync)
    XCTAssertTrue(sync.isHittable)
    XCTAssertTrue(app.buttons["Reconnect Google Calendar"].exists)
    screenshot("google-calendar-connected")
    sync.tap()
    let disconnect = app.buttons["Disconnect Google Calendar"]
    reveal(disconnect)
    disconnect.tap()
    XCTAssertTrue(app.buttons["Disconnect"].waitForExistence(timeout: 3))
    screenshot("google-calendar-disconnect")
    app.buttons["Disconnect"].tap()
    let connect = app.buttons["connectGoogleCalendar"]
    expectation(
      for: NSPredicate(format: "label == %@", "Connect Google Calendar"), evaluatedWith: connect)
    waitForExpectations(timeout: 5)
    reveal(connect)
    XCTAssertEqual(connect.label, "Connect Google Calendar")
    XCTAssertFalse(app.buttons["syncGoogleCalendar"].exists)
    screenshot("google-calendar-disconnected")
  }
  func testInboxAndSettings() {
    launch()
    app.tabBars.buttons["Inbox"].tap()
    XCTAssertTrue(app.staticTexts["Your Cometeer delivery arrived"].waitForExistence(timeout: 5))
    screenshot("inbox")
    app.staticTexts["Your Cometeer delivery arrived"].tap()
    XCTAssertTrue(app.staticTexts["Original sent date"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Open in Gmail"].exists)
    XCTAssertTrue(app.buttons["Open in Apple Mail"].exists)
    screenshot("email-detail")
    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.staticTexts["sample@example.test"].firstMatch.waitForExistence(timeout: 5))
    screenshot("settings")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Forward emails for package updates'")).firstMatch.exists)
    let freeGmail = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Available to eligible households'")).firstMatch
    reveal(freeGmail)
    XCTAssertTrue(freeGmail.exists)
    screenshot("free-account")
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
