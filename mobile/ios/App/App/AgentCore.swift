import Foundation
import UIKit

/// The aindrive agent on iOS.
///
/// Same job as `aindrive` on a laptop (cli/src/agent.js): dial OUT to the
/// server over WSS, prove identity with the per-drive agent token, verify the
/// HMAC on every inbound frame, run the RPC against the user's folder, sign
/// the response. No inbound port is ever opened on the phone.
///
/// Background behaviour differs from Android, and the UI says so plainly:
/// iOS has no equivalent of a long-lived foreground service. A backgrounded
/// app keeps the socket only for the few seconds of a background task
/// assertion, then the drive goes offline until the app is reopened. Claiming
/// otherwise would mean a drive that silently stops answering.
final class AgentCore: NSObject {
    struct Config {
        let serverUrl: String
        let driveId: String
        let agentToken: String
        let driveSecret: String
        let folderLabel: String
    }

    struct Status {
        var running = false
        var connected = false
        var driveId: String?
        var folderLabel: String?
        var rpcCount = 0
        var lastError: String?

        var dictionary: [String: Any] {
            [
                "running": running,
                "connected": connected,
                "driveId": driveId as Any? ?? NSNull(),
                "folderLabel": folderLabel as Any? ?? NSNull(),
                "rpcCount": rpcCount,
                "lastError": lastError as Any? ?? NSNull(),
            ]
        }
    }

    private static let protocolVersion = 1
    /// Backoff schedule copied from cli/src/agent.js so reconnects feel the same.
    private static let backoff: [TimeInterval] = [1, 2, 4, 8, 15]

    static let shared = AgentCore()

    private(set) var status = Status()
    var onStatusChange: ((Status) -> Void)?

    private var config: Config?
    private var fs: DriveFs?
    private var rpc: RpcHandler?
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var attempt = 0
    private var stopping = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private let queue = DispatchQueue(label: "ai.ainetwork.aindrive.agent")

    // MARK: - lifecycle

    func start(config: Config, folder: URL) {
        stop(silent: true)
        self.config = config
        self.fs = DriveFs(root: folder)
        self.rpc = RpcHandler(fs: fs!, driveId: config.driveId)
        stopping = false
        attempt = 0
        status = Status(running: true, connected: false, driveId: config.driveId,
                        folderLabel: config.folderLabel, rpcCount: 0, lastError: nil)
        observeAppState()
        connect()
        emit()
    }

    func stop(silent: Bool = false) {
        stopping = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        fs = nil
        rpc = nil
        endBackgroundTask()
        status = Status()
        if !silent { emit() }
    }

    // MARK: - socket

    private func connect() {
        guard !stopping, let config else { return }
        guard let url = Self.wsUrl(server: config.serverUrl, driveId: config.driveId) else {
            status.lastError = "잘못된 서버 주소"
            emit()
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(config.agentToken)", forHTTPHeaderField: "authorization")

        let session = URLSession(configuration: .default)
        self.session = session
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        status.connected = true
        status.lastError = nil
        attempt = 0
        emit()
        sendHello()
        receive()
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

    private func sendHello() {
        let hello: [String: Any] = ["type": "agent-hello", "hostname": UIDevice.current.name]
        if let data = try? JSONSerialization.data(withJSONObject: hello),
           let text = String(data: data, encoding: .utf8) {
            task?.send(.string(text)) { _ in }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.status.connected = false
                self.scheduleReconnect(error.localizedDescription)
            case .success(let message):
                if case .string(let text) = message {
                    self.queue.async { self.onFrame(text) }
                }
                self.receive()
            }
        }
    }

    private func scheduleReconnect(_ why: String) {
        guard !stopping else { return }
        status.connected = false
        status.lastError = why
        emit()
        let wait = Self.backoff[min(attempt, Self.backoff.count - 1)]
        attempt += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
    }

    // MARK: - frames

    private func onFrame(_ text: String) {
        guard let config,
              let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }

        let type = frame["type"] as? String ?? ""
        if type == "hello" { return }
        if type.hasPrefix("sync-") { return } // multi-device gossip: desktop-only for now
        guard type == "request",
              let reqId = frame["reqId"] as? String, !reqId.isEmpty,
              (frame["v"] as? Int) == Self.protocolVersion
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
            let result = try rpc?.handle(params) ?? [:]
            response = ["reqId": reqId, "ok": true, "result": result]
            status.rpcCount += 1
        } catch {
            response = ["reqId": reqId, "ok": false, "error": Self.sanitize(error.localizedDescription)]
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
        emit()
    }

    /// Strip anything path-shaped out of error text before it leaves the phone.
    static func sanitize(_ msg: String) -> String {
        let stripped = msg.replacingOccurrences(
            of: "/[A-Za-z0-9_.%:/-]+", with: "<path>", options: .regularExpression)
        return String(stripped.prefix(300))
    }

    // MARK: - app state

    /// iOS gives a backgrounded app a short grace period; take it so an upload
    /// in flight when the user switches away has a chance to finish.
    private func observeAppState() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, !self.stopping else { return }
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "aindrive-agent") {
                self.endBackgroundTask()
            }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, !self.stopping else { return }
            self.endBackgroundTask()
            // The socket is usually dead after a spell in the background.
            if self.status.connected == false { self.connect() }
        }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    private func emit() {
        let snapshot = status
        DispatchQueue.main.async { [weak self] in self?.onStatusChange?(snapshot) }
    }
}
