// VibeDoc for macOS: a native window around the local board (no browser needed).
// Built by mac/install.sh into ~/Applications/VibeDoc.app. Info.plist carries VibeDocHome (the VibeDoc
// checkout whose server.ts it runs) and VibeDocNode (the node binary), so updating the checkout needs no
// rebuild. On launch it reuses a running `vibedoc serve` for all projects or starts one, and stops only
// the server it started when it quits.
import Cocoa
import WebKit

let port = 4870
let boardURL = URL(string: "http://127.0.0.1:\(port)/")!

// MARK: - Server

final class Server {
    static let shared = Server()
    private(set) var process: Process?
    let home: String
    let node: String
    let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/vibedoc.log")

    private init() {
        let info = Bundle.main.infoDictionary ?? [:]
        home = info["VibeDocHome"] as? String ?? ""
        node = info["VibeDocNode"] as? String ?? "/opt/homebrew/bin/node"
    }

    enum Health { case ours, other, none }

    // Blocking check; call off the main thread.
    func health() -> Health {
        var request = URLRequest(url: boardURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1
        let done = DispatchSemaphore(value: 0)
        var result = Health.none
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { done.signal() }
            guard response != nil else { return }
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               json["app"] as? String == "vibedoc", json["mode"] as? String == "registry" {
                result = .ours
            } else {
                result = .other
            }
        }.resume()
        done.wait()
        return result
    }

    // Makes sure a board for all projects answers on the port; calls back on the main thread with an error
    // text or nil. A first launch can sit behind macOS's folder-access prompt, so it waits up to two minutes
    // while the server process is alive and reports `progress` once it is taking a while.
    func ensure(progress: ((String) -> Void)? = nil, _ completion: @escaping (String?) -> Void) {
        DispatchQueue.global().async {
            let finish = { (error: String?) in DispatchQueue.main.async { completion(error) } }
            switch self.health() {
            case .ours: return finish(nil)
            case .other: return finish("端口 \(port) 已被其他程序（或只服务单个仓库的 vibedoc serve --only）占用。请先停止它，再按 ⌘R 重试。")
            case .none: break
            }
            if self.process?.isRunning != true, let error = self.start() { return finish(error) }
            for i in 0..<600 {
                if self.health() == .ours { return finish(nil) }
                if self.process?.isRunning == false { break }
                if i == 20, let progress { DispatchQueue.main.async { progress("VibeDoc 服务还在启动…<br>第一次打开时，macOS 可能会询问是否允许 VibeDoc 访问「文稿」等文件夹，请点「允许」。") } }
                Thread.sleep(forTimeInterval: 0.2)
            }
            finish("VibeDoc 服务没有启动成功，日志见 \(self.logURL.path)。按 ⌘R 重试。")
        }
    }

    private func start() -> String? {
        let script = (home as NSString).appendingPathComponent("server.ts")
        guard FileManager.default.fileExists(atPath: script) else { return "找不到 \(script)，请在 VibeDoc 目录重新运行 mac/install.sh。" }
        guard FileManager.default.isExecutableFile(atPath: node) else { return "找不到 node（\(node)），需要 Node.js 23.6 或更高版本；装好后重新运行 mac/install.sh。" }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "VIBEDOC_REPO")
        env["PORT"] = String(port)
        p.environment = env
        if !FileManager.default.fileExists(atPath: logURL.path) {
            try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let log = try? FileHandle(forWritingTo: logURL) {
            log.seekToEndOfFile()
            let stamp = DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .medium)
            log.write("\n[\(stamp)] VibeDoc.app 启动服务\n".data(using: .utf8)!)
            p.standardOutput = log
            p.standardError = log
        }
        do {
            try p.run()
        } catch {
            return "无法启动 VibeDoc 服务：\(error.localizedDescription)"
        }
        process = p
        return nil
    }

    func stop() {
        if let p = process, p.isRunning { p.terminate() }
        process = nil
    }
}

// MARK: - Window

final class BoardWindow: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?
    var onClose: ((BoardWindow) -> Void)?

    init(url: URL, frameName: String?) {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "VibeDocApp/1.0"
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "VibeDoc"
        window.minSize = NSSize(width: 640, height: 420)
        window.contentView = webView
        window.tabbingMode = .preferred
        super.init(window: window)
        window.delegate = self
        if let frameName, !window.setFrameUsingName(frameName) { window.center() }
        if let frameName { window.setFrameAutosaveName(frameName) } else { window.center() }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            self?.window?.title = view.title?.isEmpty == false ? view.title! : "VibeDoc"
        }
        webView.load(URLRequest(url: url))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func windowWillClose(_ notification: Notification) { onClose?(self) }

    private func isBoard(_ url: URL?) -> Bool {
        guard let url else { return false }
        return (url.host == "127.0.0.1" || url.host == "localhost") && url.port == port
    }

    // Board pages stay here; links elsewhere open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if isBoard(url) || url?.scheme == "about" || url?.scheme == "data" || url?.scheme == "blob" { return decisionHandler(.allow) }
        if let url { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    // target=_blank: board pages (sketches, files) open in a new window, other sites in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isBoard(url) { (NSApp.delegate as? AppDelegate)?.openWindow(url: url) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showProblem("连不上 VibeDoc 服务（\(error.localizedDescription)）。按 ⌘R 会自动重新启动服务。")
    }

    func showProblem(_ text: String) {
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "&lt;br>", with: "<br>")
        webView.loadHTMLString("""
        <html><head><meta charset="utf-8"><style>
        body { font: 14px -apple-system, sans-serif; display: grid; place-items: center; height: 90vh; color: #555; background: #f6f7f9; }
        @media (prefers-color-scheme: dark) { body { background: #1b1d21; color: #bbb; } }
        div { max-width: 520px; line-height: 1.7; text-align: center; }
        </style></head><body><div><h2>VibeDoc</h2>\(escaped)</div></body></html>
        """, baseURL: nil)
    }

    // Native dialogs for window.alert / confirm / prompt and <input type=file>.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window!) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window!) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window!) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window!) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [BoardWindow] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let first = openWindow(url: boardURL, frameName: "VibeDocMain", load: false)
        first.showProblem("正在启动 VibeDoc 服务…")
        Server.shared.ensure(progress: { first.showProblem($0) }) { error in
            if let error { first.showProblem(error) } else { first.webView.load(URLRequest(url: boardURL)) }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { newWindow(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) { Server.shared.stop() }

    @discardableResult
    func openWindow(url: URL, frameName: String? = nil, load: Bool = true) -> BoardWindow {
        let w = BoardWindow(url: load ? url : URL(string: "about:blank")!, frameName: frameName)
        w.onClose = { [weak self] closed in self?.windows.removeAll { $0 === closed } }
        windows.append(w)
        w.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        return w
    }

    private var current: BoardWindow? {
        windows.first { $0.window == NSApp.keyWindow } ?? windows.last
    }

    // MARK: Menu actions

    @objc func newWindow(_ sender: Any?) {
        // A new window opens on the same project as the current one.
        let url = current?.webView.url.flatMap { $0.host == "127.0.0.1" ? $0 : nil } ?? boardURL
        openWindow(url: url)
    }

    @objc func reloadBoard(_ sender: Any?) {
        guard let w = current else { return newWindow(nil) }
        Server.shared.ensure(progress: { w.showProblem($0) }) { error in
            if let error { return w.showProblem(error) }
            if let url = w.webView.url, url.host == "127.0.0.1" { w.webView.reload() } else { w.webView.load(URLRequest(url: boardURL)) }
        }
    }

    @objc func zoomIn(_ sender: Any?) { current.map { $0.webView.pageZoom = min($0.webView.pageZoom + 0.1, 3) } }
    @objc func zoomOut(_ sender: Any?) { current.map { $0.webView.pageZoom = max($0.webView.pageZoom - 0.1, 0.5) } }
    @objc func actualSize(_ sender: Any?) { current?.webView.pageZoom = 1 }

    // Adds a project folder through the board's own API (folders without VibeDoc are initialized).
    @objc func addProject(_ sender: Any?) {
        guard let w = current, let window = w.window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "增加项目"
        panel.message = "选择项目的仓库文件夹；还没有 VibeDoc 的文件夹会就地初始化。"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let path = panel.url?.path,
                  let data = try? JSONSerialization.data(withJSONObject: [path]), let literal = String(data: data, encoding: .utf8) else { return }
            let js = """
            (async () => {
              const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", "X-Board-Token": TOKEN }, body: JSON.stringify({ path: \(literal)[0], init: true }) });
              const j = await r.json().catch(() => ({}));
              if (!r.ok) { alert(j.error || "增加项目失败"); return; }
              await loadProjects(false);
              if (j.id) selectProject(j.id);
            })();
            """
            w.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    @objc func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(current?.webView.url.flatMap { $0.host == "127.0.0.1" ? $0 : nil } ?? boardURL)
    }

    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.open(Server.shared.logURL) }

    @objc func openReadme(_ sender: Any?) {
        NSWorkspace.shared.open(URL(fileURLWithPath: (Server.shared.home as NSString).appendingPathComponent("README.md")))
    }

    private func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
            return m
        }
        _ = menu("VibeDoc", [
            item("关于 VibeDoc", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("隐藏 VibeDoc", #selector(NSApplication.hide(_:)), "h"),
            item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("全部显示", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("退出 VibeDoc", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = menu("文件", [
            item("新建窗口", #selector(newWindow(_:)), "n", target: self),
            item("增加项目…", #selector(addProject(_:)), "o", target: self),
            .separator(),
            item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = menu("编辑", [
            item("撤销", Selector(("undo:")), "z"),
            item("重做", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("剪切", #selector(NSText.cut(_:)), "x"),
            item("拷贝", #selector(NSText.copy(_:)), "c"),
            item("粘贴", #selector(NSText.paste(_:)), "v"),
            item("全选", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = menu("显示", [
            item("重新载入", #selector(reloadBoard(_:)), "r", target: self),
            .separator(),
            item("放大", #selector(zoomIn(_:)), "+", target: self),
            item("缩小", #selector(zoomOut(_:)), "-", target: self),
            item("实际大小", #selector(actualSize(_:)), "0", target: self),
            .separator(),
            item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let windowMenu = menu("窗口", [
            item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("缩放", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("全部置于顶层", #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.windowsMenu = windowMenu
        _ = menu("帮助", [
            item("在浏览器中打开", #selector(openInBrowser(_:)), target: self),
            item("查看服务日志", #selector(showLog(_:)), target: self),
            item("VibeDoc 说明", #selector(openReadme(_:)), target: self),
        ])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
