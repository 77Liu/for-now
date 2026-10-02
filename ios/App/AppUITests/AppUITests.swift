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
        try attachStartupBreakdown(in: measuredApp)
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
        submit.tap()
        let latencyMilliseconds = waitForPendingLatency(in: webView, timeout: 2)
        XCTAssertNotNil(latencyMilliseconds, "Submission did not expose its internal pending-state latency")
        guard let latencyMilliseconds else { return }
        let duration = latencyMilliseconds / 1000

        attachMetric("touch-submit-to-pending", duration: duration, limit: Self.pendingLimit)
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
        allowLocalNetworkIfNeeded(in: preflightApp)
        try authenticateIfNeeded(in: preflightApp, configuration: configuration)
        openTodayIfNeeded(in: preflightApp)
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
        try authenticateIfNeeded(in: launchedApp, configuration: configuration)
        openTodayIfNeeded(in: launchedApp)
        XCTAssertTrue(
            waitForStableHome(in: launchedApp, timeout: 30),
            "Shadow account did not reach a stable home"
        )
        return launchedApp
    }

    private func authenticateIfNeeded(in application: XCUIApplication, configuration: Configuration) throws {
        let webView = application.webViews.firstMatch
        guard webView.waitForExistence(timeout: 10) else { return }
        if webView.buttons["记录思考"].exists { return }
        let username = webView.textFields.firstMatch
        let password = webView.secureTextFields.firstMatch
        guard username.waitForExistence(timeout: 10), password.waitForExistence(timeout: 10) else { return }
        username.tap()
        username.typeText(configuration.username)
        password.tap()
        password.typeText(configuration.password)
        let loginButtons = webView.buttons.matching(NSPredicate(format: "label == %@", "登录")).allElementsBoundByIndex
        guard let submit = loginButtons.last else {
            throw ConfigurationError("Login submit button is unavailable")
        }
        submit.tap()
    }

    private func openTodayIfNeeded(in application: XCUIApplication) {
        let webView = application.webViews.firstMatch
        if webView.buttons["记录思考"].exists { return }
        let today = webView.buttons
            .matching(NSPredicate(format: "label CONTAINS %@", "今日"))
            .firstMatch
        if today.waitForExistence(timeout: 5), today.isHittable {
            today.tap()
        }
    }

    private func configuredApplication(_ configuration: Configuration) -> XCUIApplication {
        let application = XCUIApplication()
        application.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        application.launchEnvironment["CIKE_IOS_PERF_ENABLED"] = "1"
        application.launchEnvironment["CIKE_IOS_PERF_ISOLATED"] = "1"
        if configuration.lanHTTP {
            application.launchEnvironment["CIKE_IOS_PERF_LAN_HTTP"] = "1"
        }
        application.launchEnvironment["CIKE_IOS_PERF_TEST_URL"] = configuration.testURL.absoluteString
        application.launchEnvironment["CIKE_IOS_PERF_SHADOW_USERNAME"] = configuration.username
        application.launchEnvironment["CIKE_IOS_PERF_SHADOW_PASSWORD"] = configuration.password
        application.launchEnvironment["CIKE_NATIVE_SCENARIO"] = "performance-acceptance"
        application.launchEnvironment["CIKE_NATIVE_MARKER"] = configuration.username
        application.launchEnvironment["CIKE_NATIVE_PASSWORD"] = configuration.password
        return application
    }

    private func allowLocalNetworkIfNeeded(in application: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for alert in [application.alerts.firstMatch, springboard.alerts.firstMatch] where alert.waitForExistence(timeout: 2) {
            for label in ["允许", "Allow"] {
                let button = alert.buttons[label]
                if button.exists && button.isHittable {
                    button.tap()
                    return
                }
            }
            alert.buttons.allElementsBoundByIndex.last?.tap()
            return
        }
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

    private func waitForPendingLatency(in webView: XCUIElement, timeout: TimeInterval) -> Double? {
        let metric = webView.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "提交等待 "))
            .firstMatch
        guard metric.waitForExistence(timeout: timeout) else { return nil }
        let components = metric.label.split(separator: " ")
        guard components.count >= 2 else { return nil }
        return Double(components[1])
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

    private func attachStartupBreakdown(in application: XCUIApplication) throws {
        let metric = application.webViews.firstMatch.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "启动分段 "))
            .firstMatch
        XCTAssertTrue(metric.waitForExistence(timeout: 3), "Startup breakdown metric was not published")
        let range = try XCTUnwrap(metric.label.range(of: "启动分段 "), "Startup breakdown prefix is missing")
        let payload = String(metric.label[range.upperBound...])
        let data = try XCTUnwrap(payload.data(using: .utf8), "Startup breakdown is not UTF-8")
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["marks"] is [String: Any],
              value["segments"] is [String: Any],
              value["totalMs"] is NSNumber else {
            throw NSError(
                domain: "DevicePerformanceAcceptanceTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Startup breakdown JSON is incomplete"]
            )
        }
        let attachment = XCTAttachment(string: payload)
        attachment.name = "startup-breakdown.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private struct Configuration {
        let testURL: URL
        let username: String
        let password: String
        let lanHTTP: Bool

        private static func isPrivateIPv4(_ host: String) -> Bool {
            let parts = host.split(separator: ".").compactMap { Int($0) }
            guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
            return parts[0] == 10
                || (parts[0] == 172 && (16...31).contains(parts[1]))
                || (parts[0] == 192 && parts[1] == 168)
        }

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
                  components.user == nil,
                  components.password == nil,
                  components.fragment == nil,
                  let rawHost = components.host,
                  let testURL = components.url else {
                throw ConfigurationError("CIKE_IOS_PERF_TEST_URL must be a credential-free URL")
            }
            let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            let scheme = components.scheme?.lowercased()
            let lanHTTP = environment["CIKE_IOS_PERF_LAN_HTTP"] == "1"
                && scheme == "http"
                && isPrivateIPv4(host)
            guard scheme == "https" || lanHTTP else {
                throw ConfigurationError("Performance URL must use HTTPS or explicitly enabled private-LAN HTTP")
            }
            guard host != "77liu.top", !host.hasSuffix(".77liu.top") else {
                throw ConfigurationError("Production hosts are forbidden for device performance acceptance")
            }

            return Configuration(
                testURL: testURL,
                username: environment["CIKE_IOS_PERF_SHADOW_USERNAME"]!,
                password: environment["CIKE_IOS_PERF_SHADOW_PASSWORD"]!,
                lanHTTP: lanHTTP
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
