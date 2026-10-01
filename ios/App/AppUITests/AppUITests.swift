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

    func testOnlineSimulationSwitchLatency() throws {
        app.terminate()
        app.launchEnvironment["CIKE_NATIVE_SCENARIO"] = "login-submit"
        app.launchEnvironment["CIKE_NATIVE_MARKER"] = "nativegate"
        app.launch()

        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 20), "Web content did not become accessible")
        XCTAssertTrue(webView.buttons["记录思考"].waitForExistence(timeout: 30), "Online test account login did not complete")

        button(containing: "我的", in: webView).tap()
        XCTAssertTrue(webView.buttons["设置"].waitForExistence(timeout: 10))
        webView.buttons["设置"].tap()
        let cold = webView.buttons["冷启测试"]
        let simulation = webView.buttons["使用模拟"]
        XCTAssertTrue(cold.waitForExistence(timeout: 10))
        XCTAssertTrue(simulation.waitForExistence(timeout: 10))

        if cold.value as? String != "1" {
            cold.tap()
            confirmCurrentAlert()
            XCTAssertTrue(waitUntil(timeout: 30) { cold.value as? String == "1" })
        }
        capture("online-switch-before")

        let startedAt = Date()
        simulation.tap()
        confirmCurrentAlert()
        XCTAssertTrue(waitUntil(timeout: 120) { simulation.value as? String == "1" }, "Simulation switch did not finish")
        let duration = Date().timeIntervalSince(startedAt)
        add(XCTAttachment(string: "simulation switch duration seconds: \(duration)"))
        capture("online-switch-after")
    }

    func testLiveAccountNavigation() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let username = environment["CIKE_TEST_USERNAME"],
              let password = environment["CIKE_TEST_PASSWORD"] else {
            throw XCTSkip("CIKE_TEST_USERNAME and CIKE_TEST_PASSWORD are required")
        }

        app.terminate()
        app.launchEnvironment["CIKE_NATIVE_SCENARIO"] = "login-submit"
        app.launchEnvironment["CIKE_NATIVE_MARKER"] = username
        app.launchEnvironment["CIKE_NATIVE_PASSWORD"] = password
        app.launch()

        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 20), "Web content did not become accessible")
        XCTAssertTrue(webView.buttons["记录思考"].waitForExistence(timeout: 30), "Live account login did not complete")
        capture("live-01-today")

        button(containing: "所见", in: webView).tap()
        XCTAssertTrue(webView.buttons["收下"].waitForExistence(timeout: 10), "Capture view did not open")
        XCTAssertTrue(webView.staticTexts["上传音频"].waitForExistence(timeout: 5), "Audio upload action is missing")
        XCTAssertTrue(webView.staticTexts["现场录音"].waitForExistence(timeout: 5), "Collapsed recorder entry is missing")
        capture("live-02-captures")

        button(containing: "我的", in: webView).tap()
        XCTAssertTrue(webView.buttons["统计"].waitForExistence(timeout: 10), "Statistics entry is missing")
        webView.buttons["统计"].tap()
        XCTAssertTrue(webView.staticTexts["个人统计"].waitForExistence(timeout: 10), "Statistics view did not open")
        capture("live-03-statistics")
    }

    private func confirmCurrentAlert() {
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons.allElementsBoundByIndex.last?.tap()
        }
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
