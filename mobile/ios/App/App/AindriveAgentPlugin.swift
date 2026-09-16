import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Bridge between the shell UI (src/main.ts) and the native agent.
///
/// Folder access goes through the document picker rather than a broad
/// photo/files entitlement: the user picks exactly one folder, we persist a
/// security-scoped bookmark so the drive survives relaunches, and we can never
/// read anything they did not hand over. That is the mobile equivalent of
/// running `aindrive` inside one directory.
@objc(AindriveAgentPlugin)
public class AindriveAgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AindriveAgentPlugin"
    public let jsName = "AindriveAgent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    private static let bookmarkKey = "ai.ainetwork.aindrive.folderBookmark"
    private var pickCall: CAPPluginCall?

    public override func load() {
        AgentCore.shared.onStatusChange = { [weak self] status in
            self?.notifyListeners("statusChanged", data: status.dictionary)
        }
    }

    // MARK: - folder

    @objc func pickFolder(_ call: CAPPluginCall) {
        pickCall = call
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    // MARK: - agent

    @objc func start(_ call: CAPPluginCall) {
        let required = ["serverUrl", "driveId", "agentToken", "driveSecret", "folderUri"]
        for key in required where call.getString(key) == nil {
            call.reject("missing \(key)")
            return
        }
        guard let folder = Self.resolveBookmark(call.getString("folderUri")!) else {
            call.reject("폴더 접근 권한이 만료되었습니다. 폴더를 다시 선택하세요.")
            return
        }
        let config = AgentCore.Config(
            serverUrl: call.getString("serverUrl")!,
            driveId: call.getString("driveId")!,
            agentToken: call.getString("agentToken")!,
            driveSecret: call.getString("driveSecret")!,
            folderLabel: call.getString("folderLabel") ?? folder.lastPathComponent)
        AgentCore.shared.start(config: config, folder: folder)
        call.resolve(AgentCore.shared.status.dictionary)
    }

    @objc func stop(_ call: CAPPluginCall) {
        AgentCore.shared.stop()
        call.resolve(AgentCore.shared.status.dictionary)
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(AgentCore.shared.status.dictionary)
    }

    // MARK: - bookmarks

    /// A picked URL is not durable across launches; its bookmark is. The
    /// bookmark is stored under a key returned to JS as the opaque `uri`.
    private static func storeBookmark(_ url: URL) throws -> String {
        let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        let key = "\(bookmarkKey).\(UUID().uuidString)"
        UserDefaults.standard.set(data, forKey: key)
        return key
    }

    private static func resolveBookmark(_ key: String) -> URL? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else { return nil }
        // A stale bookmark still resolves; refresh it so it does not expire later.
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: key)
        }
        return url
    }
}

extension AindriveAgentPlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        guard let url = urls.first else {
            call.reject("폴더 선택이 취소되었습니다")
            return
        }
        do {
            let key = try Self.storeBookmark(url)
            call.resolve(["uri": key, "label": url.lastPathComponent])
        } catch {
            call.reject("폴더 접근 권한을 유지할 수 없습니다: \(error.localizedDescription)")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.reject("폴더 선택이 취소되었습니다")
        pickCall = nil
    }
}
