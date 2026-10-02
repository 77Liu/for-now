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

final class DevicePerformanceAcceptanceTests: XCTestCase {
    private static let launchLimit: TimeInterval = 3.0
    private static let pendingLimit: TimeInterval = 0.5
    private var app: XCUIApplication?

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDownWithError() throws {
        app?.terminate()
        XCUIDevice.shared.orientation = .portrait
    }

    func testColdProcessLaunchReachesStableHomeWithinThreeSeconds() throws {
        let configuration = try Configuration.load()
        try requirePhysicalDevice()
        try prepareAuthenticatedShadowSession(configuration)

        let measuredApp = configuredApplication(configuration)
        app = measuredApp
        let startedAt = ProcessInfo.processInfo.systemUptime
        measuredApp.launch()
        let stable = waitForStableHome(in: measuredApp, timeout: Self.launchLimit)
        let duration = ProcessInfo.processInfo.systemUptime - startedAt

        attachMetric("cold-process-launch-to-stable-home", duration: duration, limit: Self.launchLimit)
        XCTAssertTrue(stable, "Stable home did not become hittable before the launch deadline")
        XCTAssertLessThan(duration, Self.launchLimit, "Cold process launch to stable home must remain below 3.0 seconds")
    }

    func testTouchSubmitEntersPendingStateWithinHalfSecond() throws {
        let configuration = try Configuration.load()
        try requirePhysicalDevice()
        let launchedApp = try launchAuthenticatedApplication(configuration)
        app = launchedApp

        let webView = launchedApp.webViews.firstMatch
        button(containing: "所见", in: webView).tap()
        XCTAssertTrue(webView.buttons["收下"].waitForExistence(timeout: 10), "Capture view did not open")

        let input = webView.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5), "Capture input is not accessible")
        input.tap()
        input.typeText("ios-perf-\(UUID().uuidString.prefix(8))")
        launchedApp.keyboards.buttons["Hide keyboard"].tapIfExists()

        let submit = webView.buttons["收下"]
        XCTAssertTrue(submit.isHittable, "Capture submit button is not hittable")
        let startedAt = ProcessInfo.processInfo.systemUptime
        submit.tap()
        let enteredPending = waitForPendingState(
            submit: submit,
            webView: webView,
            timeout: Self.pendingLimit
        )
        let duration = ProcessInfo.processInfo.systemUptime - startedAt

        attachMetric("touch-submit-to-pending", duration: duration, limit: Self.pendingLimit)
        XCTAssertTrue(enteredPending, "Submission did not expose the unified waiting state")
        XCTAssertLessThan(duration, Self.pendingLimit, "Touch submit to pending state must remain below 0.5 seconds")
    }

    private func requirePhysicalDevice() throws {
        let environment = ProcessInfo.processInfo.environment
        if environment["SIMULATOR_DEVICE_NAME"] != nil || environment["SIMULATOR_UDID"] != nil {
            throw XCTSkip("Device performance acceptance only runs on a physical iPhone")
        }
    }

    private func prepareAuthenticatedShadowSession(_ configuration: Configuration) throws {
        let preflightApp = configuredApplication(configuration)
        app = preflightApp
        preflightApp.launch()
        XCTAssertTrue(
            waitForStableHome(in: preflightApp, timeout: 30),
            "Shadow account preflight did not reach a stable home"
        )
        preflightApp.terminate()
        app = nil
    }

    private func launchAuthenticatedApplication(_ configuration: Configuration) throws -> XCUIApplication {
        let launchedApp = configuredApplication(configuration)
        launchedApp.launch()
        XCTAssertTrue(
            waitForStableHome(in: launchedApp, timeout: 30),
            "Shadow account did not reach a stable home"
        )
        return launchedApp
    }

    private func configuredApplication(_ configuration: Configuration) -> XCUIApplication {
        let application = XCUIApplication()
        application.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        application.launchEnvironment["CIKE_IOS_PERF_ENABLED"] = "1"
        application.launchEnvironment["CIKE_IOS_PERF_ISOLATED"] = "1"
        application.launchEnvironment["CIKE_IOS_PERF_TEST_URL"] = configuration.testURL.absoluteString
        application.launchEnvironment["CIKE_IOS_PERF_SHADOW_USERNAME"] = configuration.username
        application.launchEnvironment["CIKE_IOS_PERF_SHADOW_PASSWORD"] = configuration.password
        application.launchEnvironment["CIKE_NATIVE_SCENARIO"] = "performance-acceptance"
        application.launchEnvironment["CIKE_NATIVE_MARKER"] = configuration.username
        application.launchEnvironment["CIKE_NATIVE_PASSWORD"] = configuration.password
        return application
    }

    private func waitForStableHome(in application: XCUIApplication, timeout: TimeInterval) -> Bool {
        let startedAt = ProcessInfo.processInfo.systemUptime
        let webView = application.webViews.firstMatch
        guard webView.waitForExistence(timeout: remainingTime(since: startedAt, limit: timeout)) else {
            return false
        }

        let homeAction = webView.buttons["记录思考"]
        guard homeAction.waitForExistence(timeout: remainingTime(since: startedAt, limit: timeout)),
              waitUntil(timeout: remainingTime(since: startedAt, limit: timeout), condition: {
                  application.state == .runningForeground && homeAction.isHittable
              }) else {
            return false
        }

        let frame = homeAction.frame
        Thread.sleep(forTimeInterval: 0.1)
        return application.state == .runningForeground
            && homeAction.isHittable
            && frame.equalTo(homeAction.frame)
    }

    private func waitForPendingState(
        submit: XCUIElement,
        webView: XCUIElement,
        timeout: TimeInterval
    ) -> Bool {
        let waitingLabels = [
            "正在收下…",
            "图片已上传，正在同步记录…",
            "语音已上传，正在同步记录…",
            "已记下，正在同步…"
        ]
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        repeat {
            if !submit.isEnabled && waitingLabels.contains(where: { webView.staticTexts[$0].exists }) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.01)
        } while ProcessInfo.processInfo.systemUptime < deadline
        return false
    }

    private func remainingTime(since startedAt: TimeInterval, limit: TimeInterval) -> TimeInterval {
        max(0.01, limit - (ProcessInfo.processInfo.systemUptime - startedAt))
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

    private func attachMetric(_ name: String, duration: TimeInterval, limit: TimeInterval) {
        let payload = String(
            format: "{\"metric\":\"%@\",\"seconds\":%.3f,\"limitSeconds\":%.1f}",
            name,
            duration,
            limit
        )
        let attachment = XCTAttachment(string: payload)
        attachment.name = "\(name).json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private struct Configuration {
        let testURL: URL
        let username: String
        let password: String

        static func load() throws -> Configuration {
            let environment = ProcessInfo.processInfo.environment
            guard environment["CIKE_IOS_PERF_ENABLED"] == "1" else {
                throw XCTSkip("Set CIKE_IOS_PERF_ENABLED=1 to enable device performance acceptance")
            }

            let requiredKeys = [
                "CIKE_IOS_PERF_ISOLATED",
                "CIKE_IOS_PERF_TEST_URL",
                "CIKE_IOS_PERF_SHADOW_USERNAME",
                "CIKE_IOS_PERF_SHADOW_PASSWORD"
            ]
            guard requiredKeys.allSatisfy({ environment[$0]?.isEmpty == false }) else {
                throw XCTSkip("Isolated test URL and shadow account environment are required")
            }
            guard environment["CIKE_IOS_PERF_ISOLATED"] == "1" else {
                throw ConfigurationError("CIKE_IOS_PERF_ISOLATED must equal 1")
            }

            let rawURL = environment["CIKE_IOS_PERF_TEST_URL"]!
            guard let components = URLComponents(string: rawURL),
                  components.scheme?.lowercased() == "https",
                  components.user == nil,
                  components.password == nil,
                  components.fragment == nil,
                  let rawHost = components.host,
                  let testURL = components.url else {
                throw ConfigurationError("CIKE_IOS_PERF_TEST_URL must be a credential-free HTTPS URL")
            }
            let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            guard host != "77liu.top", !host.hasSuffix(".77liu.top") else {
                throw ConfigurationError("Production hosts are forbidden for device performance acceptance")
            }

            return Configuration(
                testURL: testURL,
                username: environment["CIKE_IOS_PERF_SHADOW_USERNAME"]!,
                password: environment["CIKE_IOS_PERF_SHADOW_PASSWORD"]!
            )
        }
    }

    private struct ConfigurationError: Error, CustomStringConvertible {
        let description: String

        init(_ description: String) {
            self.description = description
        }
    }
}

private extension XCUIElement {
    func tapIfExists() {
        if exists && isHittable {
            tap()
        }
    }
}
