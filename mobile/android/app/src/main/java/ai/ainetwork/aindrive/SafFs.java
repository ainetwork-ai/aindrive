package ai.ainetwork.aindrive;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.MimeTypeMap;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The drive's filesystem, backed by a Storage Access Framework tree the user
 * picked — i.e. REAL files on the phone (Downloads, Documents, an SD card, a
 * cloud provider mounted into Files), not an app-private sandbox.
 *
 * Mirrors the semantics of cli/src/rpc.js so the web UI cannot tell a phone
 * drive from a laptop drive: same entry shape, same hidden-name filter, same
 * root-escape rejection, same size limits.
 *
 * SAF has no path lookup, only per-parent child queries, so a relative path is
 * resolved one segment at a time. Resolutions are cached per path because the
 * web UI walks the same directories repeatedly; the cache is dropped for a
 * subtree whenever we mutate it.
 */
final class SafFs {
    static final int MAX_PATH_BYTES = 4096;
    static final int MAX_READ_BYTES = 8 * 1024 * 1024;
    static final int MAX_CHUNK_BYTES = 4 * 1024 * 1024;

    /** Never exposed to the web side — matches HIDDEN in cli/src/rpc.js. */
    private static final Set<String> HIDDEN = new HashSet<>(Arrays.asList(".aindrive", ".DS_Store", ".git"));

    private static final String[] COLS = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    };

    private final ContentResolver cr;
    private final Uri treeUri;
    private final String rootDocId;
    private final ConcurrentHashMap<String, String> pathToDocId = new ConcurrentHashMap<>();

    SafFs(Context ctx, Uri treeUri) {
        this.cr = ctx.getContentResolver();
        this.treeUri = treeUri;
        this.rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
        pathToDocId.put("", rootDocId);
    }

    static final class Entry {
        String name, path, mime, ext, docId;
        boolean isDir;
        long size, mtimeMs;
    }

    // ------------------------------------------------------------ paths

    /**
     * Split a web-supplied relative path into segments, rejecting anything that
     * would climb out of the tree. SAF cannot express "../" at all, but the
     * check is kept explicit so the failure is a clear error rather than a
     * confusing "not found".
     */
    static List<String> splitPath(String rel) throws IOException {
        if (rel == null) rel = "";
        if (rel.getBytes("UTF-8").length > MAX_PATH_BYTES) throw new IOException("path too long");
        List<String> out = new ArrayList<>();
        for (String seg : rel.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) throw new IOException("path escapes drive root");
            out.add(seg);
        }
        return out;
    }

    static String joinPath(String parent, String name) {
        return parent == null || parent.isEmpty() ? name : parent + "/" + name;
    }

    static String parentOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? "" : rel.substring(0, i);
    }

    static String baseName(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? rel : rel.substring(i + 1);
    }

    private Uri docUri(String docId) {
        return DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
    }

    private Uri childrenUri(String docId) {
        return DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId);
    }

    /** Resolve a relative path to a document id, or null if it does not exist. */
    String resolve(String rel) throws IOException {
        List<String> segs = splitPath(rel);
        String norm = String.join("/", segs);
        String cached = pathToDocId.get(norm);
        if (cached != null) return cached;

        String docId = rootDocId;
        StringBuilder walked = new StringBuilder();
        for (String seg : segs) {
            String child = findChildId(docId, seg);
            if (child == null) return null;
            docId = child;
            if (walked.length() > 0) walked.append('/');
            walked.append(seg);
            pathToDocId.put(walked.toString(), docId);
        }
        return docId;
    }

    private String findChildId(String parentDocId, String name) {
        try (Cursor c = cr.query(childrenUri(parentDocId), COLS, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                if (name.equals(c.getString(1))) return c.getString(0);
            }
        } catch (Exception ignored) { }
        return null;
    }

    /** Drop cached resolutions for a path and everything beneath it. */
    private void invalidate(String rel) {
        List<String> segs;
        try { segs = splitPath(rel); } catch (IOException e) { pathToDocId.clear(); return; }
        String norm = String.join("/", segs);
        if (norm.isEmpty()) { pathToDocId.clear(); pathToDocId.put("", rootDocId); return; }
        pathToDocId.remove(norm);
        String prefix = norm + "/";
        pathToDocId.keySet().removeIf(k -> k.startsWith(prefix));
    }

    // ------------------------------------------------------------ reads

    List<Entry> list(String rel) throws IOException {
        String docId = requireDoc(rel);
        List<Entry> out = new ArrayList<>();
        try (Cursor c = cr.query(childrenUri(docId), COLS, null, null, null)) {
            if (c == null) return out;
            while (c.moveToNext()) {
                String name = c.getString(1);
                if (name == null || HIDDEN.contains(name)) continue;
                Entry e = new Entry();
                e.docId = c.getString(0);
                e.name = name;
                e.path = joinPath(String.join("/", splitPath(rel)), name);
                e.mime = c.getString(2);
                e.isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(e.mime);
                e.size = c.isNull(3) ? 0 : c.getLong(3);
                e.mtimeMs = c.isNull(4) ? 0 : c.getLong(4);
                e.ext = extOf(name);
                if (e.isDir) e.mime = "folder";
                else if (e.mime == null || e.mime.isEmpty()) e.mime = guessMime(name);
                out.add(e);
                pathToDocId.put(e.path, e.docId);
            }
        }
        out.sort((a, b) -> a.isDir != b.isDir
                ? (a.isDir ? -1 : 1)
                : a.name.compareToIgnoreCase(b.name));
        return out;
    }

    /** Entry for one path, or null when it does not exist. */
    Entry stat(String rel) throws IOException {
        String docId = resolve(rel);
        if (docId == null) return null;
        try (Cursor c = cr.query(docUri(docId), COLS, null, null, null)) {
            if (c == null || !c.moveToFirst()) return null;
            Entry e = new Entry();
            e.docId = docId;
            e.name = c.getString(1) != null ? c.getString(1) : baseName(rel);
            e.path = String.join("/", splitPath(rel));
            e.mime = c.getString(2);
            e.isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(e.mime);
            e.size = c.isNull(3) ? 0 : c.getLong(3);
            e.mtimeMs = c.isNull(4) ? 0 : c.getLong(4);
            e.ext = extOf(e.name);
            if (e.isDir) e.mime = "folder";
            else if (e.mime == null || e.mime.isEmpty()) e.mime = guessMime(e.name);
            return e;
        }
    }

    byte[] read(String rel, int maxBytes) throws IOException {
        String docId = requireDoc(rel);
        int cap = Math.min(maxBytes <= 0 ? MAX_READ_BYTES : maxBytes, MAX_READ_BYTES);
        try (InputStream in = cr.openInputStream(docUri(docId))) {
            if (in == null) throw new IOException("cannot open for read");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int total = 0, n;
            while (total < cap && (n = in.read(buf, 0, Math.min(buf.length, cap - total))) > 0) {
                bos.write(buf, 0, n);
                total += n;
            }
            return bos.toByteArray();
        }
    }

    byte[] readChunk(String rel, long offset, int length) throws IOException {
        String docId = requireDoc(rel);
        int cap = Math.min(length <= 0 ? MAX_CHUNK_BYTES : length, MAX_CHUNK_BYTES);
        try (InputStream in = cr.openInputStream(docUri(docId))) {
            if (in == null) throw new IOException("cannot open for read");
            long skipped = 0;
            while (skipped < offset) {
                long s = in.skip(offset - skipped);
                if (s <= 0) break;
                skipped += s;
            }
            if (skipped < offset) return new byte[0];
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int total = 0, n;
            while (total < cap && (n = in.read(buf, 0, Math.min(buf.length, cap - total))) > 0) {
                bos.write(buf, 0, n);
                total += n;
            }
            return bos.toByteArray();
        }
    }

    // ------------------------------------------------------------ writes

    void write(String rel, byte[] data, boolean append) throws IOException {
        String docId = resolve(rel);
        if (docId == null) {
            if (append) throw new FileNotFoundException("no such file: " + rel);
            docId = createFile(rel);
        }
        // "wt" truncates; "wa" appends. Not every provider honours "wa", so an
        // append that is refused surfaces as a clear error instead of silently
        // overwriting the earlier chunks of an upload.
        try (OutputStream out = cr.openOutputStream(docUri(docId), append ? "wa" : "wt")) {
            if (out == null) throw new IOException("cannot open for write");
            out.write(data);
            out.flush();
        }
        invalidate(rel);
        pathToDocId.put(String.join("/", splitPath(rel)), docId);
    }

    /** Create the file (and any missing parent directories) and return its id. */
    private String createFile(String rel) throws IOException {
        List<String> segs = splitPath(rel);
        if (segs.isEmpty()) throw new IOException("cannot write the drive root");
        String name = segs.remove(segs.size() - 1);
        String parentId = mkdirs(String.join("/", segs));
        Uri created = DocumentsContract.createDocument(cr, docUri(parentId), guessMime(name), name);
        if (created == null) throw new IOException("create failed: " + rel);
        String id = DocumentsContract.getDocumentId(created);
        pathToDocId.put(String.join("/", splitPath(rel)), id);
        return id;
    }

    /** mkdir -p; returns the document id of the deepest directory. */
    String mkdirs(String rel) throws IOException {
        List<String> segs = splitPath(rel);
        String docId = rootDocId;
        StringBuilder walked = new StringBuilder();
        for (String seg : segs) {
            String child = findChildId(docId, seg);
            if (child == null) {
                Uri created = DocumentsContract.createDocument(
                        cr, docUri(docId), DocumentsContract.Document.MIME_TYPE_DIR, seg);
                if (created == null) throw new IOException("mkdir failed: " + seg);
                child = DocumentsContract.getDocumentId(created);
            }
            docId = child;
            if (walked.length() > 0) walked.append('/');
            walked.append(seg);
            pathToDocId.put(walked.toString(), docId);
        }
        return docId;
    }

    void delete(String rel) throws IOException {
        List<String> segs = splitPath(rel);
        if (segs.isEmpty()) throw new IOException("cannot delete root");
        String docId = resolve(rel);
        if (docId == null) return; // already gone — delete is idempotent, as in `rm -f`
        try {
            if (!DocumentsContract.deleteDocument(cr, docUri(docId))) throw new IOException("delete refused");
        } catch (FileNotFoundException ignored) {
            // Raced with another deleter; the postcondition still holds.
        }
        invalidate(rel);
    }

    void rename(String fromRel, String toRel) throws IOException {
        List<String> fromSegs = splitPath(fromRel);
        List<String> toSegs = splitPath(toRel);
        if (fromSegs.isEmpty()) throw new IOException("cannot rename root");
        if (toSegs.isEmpty()) throw new IOException("cannot rename onto root");

        String fromId = requireDoc(fromRel);
        String fromParent = parentOf(String.join("/", fromSegs));
        String toParent = parentOf(String.join("/", toSegs));
        String toName = toSegs.get(toSegs.size() - 1);

        // Desktop fs.rename replaces an existing target file; SAF move/rename
        // refuse a name collision (or silently produce "name (1)"). Match the
        // desktop contract — this is how uploads overwrite an existing file.
        String existing = resolve(toRel);
        if (existing != null && !existing.equals(fromId)) {
            Entry target = stat(toRel);
            if (target != null && target.isDir) throw new IOException("target is a directory");
            DocumentsContract.deleteDocument(cr, docUri(existing));
            invalidate(toRel);
        }

        String currentId = fromId;
        if (!fromParent.equals(toParent)) {
            String sourceParentId = requireDoc(fromParent);
            String targetParentId = mkdirs(toParent);
            Uri moved = DocumentsContract.moveDocument(
                    cr, docUri(currentId), docUri(sourceParentId), docUri(targetParentId));
            if (moved == null) throw new IOException("move not supported by this storage provider");
            currentId = DocumentsContract.getDocumentId(moved);
        }
        if (!toName.equals(baseName(String.join("/", fromSegs)))) {
            Uri renamed = DocumentsContract.renameDocument(cr, docUri(currentId), toName);
            if (renamed == null) throw new IOException("rename refused");
            currentId = DocumentsContract.getDocumentId(renamed);
        }
        invalidate(fromRel);
        invalidate(toRel);
        pathToDocId.put(String.join("/", toSegs), currentId);
    }

    private String requireDoc(String rel) throws IOException {
        String docId = resolve(rel);
        if (docId == null) throw new FileNotFoundException("no such path: " + rel);
        return docId;
    }

    // ------------------------------------------------------------ mime

    static String extOf(String name) {
        int i = name.lastIndexOf('.');
        return i <= 0 ? "" : name.substring(i + 1).toLowerCase(Locale.US);
    }

    /** Falls back to the platform map, then octet-stream — as guessMime does in cli/src/rpc.js. */
    static String guessMime(String name) {
        String ext = extOf(name);
        switch (ext) {
            case "md": return "text/markdown";
            case "ts": case "tsx": return "text/typescript";
            case "mjs": case "jsx": return "text/javascript";
            case "py": return "text/x-python";
            case "rs": return "text/x-rust";
            case "go": return "text/x-go";
            default:
                String m = ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                return m != null ? m : "application/octet-stream";
        }
    }
}
