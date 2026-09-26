package ai.ainetwork.aindrive;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Dispatches one signed RPC onto the picked device folder.
 *
 * The method set and result shapes mirror cli/src/rpc.js exactly — the web
 * server has no idea whether it is talking to a laptop or a phone, so any
 * divergence here shows up as a broken file browser, not a clean error.
 *
 * Two methods behave differently on mobile, deliberately:
 *
 *  - yjs-*   : the desktop agent keeps an append-only Willow store plus a
 *              snapshot, and replays entries through Y.js on read. There is no
 *              Y.js in this process, so we keep only the snapshot — which is
 *              precisely the legacy fallback path the desktop agent still
 *              supports. Collaborative editing converges through the server;
 *              what is lost is local edit history, not correctness.
 *  - agent-ask: answered by the on-device photo-search agent (agent/AskRunner)
 *              over this drive's local index — no LLM API key on the phone,
 *              no network. Same {answer, sources} shape as the desktop agent.
 *
 * Yjs snapshots live in app-private storage, never in the user's folder: the
 * phone's Documents directory should not grow an .aindrive/ control directory
 * the user did not ask for and cannot easily clean up.
 */
final class RpcHandler {
    /** media-index results by "path|size|mtime": re-hashing a long video on every play would drain the battery. */
    private static final java.util.Map<String, java.util.List<String>> MEDIA_INDEX = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.Set<String> MEDIA_INDEXING = java.util.concurrent.ConcurrentHashMap.newKeySet();

    private static final Set<String> METHODS = new HashSet<>(Arrays.asList(
            "list", "stat", "read", "write", "mkdir", "rename", "delete",
            "upload-chunk", "download-chunk", "media-index", "yjs-write", "yjs-read", "yjs-stats",
            "agent-ask", "handoff-read"));

    private final SafFs fs;
    private final Context ctx;
    private final File yjsDir;
    private final java.util.function.Supplier<ai.ainetwork.aindrive.agent.AskRunner> ask;

    RpcHandler(Context ctx, SafFs fs, String driveId,
               java.util.function.Supplier<ai.ainetwork.aindrive.agent.AskRunner> ask) {
        this.fs = fs;
        this.ctx = ctx.getApplicationContext();
        this.yjsDir = new File(ctx.getFilesDir(), "yjs/" + sanitizeId(driveId));
        this.ask = ask;
    }

    JSONObject handle(JSONObject params) throws Exception {
        String method = params.optString("method", "");
        if (!METHODS.contains(method)) throw new IOException("unknown method");

        switch (method) {
            case "list": {
                List<SafFs.Entry> entries = fs.list(params.optString("path", ""));
                JSONArray arr = new JSONArray();
                for (SafFs.Entry e : entries) arr.put(entryJson(e));
                return result(method).put("entries", arr);
            }
            case "stat": {
                SafFs.Entry e = fs.stat(params.optString("path", ""));
                return result(method).put("entry", e == null ? JSONObject.NULL : entryJson(e));
            }
            case "read": {
                String path = params.optString("path", "");
                SafFs.Entry e = fs.stat(path);
                if (e == null) throw new IOException("no such file");
                if (e.isDir) throw new IOException("is a directory");
                int maxBytes = params.optInt("maxBytes", SafFs.MAX_READ_BYTES);
                byte[] data = fs.read(path, maxBytes);
                boolean base64 = "base64".equals(params.optString("encoding"));
                return result(method)
                        .put("content", base64
                                ? Base64.encodeToString(data, Base64.NO_WRAP)
                                : new String(data, StandardCharsets.UTF_8))
                        .put("encoding", base64 ? "base64" : "utf8")
                        .put("truncated", e.size > data.length);
            }
            case "write": {
                String path = params.optString("path", "");
                byte[] data = decodeBody(params.optString("content", ""), params.optString("encoding"));
                fs.write(path, data, false);
                return result(method).put("ok", true).put("bytes", data.length);
            }
            case "mkdir": {
                fs.mkdirs(params.optString("path", ""));
                return result(method).put("ok", true);
            }
            case "rename": {
                fs.rename(params.optString("from", ""), params.optString("to", ""));
                return result(method).put("ok", true);
            }
            case "delete": {
                fs.delete(params.optString("path", ""));
                return result(method).put("ok", true);
            }
            case "upload-chunk": {
                byte[] data = Base64.decode(params.optString("data", ""), Base64.DEFAULT);
                if (data.length > SafFs.MAX_CHUNK_BYTES) throw new IOException("chunk too large");
                // chunkId 0 truncates, later chunks append — same contract as the desktop agent.
                fs.write(params.optString("path", ""), data, params.optInt("chunkId", 0) != 0);
                return result(method).put("ok", true).put("receivedBytes", data.length);
            }
            case "download-chunk": {
                String path = params.optString("path", "");
                long offset = params.optLong("offset", 0);
                int length = params.optInt("length", SafFs.MAX_CHUNK_BYTES);
                byte[] data = fs.readChunk(path, offset, length);
                SafFs.Entry e = fs.stat(path);
                long size = e == null ? 0 : e.size;
                return result(method)
                        .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
                        .put("eof", offset + data.length >= size);
            }
            case "media-index": {
                // the file's 1 MiB chunk hash list: the server checks every chunk it fetches
                // from this phone against it, and keeps them, so the uplink carries each byte once
                String path = params.optString("path", "");
                SafFs.Entry e = fs.stat(path);
                if (e == null || e.isDir) throw new IOException("not a file");
                String memoKey = path + "|" + e.size + "|" + e.mtimeMs;
                java.util.List<String> leaves = MEDIA_INDEX.get(memoKey);
                if (leaves == null) {
                    MediaIndex.Reader reader = (off, len) -> fs.readChunk(path, off, len);
                    if (e.size > 16L * MediaIndex.CHUNK) {
                        // a long video: hash it off the RPC thread and answer "pending" now;
                        // the server streams directly meanwhile and asks again later
                        if (MEDIA_INDEXING.add(memoKey)) {
                            final long size = e.size;
                            Thread t = new Thread(() -> {
                                try { java.util.List<String> l = MediaIndex.leaves(reader, size); if (MEDIA_INDEX.size() > 200) MEDIA_INDEX.clear(); MEDIA_INDEX.put(memoKey, l); }
                                catch (IOException ignored) {}
                                finally { MEDIA_INDEXING.remove(memoKey); }
                            }, "aindrive-media-index");
                            t.setDaemon(true);
                            t.setPriority(Thread.MIN_PRIORITY);
                            t.start();
                        }
                        return result(method).put("pending", true);
                    }
                    leaves = MediaIndex.leaves(reader, e.size);
                    if (MEDIA_INDEX.size() > 200) MEDIA_INDEX.clear();
                    MEDIA_INDEX.put(memoKey, leaves);
                }
                return result(method).put("size", e.size).put("mtimeMs", e.mtimeMs)
                        .put("chunk", MediaIndex.CHUNK).put("leaves", new org.json.JSONArray(leaves));
            }
            case "handoff-read": {
                // A file the owner registered for a handoff link (Handoffs) — never a path the server names.
                JSONObject r = Handoffs.read(ctx, params.optString("key", ""), params.optLong("offset", 0), params.optInt("length", SafFs.MAX_CHUNK_BYTES));
                return result(method).put("data", r.getString("data")).put("eof", r.getBoolean("eof")).put("size", r.getLong("size"));
            }
            case "yjs-write": {
                String docId = requireDocId(params.optString("docId", ""));
                byte[] data = Base64.decode(params.optString("data", ""), Base64.DEFAULT);
                if (data.length > 4 * SafFs.MAX_CHUNK_BYTES) throw new IOException("yjs blob too large");
                if (!yjsDir.exists() && !yjsDir.mkdirs()) throw new IOException("cannot create yjs dir");
                File f = new File(yjsDir, docId + ".bin");
                writeFileBytes(f, data);
                return result(method).put("ok", true).put("bytes", data.length)
                        .put("seq", 1).put("digest", "");
            }
            case "yjs-read": {
                String docId = requireDocId(params.optString("docId", ""));
                File f = new File(yjsDir, docId + ".bin");
                if (!f.exists()) return result(method).put("data", "").put("bytes", 0);
                byte[] data = readFileBytes(f);
                return result(method)
                        .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
                        .put("bytes", data.length);
            }
            case "yjs-stats": {
                String docId = requireDocId(params.optString("docId", ""));
                File f = new File(yjsDir, docId + ".bin");
                long bytes = f.exists() ? f.length() : 0;
                return result(method)
                        .put("entries", bytes > 0 ? 1 : 0)
                        .put("totalBytes", bytes)
                        .put("snapshotBytes", bytes);
            }
            case "agent-ask": {
                // The web side already checked who may ask; the phone has exactly
                // one kind of agent (photo search over this drive's index), so
                // agentId is validated for shape only and agent.json is never read.
                String agentId = params.optString("agentId", "");
                if (!agentId.matches("agt_[A-Za-z0-9_-]{6,32}")) throw new IOException("bad_agent_id");
                JSONObject r = ask.get().ask(params.optString("query", ""));
                return result(method).put("answer", r.getString("answer")).put("sources", r.getJSONArray("sources"));
            }
        }
        throw new IOException("unknown method");
    }

    // ------------------------------------------------------------ helpers

    private static JSONObject result(String method) throws Exception {
        return new JSONObject().put("method", method);
    }

    private static JSONObject entryJson(SafFs.Entry e) throws Exception {
        return new JSONObject()
                .put("name", e.name)
                .put("path", e.path)
                .put("isDir", e.isDir)
                .put("size", e.size)
                .put("mtimeMs", e.mtimeMs)
                .put("ext", e.ext)
                .put("mime", e.mime);
    }

    private static byte[] decodeBody(String content, String encoding) {
        return "base64".equals(encoding)
                ? Base64.decode(content, Base64.DEFAULT)
                : content.getBytes(StandardCharsets.UTF_8);
    }

    /** Same docId shape the desktop agent enforces before touching disk. */
    private static String requireDocId(String docId) throws IOException {
        if (!docId.matches("[A-Za-z0-9_-]{8,64}")) throw new IOException("invalid docId");
        return docId;
    }

    private static String sanitizeId(String s) {
        return s.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static void writeFileBytes(File f, byte[] data) throws IOException {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) { out.write(data); }
    }

    private static byte[] readFileBytes(File f) throws IOException {
        byte[] out = new byte[(int) f.length()];
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            int off = 0, n;
            while (off < out.length && (n = in.read(out, off, out.length - off)) > 0) off += n;
        }
        return out;
    }
}
