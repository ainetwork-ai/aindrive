import Foundation
import UIKit

/// The aindrive agent on iOS.
///
/// Same job as `aindrive` on a laptop (cli/src/agent.js): dial OUT to the
/// server over WSS, prove identity with the per-drive agent token, verify the
/// HMAC on every inbound frame, run the RPC against the user's folder, sign
/// the response. No inbound port is ever opened on the phone.
///
/// One core hosts MANY drives: each picked folder is its own drive with its
/// own credentials and its own socket (a `DriveConn`), exactly as running one
/// desktop agent per directory would be. `start` adds or replaces a drive,
/// `stop(driveId:)` removes one, `stopAll` takes everything offline.
///
/// Background behaviour differs from Android, and the UI says so plainly:
/// iOS has no equivalent of a long-lived foreground service. A backgrounded
/// app keeps the sockets only for the few seconds of a background task
/// assertion, then the drives go offline until the app is reopened. Claiming
/// otherwise would mean a drive that silently stops answering.
final class AgentCore: NSObject {
    struct Config {
        let serverUrl: String
        let driveId: String
        let agentToken: String
        let driveSecret: String
        let folderLabel: String
    }

    /// One row per drive; mirrored by src/plugin.ts `DriveStatus`.
    struct DriveStatus {
        var driveId: String
        var folderLabel: String
        var running = true
        var connected = false
        var rpcCount = 0
        var lastError: String?

        var dictionary: [String: Any] {
            [
                "driveId": driveId,
                "folderLabel": folderLabel,
                "running": running,
                "connected": connected,
                "rpcCount": rpcCount,
                "lastError": lastError as Any? ?? NSNull(),
            ]
        }
    }

    /// Aggregate + per-drive rows; mirrored by src/plugin.ts `AgentStatus`.
    struct Status {
        var drives: [DriveStatus] = []
        var running: Bool { !drives.isEmpty }
        var connected: Bool { drives.contains { $0.connected } }

        var dictionary: [String: Any] {
            [
                "running": running,
                "connected": connected,
                "drives": drives.map { $0.dictionary },
            ]
        }
    }

    fileprivate static let protocolVersion = 1
    /// Backoff schedule copied from cli/src/agent.js so reconnects feel the same.
    fileprivate static let backoff: [TimeInterval] = [1, 2, 4, 8, 15]

    static let shared = AgentCore()

    var onStatusChange: ((Status) -> Void)?
    /// P2P media signalling from the server, for the WebView (mobile/src/p2p.ts), which has WebRTC.
    var onRtc: ((String, String) -> Void)?

    func forwardRtc(driveId: String, frame: String) {
        DispatchQueue.main.async { [weak self] in self?.onRtc?(driveId, frame) }
    }

    /// A frame from the WebView's P2P answerer, out over this drive's socket.
    func sendRtc(driveId: String, frame: String) -> Bool {
        guard let c = conns.first(where: { $0.config.driveId == driveId }) else { return false }
        return c.sendText(frame)
    }

    /// The folder of a running drive (the WebView reads P2P chunks through it).
    func fsOf(driveId: String) -> DriveFs? {
        conns.first(where: { $0.config.driveId == driveId })?.driveFs
    }

    /// driveId → live connection, in the order the user started them.
    private var conns: [DriveConn] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var observing = false
    fileprivate let queue = DispatchQueue(label: "ai.ainetwork.aindrive.agent")

    var status: Status { Status(drives: conns.map { $0.status }) }

    // MARK: - lifecycle

    func start(config: Config, folder: URL) {
        if let i = conns.firstIndex(where: { $0.config.driveId == config.driveId }) {
            conns[i].close()
            conns.remove(at: i)
        }
        let conn = DriveConn(core: self, config: config, folder: folder)
        conns.append(conn)
        observeAppState()
        conn.connect()
        emit()
    }

    func stop(driveId: String) {
        guard let i = conns.firstIndex(where: { $0.config.driveId == driveId }) else { return }
        conns[i].close()
        conns.remove(at: i)
        if conns.isEmpty { endBackgroundTask() }
        emit()
    }

    func stopAll() {
        for c in conns { c.close() }
        conns.removeAll()
        endBackgroundTask()
        emit()
    }

    // MARK: - app state

    /// iOS gives a backgrounded app a short grace period; take it so an upload
    /// in flight when the user switches away has a chance to finish.
    private func observeAppState() {
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, !self.conns.isEmpty else { return }
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "aindrive-agent") {
                self.endBackgroundTask()
            }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.endBackgroundTask()
            // The sockets are usually dead after a spell in the background.
            for c in self.conns where !c.status.connected { c.connect() }
        }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    fileprivate func emit() {
        let snapshot = status
        DispatchQueue.main.async { [weak self] in self?.onStatusChange?(snapshot) }
    }

    /// Strip anything path-shaped out of error text before it leaves the phone.
    static func sanitize(_ msg: String) -> String {
        let stripped = msg.replacingOccurrences(
            of: "/[A-Za-z0-9_.%:/-]+", with: "<path>", options: .regularExpression)
        return String(stripped.prefix(300))
    }

    /// Mirrors toWsUrl in cli/src/agent.js.
    static func wsUrl(server: String, driveId: String) -> URL? {
        var base = server
        while base.hasSuffix("/") { base.removeLast() }
        guard var comps = URLComponents(string: base) else { return nil }
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/api/agent/connect"
        comps.queryItems = [URLQueryItem(name: "driveId", value: driveId)]
        return comps.url
    }
}

// MARK: - one drive

/// Everything that belongs to ONE drive: credentials, folder, socket, counters.
private final class DriveConn {
    let config: AgentCore.Config
    private(set) var status: AgentCore.DriveStatus
    private unowned let core: AgentCore
    private let fs: DriveFs
    var driveFs: DriveFs { fs }
    private let rpc: RpcHandler
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var attempt = 0
    private var closed = false

    init(core: AgentCore, config: AgentCore.Config, folder: URL) {
        self.core = core
        self.config = config
        self.fs = DriveFs(root: folder)
        self.rpc = RpcHandler(fs: fs, driveId: config.driveId)
        self.status = AgentCore.DriveStatus(driveId: config.driveId, folderLabel: config.folderLabel)
    }

    /// Sends a text frame on this drive's socket (P2P signalling); false when not connected.
    /// `task` and `closed` change on the main thread (connect() runs there via the reconnect timer),
    /// so read them there too; plugin calls arrive on Capacitor's own queue, never main-blocking.
    func sendText(_ text: String) -> Bool {
        let send = { () -> Bool in
            guard !self.closed, let task = self.task else { return false }
            task.send(.string(text)) { _ in }
            return true
        }
        return Thread.isMainThread ? send() : DispatchQueue.main.sync(execute: send)
    }

    func close() {
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        status.running = false
        status.connected = false
    }

    func connect() {
        guard !closed else { return }
        guard let url = AgentCore.wsUrl(server: config.serverUrl, driveId: config.driveId) else {
            status.lastError = "Invalid server address"
            core.emit()
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(config.agentToken)", forHTTPHeaderField: "authorization")

        session?.invalidateAndCancel()
        let session = URLSession(configuration: .default)
        self.session = session
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        status.connected = true
        status.lastError = nil
        attempt = 0
        core.emit()
        sendHello()
        receive()
    }

    private func sendHello() {
        let hello: [String: Any] = ["type": "agent-hello", "hostname": UIDevice.current.name]
        if let data = try? JSONSerialization.data(withJSONObject: hello),
           let text = String(data: data, encoding: .utf8) {
            task?.send(.string(text)) { _ in }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self, !self.closed else { return }
            switch result {
            case .failure(let error):
                self.status.connected = false
                self.scheduleReconnect(error.localizedDescription)
            case .success(let message):
                if case .string(let text) = message {
                    self.core.queue.async { self.onFrame(text) }
                }
                self.receive()
            }
        }
    }

    private func scheduleReconnect(_ why: String) {
        guard !closed else { return }
        status.connected = false
        status.lastError = why
        core.emit()
        let wait = AgentCore.backoff[min(attempt, AgentCore.backoff.count - 1)]
        attempt += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
    }

    private func onFrame(_ text: String) {
        guard !closed,
              let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }

        let type = frame["type"] as? String ?? ""
        if type == "hello" { return }
        if type == "rtc" { // P2P media: the WebView answers (only while the app is open)
            AgentCore.shared.forwardRtc(driveId: config.driveId, frame: text)
            return
        }
        if type.hasPrefix("sync-") { return } // multi-device gossip: desktop-only for now
        guard type == "request",
              let reqId = frame["reqId"] as? String, !reqId.isEmpty,
              (frame["v"] as? Int) == AgentCore.protocolVersion
        else { return }

        var signed = frame
        signed.removeValue(forKey: "sig")
        signed.removeValue(forKey: "type")
        guard Sig.verify(secret: config.driveSecret, payload: signed, sig: frame["sig"] as? String) else {
            return // forged frame — drop silently, as the desktop agent does
        }

        var response: [String: Any]
        do {
            guard let params = frame["params"] as? [String: Any] else { throw RpcHandler.RpcError.unknownMethod }
            let result = try rpc.handle(params)
            response = ["reqId": reqId, "ok": true, "result": result]
            status.rpcCount += 1
        } catch {
            response = ["reqId": reqId, "ok": false, "error": AgentCore.sanitize(error.localizedDescription)]
        }

        // Sign WITHOUT `type`, then add it — what the desktop agent does, and
        // what the server strips before verifying.
        let sig = Sig.sign(secret: config.driveSecret, payload: response)
        response["type"] = "response"
        response["sig"] = sig

        if let out = try? JSONSerialization.data(withJSONObject: response),
           let outText = String(data: out, encoding: .utf8) {
            task?.send(.string(outText)) { _ in }
        }
        core.emit()
    }
}
