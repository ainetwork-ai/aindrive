import CryptoKit
import Foundation

/// Dispatches one signed RPC onto the picked device folder.
///
/// Method set and result shapes mirror cli/src/rpc.js exactly — the server
/// cannot tell a phone drive from a laptop drive, so any divergence shows up
/// as a broken file browser rather than a clean error.
///
/// Two deliberate differences, same as on Android:
///  - `yjs-*` keeps only the latest snapshot (no Y.js in this process), which
///    is the legacy fallback the desktop agent still honours. Collaboration
///    still converges through the server; local edit history is what is lost.
///  - `agent-ask` is refused: running a drive's AI agent means holding the
///    owner's LLM key and walking the whole folder, neither of which belongs
///    on a phone yet.
///
/// Yjs snapshots live in the app's own Application Support directory, never in
/// the user's folder — a phone's Documents should not sprout a control
/// directory the user never asked for.
struct RpcHandler {
    enum RpcError: LocalizedError {
        case unknownMethod, invalidDocId, chunkTooLarge, blobTooLarge, agentAskUnsupported
        var errorDescription: String? {
            switch self {
            case .unknownMethod: return "unknown method"
            case .invalidDocId: return "invalid docId"
            case .chunkTooLarge: return "chunk too large"
            case .blobTooLarge: return "yjs blob too large"
            case .agentAskUnsupported: return "agent_ask_unsupported_on_mobile"
            }
        }
    }

    private static let methods: Set<String> = [
        "list", "stat", "read", "write", "mkdir", "rename", "delete",
        "upload-chunk", "download-chunk", "media-index", "yjs-write", "yjs-read", "yjs-stats",
        "agent-ask",
    ]

    let fs: DriveFs
    let yjsDir: URL
    /// media-index results by "path|size|mtime": re-hashing a long video on every play would drain the battery.
    /// Guarded by a lock: background hashing finishes on another queue.
    private static var mediaIndexMemo: [String: [String]] = [:]
    private static var mediaIndexing = Set<String>()
    private static let mediaLock = NSLock()
    static func memoGet(_ k: String) -> [String]? { mediaLock.lock(); defer { mediaLock.unlock() }; return mediaIndexMemo[k] }
    static func startIndexing(_ k: String) -> Bool { mediaLock.lock(); defer { mediaLock.unlock() }; return mediaIndexing.insert(k).inserted }
    static func finishIndexing(_ k: String, _ leaves: [String]?) {
        mediaLock.lock(); defer { mediaLock.unlock() }
        mediaIndexing.remove(k)
        if let l = leaves { if mediaIndexMemo.count > 200 { mediaIndexMemo.removeAll() }; mediaIndexMemo[k] = l }
    }

    init(fs: DriveFs, driveId: String) {
        self.fs = fs
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.yjsDir = base.appendingPathComponent("yjs/\(driveId.replacingOccurrences(of: "/", with: "_"))")
    }

    func handle(_ params: [String: Any]) throws -> [String: Any] {
        let method = params["method"] as? String ?? ""
        guard Self.methods.contains(method) else { throw RpcError.unknownMethod }

        switch method {
        case "list":
            let entries = try fs.list(params["path"] as? String ?? "")
            return ["method": method, "entries": entries.map(Self.entryJson)]

        case "stat":
            guard let e = fs.stat(params["path"] as? String ?? "") else {
                return ["method": method, "entry": NSNull()]
            }
            return ["method": method, "entry": Self.entryJson(e)]

        case "read":
            let path = params["path"] as? String ?? ""
            guard let e = fs.stat(path) else { throw DriveFs.FsError.notFound(path) }
            guard !e.isDir else { throw DriveFs.FsError.isDirectory }
            let data = try fs.read(path, maxBytes: params["maxBytes"] as? Int ?? DriveFs.maxReadBytes)
            let base64 = (params["encoding"] as? String) == "base64"
            return [
                "method": method,
                "content": base64 ? data.base64EncodedString() : (String(data: data, encoding: .utf8) ?? ""),
                "encoding": base64 ? "base64" : "utf8",
                "truncated": e.size > data.count,
            ]

        case "write":
            let data = Self.decodeBody(params["content"] as? String ?? "", params["encoding"] as? String)
            try fs.write(params["path"] as? String ?? "", data: data, append: false)
            return ["method": method, "ok": true, "bytes": data.count]

        case "mkdir":
            try fs.mkdir(params["path"] as? String ?? "")
            return ["method": method, "ok": true]

        case "rename":
            try fs.rename(from: params["from"] as? String ?? "", to: params["to"] as? String ?? "")
            return ["method": method, "ok": true]

        case "delete":
            try fs.delete(params["path"] as? String ?? "")
            return ["method": method, "ok": true]

        case "upload-chunk":
            let data = Data(base64Encoded: params["data"] as? String ?? "") ?? Data()
            guard data.count <= DriveFs.maxChunkBytes else { throw RpcError.chunkTooLarge }
            // chunkId 0 truncates, later chunks append — same contract as desktop.
            let append = (params["chunkId"] as? Int ?? 0) != 0
            try fs.write(params["path"] as? String ?? "", data: data, append: append)
            return ["method": method, "ok": true, "receivedBytes": data.count]

        case "media-index":
            // the file's 1 MiB chunk hash list: the server checks every chunk it fetches
            // from this phone against it, and keeps them, so the uplink carries each byte once
            let path = params["path"] as? String ?? ""
            guard let e = fs.stat(path), !e.isDir else { throw NSError(domain: "aindrive", code: 404, userInfo: [NSLocalizedDescriptionKey: "not a file"]) }
            let memoKey = "\(path)|\(e.size)|\(e.mtimeMs)"
            let leaves: [String]
            if let hit = RpcHandler.memoGet(memoKey) { leaves = hit } else if e.size > 16 * MediaIndex.chunk {
                // a long video: hash it off the RPC queue and answer "pending" now;
                // the server streams directly meanwhile and asks again later
                if RpcHandler.startIndexing(memoKey) {
                    let fs = self.fs
                    let size = UInt64(e.size)
                    DispatchQueue.global(qos: .utility).async {
                        let l = try? MediaIndex.leaves(size: size) { off, len in try fs.readChunk(path, offset: off, length: len) }
                        RpcHandler.finishIndexing(memoKey, l)
                    }
                }
                return ["method": method, "pending": true]
            } else {
                leaves = try MediaIndex.leaves(size: UInt64(e.size)) { off, len in try fs.readChunk(path, offset: off, length: len) }
                RpcHandler.finishIndexing(memoKey, leaves)
            }
            return ["method": method, "size": e.size, "mtimeMs": e.mtimeMs, "chunk": MediaIndex.chunk, "leaves": leaves]
        case "download-chunk":
            let path = params["path"] as? String ?? ""
            let offset = UInt64(params["offset"] as? Int ?? 0)
            let data = try fs.readChunk(path, offset: offset, length: params["length"] as? Int ?? DriveFs.maxChunkBytes)
            let size = fs.stat(path)?.size ?? 0
            return [
                "method": method,
                "data": data.base64EncodedString(),
                "eof": Int(offset) + data.count >= size,
            ]

        case "yjs-write":
            let docId = try Self.requireDocId(params["docId"] as? String ?? "")
            let data = Data(base64Encoded: params["data"] as? String ?? "") ?? Data()
            guard data.count <= 4 * DriveFs.maxChunkBytes else { throw RpcError.blobTooLarge }
            try FileManager.default.createDirectory(at: yjsDir, withIntermediateDirectories: true)
            try data.write(to: yjsDir.appendingPathComponent("\(docId).bin"), options: .atomic)
            return ["method": method, "ok": true, "bytes": data.count, "seq": 1, "digest": ""]

        case "yjs-read":
            let docId = try Self.requireDocId(params["docId"] as? String ?? "")
            guard let data = try? Data(contentsOf: yjsDir.appendingPathComponent("\(docId).bin")) else {
                return ["method": method, "data": "", "bytes": 0]
            }
            return ["method": method, "data": data.base64EncodedString(), "bytes": data.count]

        case "yjs-stats":
            let docId = try Self.requireDocId(params["docId"] as? String ?? "")
            let bytes = (try? Data(contentsOf: yjsDir.appendingPathComponent("\(docId).bin")).count) ?? 0
            return ["method": method, "entries": bytes > 0 ? 1 : 0, "totalBytes": bytes, "snapshotBytes": bytes]

        case "agent-ask":
            throw RpcError.agentAskUnsupported

        default:
            throw RpcError.unknownMethod
        }
    }

    // MARK: - helpers

    private static func entryJson(_ e: DriveFs.Entry) -> [String: Any] {
        [
            "name": e.name, "path": e.path, "isDir": e.isDir,
            "size": e.size, "mtimeMs": e.mtimeMs, "ext": e.ext, "mime": e.mime,
        ]
    }

    private static func decodeBody(_ content: String, _ encoding: String?) -> Data {
        encoding == "base64"
            ? (Data(base64Encoded: content) ?? Data())
            : Data(content.utf8)
    }

    /// Same docId shape the desktop agent enforces before touching disk.
    private static func requireDocId(_ docId: String) throws -> String {
        let ok = docId.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil
        guard ok else { throw RpcError.invalidDocId }
        return docId
    }
}


/// A file's chunk hash list for the server's verifying media cache (web
/// docs/superpowers/specs/2026-09-26-p2p-media-streaming-design.md, M2): 1 MiB
/// leaves, SHA-256 each, read chunk by chunk. Same algorithm as
/// web/shared/media/chunks.ts and MediaIndex.java; web/shared/media/chunk-vectors.json
/// pins it across all three.
enum MediaIndex {
    static let chunk = 1 << 20

    /// `read(offset, length)` returns up to `length` bytes; fewer only at the end of the file.
    static func leaves(size: UInt64, read: (UInt64, Int) throws -> Data) throws -> [String] {
        var out: [String] = []
        var offset: UInt64 = 0
        while offset < size {
            let want = Int(min(UInt64(chunk), size - offset))
            var buf = Data(capacity: want)
            while buf.count < want { // a reader may return less than asked: keep reading this chunk
                let part = try read(offset + UInt64(buf.count), want - buf.count)
                if part.isEmpty { throw NSError(domain: "aindrive", code: 1, userInfo: [NSLocalizedDescriptionKey: "file shrank while indexing"]) }
                buf.append(part)
            }
            out.append(SHA256.hash(data: buf).map { String(format: "%02x", $0) }.joined())
            offset += UInt64(buf.count)
        }
        return out
    }
}
