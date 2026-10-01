import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let bridgeViewController = CAPBridgeViewController()
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = bridgeViewController
        window?.makeKeyAndVisible()
        installStatusBarBackground(in: window)

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

#if DEBUG
        runNativeTestScenarioIfRequested(in: bridgeViewController)
#endif
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    private func installStatusBarBackground(in window: UIWindow?) {
        guard let window else { return }
        let background = UIView()
        background.translatesAutoresizingMaskIntoConstraints = false
        background.isUserInteractionEnabled = false
        background.backgroundColor = UIColor(red: 243 / 255, green: 245 / 255, blue: 244 / 255, alpha: 1)
        window.addSubview(background)
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: window.topAnchor),
            background.leadingAnchor.constraint(equalTo: window.leadingAnchor),
            background.trailingAnchor.constraint(equalTo: window.trailingAnchor),
            background.bottomAnchor.constraint(equalTo: window.safeAreaLayoutGuide.topAnchor)
        ])
    }

#if DEBUG
    private func runNativeTestScenarioIfRequested(in controller: CAPBridgeViewController, attempt: Int = 0) {
        guard let scenario = ProcessInfo.processInfo.environment["CIKE_NATIVE_SCENARIO"]
            ?? UserDefaults.standard.string(forKey: "CIKE_NATIVE_SCENARIO") else { return }
        if attempt == 0 {
            NSLog("CIKE native test scenario: %@", scenario)
        }
        let viewScenarios = Set(["today", "daily", "captures", "keepsakes", "thoughts", "discovery", "mine"])
        let action: String
        if viewScenarios.contains(scenario) {
            action = """
            (() => {
              const target = document.querySelector('#view-\(scenario)');
              if (!target?.classList.contains('active')) document.querySelector('[data-view="\(scenario)"]')?.click();
              return target?.classList.contains('active') === true;
            })()
            """
        } else if scenario == "login" {
            action = """
            (() => {
              document.body.classList.add('auth-locked');
              const gate = document.querySelector('#auth-gate');
              if (gate) gate.hidden = false;
              return gate?.hidden === false;
            })()
            """
        } else if scenario == "state" || scenario == "thought-editor" {
            let kind = scenario == "state" ? "state" : "thought"
            action = """
            (() => {
              const editor = document.querySelector('#home-\(kind)-editor');
              if (editor?.hidden) document.querySelector('#home-\(kind == "state" ? "record-state" : "open-thought")')?.click();
              return editor?.hidden === false;
            })()
            """
        } else if scenario == "capture-keyboard" {
            action = """
            (() => {
              const target = document.querySelector('#view-captures');
              if (!target?.classList.contains('active')) {
                document.querySelector('[data-view="captures"]')?.click();
                return false;
              }
              const input = document.querySelector('#capture-content');
              input?.focus();
              return document.activeElement === input;
            })()
            """
        } else if scenario == "capture-submit" || scenario == "capture-restore" {
            let requestedMarker = ProcessInfo.processInfo.environment["CIKE_NATIVE_MARKER"]
                ?? UserDefaults.standard.string(forKey: "CIKE_NATIVE_MARKER")
                ?? "native-ui-gate"
            let marker = requestedMarker.range(of: #"^[A-Za-z0-9-]{1,64}$"#, options: .regularExpression) == nil
                ? "native-ui-gate"
                : requestedMarker
            action = """
            (() => {
              const target = document.querySelector('#view-captures');
              if (!target?.classList.contains('active')) {
                document.querySelector('[data-view="captures"]')?.click();
                return false;
              }
              const list = document.querySelector('#capture-list');
              if (list?.textContent.includes('\(marker)')) {
                list.scrollIntoView({ block: 'start' });
                return true;
              }
              if ('\(scenario)' === 'capture-restore' || window.__cikeNativeCaptureSubmitted) return false;
              const input = document.querySelector('#capture-content');
              const form = document.querySelector('#capture-form');
              if (!input || !form) return false;
              input.value = '\(marker)';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              window.__cikeNativeCaptureSubmitted = true;
              form.requestSubmit();
              return false;
            })()
            """
        } else if scenario == "login-submit" {
            let requestedUsername = ProcessInfo.processInfo.environment["CIKE_NATIVE_MARKER"]
                ?? UserDefaults.standard.string(forKey: "CIKE_NATIVE_MARKER")
                ?? "nativegate"
            let username = requestedUsername.range(of: #"^[A-Za-z0-9_-]{3,32}$"#, options: .regularExpression) == nil
                ? "nativegate"
                : requestedUsername
            let requestedPassword = ProcessInfo.processInfo.environment["CIKE_NATIVE_PASSWORD"]
                ?? UserDefaults.standard.string(forKey: "CIKE_NATIVE_PASSWORD")
                ?? "NativeGate1234"
            let passwordValue = requestedPassword.range(of: #"^[A-Za-z0-9_-]{8,128}$"#, options: .regularExpression) == nil
                ? "NativeGate1234"
                : requestedPassword
            action = """
            (() => {
              if (!document.body.classList.contains('auth-locked')) {
                return document.querySelector('#view-today')?.classList.contains('active') === true;
              }
              document.querySelector('[data-auth-tab="login"]')?.click();
              const form = document.querySelector('#login-form');
              const username = form?.querySelector('[name="username"]');
              const password = form?.querySelector('[name="password"]');
              if (!form || !username || !password) return false;
              username.value = '\(username)';
              password.value = '\(passwordValue)';
              username.dispatchEvent(new Event('input', { bubbles: true }));
              password.dispatchEvent(new Event('input', { bubbles: true }));
              if (!window.__cikeNativeLoginSubmitted) {
                window.__cikeNativeLoginSubmitted = true;
                form.requestSubmit();
              }
              return false;
            })()
            """
        } else if scenario == "local-test-switch" {
            action = """
            (() => {
              if (document.body.classList.contains('auth-locked')) return false;
              const settings = document.querySelector('#view-settings');
              if (!settings?.classList.contains('active')) {
                document.querySelector('[data-view="settings"]')?.click();
                return false;
              }
              const simulation = document.querySelector('[data-local-test-mode="simulation"]');
              if (!simulation || simulation.disabled) return false;
              if (simulation.getAttribute('aria-pressed') === 'true') return true;
              if (!window.__cikeNativeLocalSwitchStarted) {
                window.__cikeNativeLocalSwitchStarted = true;
                window.confirm = () => true;
                simulation.click();
              }
              return false;
            })()
            """
        } else if scenario == "capture-audio-ui" {
            action = """
            (() => {
              const captures = document.querySelector('#view-captures');
              if (!captures?.classList.contains('active')) {
                document.querySelector('[data-section="seen"]')?.click();
                document.querySelector('[data-view="captures"]')?.click();
                return false;
              }
              const recorder = document.querySelector('#capture-audio-recorder');
              const upload = document.querySelector('.audio-file-primary');
              return Boolean(upload && recorder && !recorder.open && upload.getBoundingClientRect().height >= 44);
            })()
            """
        } else {
            return
        }
        guard attempt < 48 else { return }

        guard let webView = controller.bridgedWebView else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.runNativeTestScenarioIfRequested(in: controller, attempt: attempt + 1)
            }
            return
        }

        let script = """
        (() => {
          const allowsLockedState = '\(scenario)' === 'login-submit';
          if (document.readyState === 'loading' || (!allowsLockedState && document.body.classList.contains('auth-locked')) || performance.now() < 2000) return false;
          return \(action);
        })()
        """
        webView.evaluateJavaScript(script) { result, _ in
            guard result as? Bool != true else {
                NSLog("CIKE native test scenario ready: %@", scenario)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.runNativeTestScenarioIfRequested(in: controller, attempt: attempt + 1)
            }
        }
    }
#endif
}
