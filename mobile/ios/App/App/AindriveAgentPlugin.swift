import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Bridge between the shell UI (src/main.ts) and the native agent.
///
/// Folder access goes through the document picker rather than a broad
/// photo/files entitlement: the user picks a folder per drive, we persist a
/// security-scoped bookmark so the drive survives relaunches, and we can never
/// read anything they did not hand over. Each picked folder becomes its own
/// drive with its own socket — the mobile equivalent of running one `aindrive`
/// per directory. `start` adds a drive, `stop({driveId})` removes one, and
/// `stop()` with no id takes everything offline.
@objc(AindriveAgentPlugin)
public class AindriveAgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AindriveAgentPlugin"
    public let jsName = "AindriveAgent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    private static let bookmarkKey = "ai.ainetwork.aindrive.folderBookmark"
    private var pickCall: CAPPluginCall?
    /// Kept alive while a preview is up: the security scope lives in the DriveFs.
    private var previewFs: DriveFs?
    private var previewController: UIDocumentInteractionController?
    /// What the pending document picker is for; its delegate is shared.
    private enum PickMode { case folder, filesInto(URL, String) }
    private var pickMode: PickMode = .folder

    public override func load() {
        AgentCore.shared.onStatusChange = { [weak self] status in
            self?.notifyListeners("statusChanged", data: status.dictionary)
        }
    }

    // MARK: - folder

    @objc func pickFolder(_ call: CAPPluginCall) {
        pickMode = .folder
        present(call, types: [.folder], multiple: false)
    }

    /// "Put files into a shared folder": the file picker is the phone's drag-and-drop.
    @objc func addFiles(_ call: CAPPluginCall) {
        guard let key = call.getString("folderUri"), let folder = Self.resolveBookmark(key) else {
            call.reject("Folder access permission has expired. Please pick the folder again.")
            return
        }
        pickMode = .filesInto(folder, call.getString("path") ?? "")
        present(call, types: [.item], multiple: true)
    }

    private func present(_ call: CAPPluginCall, types: [UTType], multiple: Bool) {
        pickCall = call
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = multiple
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    // MARK: - browse

    /// In-app file browser for a shared folder: the same folder the agent
    /// serves, read locally — no network, works while the drive is off.
    @objc func listFolder(_ call: CAPPluginCall) {
        guard let key = call.getString("folderUri"), let folder = Self.resolveBookmark(key) else {
            call.reject("Folder access permission has expired. Please pick the folder again.")
            return
        }
        let fs = DriveFs(root: folder)
        do {
            let entries = try fs.list(call.getString("path") ?? "").map { e -> [String: Any] in
                ["name": e.name, "path": e.path, "isDir": e.isDir, "size": e.size, "mtimeMs": e.mtimeMs, "mime": e.mime]
            }
            call.resolve(["entries": entries])
        } catch {
            call.reject("Could not read folder: \(error.localizedDescription)")
        }
    }

    /// Quick Look preview of a file (the phone's "open").
    @objc func openFile(_ call: CAPPluginCall) {
        guard let key = call.getString("folderUri"), let folder = Self.resolveBookmark(key),
              let path = call.getString("path") else {
            call.reject("missing folderUri/path")
            return
        }
        let fs = DriveFs(root: folder)
        guard let url = try? fs.resolve(path) else {
            call.reject("Could not open file")
            return
        }
        DispatchQueue.main.async {
            self.previewFs = fs
            let controller = UIDocumentInteractionController(url: url)
            controller.delegate = self
            self.previewController = controller
            if !controller.presentPreview(animated: true) {
                controller.presentOptionsMenu(from: .zero, in: self.bridge?.viewController?.view ?? UIView(), animated: true)
            }
            call.resolve()
        }
    }

    /// Basic edits for the in-app browser; same DriveFs calls the web's RPCs use.
    @objc func mkdir(_ call: CAPPluginCall) {
        withFs(call) { try $0.mkdir(call.getString("path") ?? "") }
    }

    @objc func rename(_ call: CAPPluginCall) {
        withFs(call) { try $0.rename(from: call.getString("from") ?? "", to: call.getString("to") ?? "") }
    }

    @objc func delete(_ call: CAPPluginCall) {
        withFs(call) { try $0.delete(call.getString("path") ?? "") }
    }

    private func withFs(_ call: CAPPluginCall, _ op: (DriveFs) throws -> Void) {
        guard let key = call.getString("folderUri"), let folder = Self.resolveBookmark(key) else {
            call.reject("Folder access permission has expired. Please pick the folder again.")
            return
        }
        do { try op(DriveFs(root: folder)); call.resolve() }
        catch { call.reject(error.localizedDescription) }
    }

    // MARK: - agent

    @objc func start(_ call: CAPPluginCall) {
        let required = ["serverUrl", "driveId", "agentToken", "driveSecret", "folderUri"]
        for key in required where call.getString(key) == nil {
            call.reject("missing \(key)")
            return
        }
        guard let folder = Self.resolveBookmark(call.getString("folderUri")!) else {
            call.reject("Folder access permission has expired. Please pick the folder again.")
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
        if let driveId = call.getString("driveId") {
            AgentCore.shared.stop(driveId: driveId)
        } else {
            AgentCore.shared.stopAll()
        }
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

extension AindriveAgentPlugin: UIDocumentInteractionControllerDelegate {
    public func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController) -> UIViewController {
        bridge?.viewController ?? UIViewController()
    }
    public func documentInteractionControllerDidEndPreview(_ controller: UIDocumentInteractionController) {
        previewController = nil
        previewFs = nil
    }
}

extension AindriveAgentPlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        guard let url = urls.first else {
            call.reject("Selection was cancelled")
            return
        }
        switch pickMode {
        case .folder:
            do {
                let key = try Self.storeBookmark(url)
                call.resolve(["uri": key, "label": url.lastPathComponent])
            } catch {
                call.reject("Could not persist folder access permission: \(error.localizedDescription)")
            }
        case .filesInto(let folder, let dir):
            DispatchQueue.global(qos: .userInitiated).async {
                let scoped = folder.startAccessingSecurityScopedResource()
                defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
                var added: [String] = [], failed: [String] = []
                for src in urls {
                    let srcScoped = src.startAccessingSecurityScopedResource()
                    defer { if srcScoped { src.stopAccessingSecurityScopedResource() } }
                    let dst = (dir.isEmpty ? folder : folder.appendingPathComponent(dir, isDirectory: true))
                        .appendingPathComponent(src.lastPathComponent)
                    do {
                        if FileManager.default.fileExists(atPath: dst.path) { try FileManager.default.removeItem(at: dst) }
                        try FileManager.default.copyItem(at: src, to: dst)
                        added.append(src.lastPathComponent)
                    } catch {
                        failed.append("\(src.lastPathComponent): \(error.localizedDescription)")
                    }
                }
                call.resolve(["added": added, "failed": failed])
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.reject("Selection was cancelled")
        pickCall = nil
    }
}
