import XCTest

final class AppUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
    }

    func testCoreNavigationAcrossOrientationKeyboardAndLifecycle() throws {
        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 20), "Web content did not become accessible")
        XCTAssertTrue(webView.buttons["记录思考"].waitForExistence(timeout: 20), "Today view did not finish loading")
        capture("01-today-portrait")

        webView.buttons["记录状态"].tap()
        XCTAssertTrue(webView.buttons["收起状态编辑"].waitForExistence(timeout: 5))
        webView.buttons["收起状态编辑"].tap()

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(waitUntil(timeout: 5) { self.app.frame.width > self.app.frame.height })
        XCTAssertTrue(webView.buttons["记录思考"].exists)
        capture("02-today-landscape")

        button(containing: "所见", in: webView).tap()
        XCTAssertTrue(webView.buttons["收下"].waitForExistence(timeout: 10), "Capture view did not open")

        let captureInput = webView.textViews.firstMatch
        XCTAssertTrue(captureInput.waitForExistence(timeout: 5), "Capture input is not accessible")
        captureInput.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "Software keyboard did not open")
        captureInput.typeText("native gate draft")
        XCTAssertTrue(String(describing: captureInput.value).contains("native gate draft"))
        capture("03-capture-keyboard-landscape")

        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(webView.waitForExistence(timeout: 10), "Web content did not recover from background")
        XCTAssertTrue(String(describing: captureInput.value).contains("native gate draft"), "Unsaved draft was lost after foregrounding")

        app.keyboards.buttons["Hide keyboard"].tapIfExists()
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(waitUntil(timeout: 5) { self.app.frame.height > self.app.frame.width })

        webView.buttons["小物"].tap()
        XCTAssertTrue(webView.buttons["＋ 收一件小物"].waitForExistence(timeout: 10))

        button(containing: "所思", in: webView).tap()
        XCTAssertTrue(webView.buttons["寻迹"].waitForExistence(timeout: 10))
        webView.buttons["寻迹"].tap()
        XCTAssertTrue(webView.buttons["任意门"].waitForExistence(timeout: 10))

        button(containing: "我的", in: webView).tap()
        XCTAssertTrue(webView.staticTexts["我的"].waitForExistence(timeout: 10))
        capture("04-mine-portrait")
    }

    private func button(containing text: String, in webView: XCUIElement) -> XCUIElement {
        webView.buttons
            .matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch
    }

    @discardableResult
    private func waitUntil(timeout: TimeInterval, condition: @escaping () -> Bool) -> Bool {
        let predicate = NSPredicate { _, _ in condition() }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "iPhone")-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private extension XCUIElement {
    func tapIfExists() {
        if exists && isHittable {
            tap()
        }
    }
}
