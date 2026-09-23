import Foundation
import UniformTypeIdentifiers

/// The drive's filesystem: a real folder the user picked in the Files app.
///
/// iOS hands out a *security-scoped* URL; access only works between
/// `startAccessingSecurityScopedResource()` and its stop counterpart, and the
/// URL itself is not durable across launches — a bookmark is. So the picker
/// stores bookmark data and the agent resolves it at start.
///
/// Semantics mirror cli/src/rpc.js and the Android SafFs so the web UI cannot
/// tell the three apart.
final class DriveFs {
    struct Entry {
        let name: String
        let path: String
        let isDir: Bool
        let size: Int
        let mtimeMs: Double
        let ext: String
        let mime: String
    }

    enum FsError: LocalizedError {
        case escapes, notFound(String), isDirectory, tooLong, cannotTouchRoot(String)
        var errorDescription: String? {
            switch self {
            case .escapes: return "path escapes drive root"
            case .notFound(let p): return "no such path: \(p)"
            case .isDirectory: return "is a directory"
            case .tooLong: return "path too long"
            case .cannotTouchRoot(let op): return "cannot \(op) root"
            }
        }
    }

    static let maxPathBytes = 4096
    static let maxReadBytes = 8 * 1024 * 1024
    static let maxChunkBytes = 4 * 1024 * 1024

    /// Never exposed to the web side — matches HIDDEN in cli/src/rpc.js.
    private static let hidden: Set<String> = [".aindrive", ".DS_Store", ".git"]

    private let root: URL
    private let fm = FileManager.default
    private let scoped: Bool

    /// - Parameter root: a security-scoped folder URL resolved from a bookmark.
    init(root: URL) {
        self.root = root.standardizedFileURL
        self.scoped = root.startAccessingSecurityScopedResource()
    }

    deinit {
        if scoped { root.stopAccessingSecurityScopedResource() }
    }

    // MARK: - paths

    /// Resolve a web-supplied relative path, refusing anything outside the tree.
    func resolve(_ rel: String) throws -> URL {
        guard rel.utf8.count <= Self.maxPathBytes else { throw FsError.tooLong }
        var url = root
        for seg in rel.split(separator: "/") {
            if seg == "." { continue }
            if seg == ".." { throw FsError.escapes }
            url.appendPathComponent(String(seg))
        }
        let resolved = url.standardizedFileURL
        // Belt-and-braces: a symlink inside the folder could still point out of it.
        guard resolved.path == root.path || resolved.path.hasPrefix(root.path + "/") else {
            throw FsError.escapes
        }
        return resolved
    }

    func relPath(of url: URL) -> String {
        let p = url.standardizedFileURL.path
        guard p.hasPrefix(root.path) else { return url.lastPathComponent }
        return String(p.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    // MARK: - reads

    func list(_ rel: String) throws -> [Entry] {
        let dir = try resolve(rel)
        let urls = try fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey],
            options: [])
        var out = urls.compactMap { url -> Entry? in
            guard !Self.hidden.contains(url.lastPathComponent) else { return nil }
            return try? entry(at: url)
        }
        out.sort {
            $0.isDir != $1.isDir
                ? $0.isDir
                : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        return out
    }

    /// Entry for one path, or nil when it does not exist — `stat` never throws
    /// on absence, matching the desktop agent.
    func stat(_ rel: String) -> Entry? {
        guard let url = try? resolve(rel), fm.fileExists(atPath: url.path) else { return nil }
        return try? entry(at: url)
    }

    private func entry(at url: URL) throws -> Entry {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey])
        let isDir = values.isDirectory ?? false
        let name = url.lastPathComponent
        return Entry(
            name: name,
            path: relPath(of: url),
            isDir: isDir,
            size: isDir ? 0 : (values.fileSize ?? 0),
            mtimeMs: (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
            ext: (name as NSString).pathExtension.lowercased(),
            mime: isDir ? "folder" : Self.guessMime(name))
    }

    func read(_ rel: String, maxBytes: Int) throws -> Data {
        let url = try resolve(rel)
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else { throw FsError.notFound(rel) }
        guard !isDir.boolValue else { throw FsError.isDirectory }
        let cap = min(maxBytes <= 0 ? Self.maxReadBytes : maxBytes, Self.maxReadBytes)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return (try handle.read(upToCount: cap)) ?? Data()
    }

    func readChunk(_ rel: String, offset: UInt64, length: Int) throws -> Data {
        let url = try resolve(rel)
        let cap = min(length <= 0 ? Self.maxChunkBytes : length, Self.maxChunkBytes)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        return (try handle.read(upToCount: cap)) ?? Data()
    }

    // MARK: - writes

    func write(_ rel: String, data: Data, append: Bool) throws {
        let url = try resolve(rel)
        guard url.path != root.path else { throw FsError.cannotTouchRoot("write") }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if append, fm.fileExists(atPath: url.path) {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } else {
            try data.write(to: url, options: .atomic)
        }
    }

    func mkdir(_ rel: String) throws {
        try fm.createDirectory(at: try resolve(rel), withIntermediateDirectories: true)
    }

    func delete(_ rel: String) throws {
        let url = try resolve(rel)
        guard url.path != root.path else { throw FsError.cannotTouchRoot("delete") }
        // Idempotent, like `rm -rf` in the desktop agent.
        guard fm.fileExists(atPath: url.path) else { return }
        try fm.removeItem(at: url)
    }

    func rename(from: String, to: String) throws {
        let src = try resolve(from)
        let dst = try resolve(to)
        guard src.path != root.path else { throw FsError.cannotTouchRoot("rename") }
        guard fm.fileExists(atPath: src.path) else { throw FsError.notFound(from) }
        try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
        try fm.moveItem(at: src, to: dst)
    }

    // MARK: - mime

    static func guessMime(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "md": return "text/markdown"
        case "ts", "tsx": return "text/typescript"
        case "mjs", "jsx": return "text/javascript"
        case "py": return "text/x-python"
        case "rs": return "text/x-rust"
        case "go": return "text/x-go"
        default:
            if let t = UTType(filenameExtension: ext)?.preferredMIMEType { return t }
            return "application/octet-stream"
        }
    }
}
