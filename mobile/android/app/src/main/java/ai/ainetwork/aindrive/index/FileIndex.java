package ai.ainetwork.aindrive.index;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import androidx.annotation.Nullable;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Per-drive file index: what the on-device agent searches instead of walking
 * the folder at question time. Every file is a row (kind, name, size, when);
 * photos additionally carry EXIF time and a GPS-derived city/country.
 *
 * Lives in app-private storage (filesDir/index/<driveId>.db), never in the
 * user's folder — the same rule as the yjs snapshots: the phone's Documents
 * directory must not grow an .aindrive/ control directory the user did not
 * ask for. Rows are keyed by the SAF document id, which survives renames, so
 * a moved file is not re-read.
 */
public class FileIndex extends SQLiteOpenHelper {
    private static final int SCHEMA = 3;

    /** Coarse file categories a person names in a question ("screenshots", "PDF", "영상"). */
    public static final String PHOTO = "photo", SCREENSHOT = "screenshot", VIDEO = "video", AUDIO = "audio",
            PDF = "pdf", DOCUMENT = "document", SPREADSHEET = "spreadsheet", PRESENTATION = "presentation",
            ARCHIVE = "archive", OTHER = "other";

    public static final class Row {
        public String docId, path, name, kind, mime, country, city;
        public long mtimeMs, size;
        /** EXIF DateTimeOriginal for photos, else the file's mtime. */
        public @Nullable Long whenMs;
        public @Nullable Double lat, lon;
        /** CLIP image embedding (512 × float32, little-endian), null until recognised. */
        public @Nullable byte[] vec;
        /** Speech transcript for audio/video, null until recognised. */
        public @Nullable String transcript;
        public @Nullable float[] vector() { return vec == null ? null : decodeVec(vec); }
    }

    /** Hard filters; null/empty means "any". Ranking is the caller's job. */
    public static final class Filter {
        public @Nullable String kind, country, city;
        public @Nullable Long dateFrom, dateTo, minSize;
        /** Every keyword must appear in the file NAME (case-insensitive substring). */
        public List<String> keywords = new ArrayList<>();
        /** When set, keywords may match the transcript instead of the name (OR). */
        public boolean keywordsInTranscript;
        /** Only rows that have a CLIP vector. */
        public boolean withVec;
        /**
         * Only rows at or below this folder, given as its spellings (NFC and NFD of one path);
         * empty = the whole drive. Compared exactly (case-sensitive), never with LIKE: SQLite's
         * LIKE ignores ASCII case, and "Camera" must not match "camera".
         */
        public List<String> under = new ArrayList<>();
    }

    public FileIndex(Context ctx, String driveId) {
        super(ctx, dbPath(ctx, driveId), null, SCHEMA);
    }

    /**
     * Tests only: no database file behind it. SQLite isn't on the JVM, so a test subclass
     * overrides what the agent reads (count, query) to run AskRunner end to end.
     */
    protected FileIndex() {
        super(null, null, null, SCHEMA);
    }

    private static String dbPath(Context ctx, String driveId) {
        File dir = new File(ctx.getFilesDir(), "index");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, driveId.replaceAll("[^A-Za-z0-9_-]", "_") + ".db").getAbsolutePath();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE files ("
                + "doc_id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL,"
                + "kind TEXT NOT NULL, mime TEXT, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,"
                + "when_ms INTEGER, lat REAL, lon REAL, country TEXT, city TEXT, vec BLOB, transcript TEXT)");
        db.execSQL("CREATE INDEX files_when ON files(when_ms)");
        db.execSQL("CREATE INDEX files_kind ON files(kind)");
        db.execSQL("CREATE INDEX files_country ON files(country)");
        ensurePathIndex(db);
    }

    @Override
    public void onOpen(SQLiteDatabase db) {
        // Only a speed-up: a database that can't take it (full disk) still opens and answers.
        if (!db.isReadOnly()) { try { ensurePathIndex(db); } catch (RuntimeException ignored) { } }
    }

    /**
     * An index on `path`: the incremental updates after an upload, a rename or a delete look rows
     * up by path (a folder rename re-keys every file in it), which is a full scan without one.
     * Added with IF NOT EXISTS on open rather than by a schema bump, because onUpgrade rebuilds
     * the table and would throw away hours of photo vectors and transcripts.
     */
    private static void ensurePathIndex(SQLiteDatabase db) {
        db.execSQL("CREATE INDEX IF NOT EXISTS files_path ON files(path)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
        // v1 was photos-only with a different shape; a rebuild is cheap and exact.
        db.execSQL("DROP TABLE IF EXISTS photos");
        db.execSQL("DROP TABLE IF EXISTS meta");
        db.execSQL("DROP TABLE IF EXISTS files");
        onCreate(db);
    }

    /** Small key/value side table (report caches); created on first use so the schema version stays. */
    private void ensureMeta(SQLiteDatabase db) { db.execSQL("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"); }

    public @Nullable String getMeta(String key) {
        SQLiteDatabase db = getWritableDatabase(); ensureMeta(db);
        try (Cursor c = db.rawQuery("SELECT v FROM meta WHERE k = ?", new String[]{key})) { return c.moveToFirst() ? c.getString(0) : null; }
    }

    public void setMeta(String key, String value) {
        SQLiteDatabase db = getWritableDatabase(); ensureMeta(db);
        android.content.ContentValues v = new android.content.ContentValues(); v.put("k", key); v.put("v", value);
        db.insertWithOnConflict("meta", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /**
     * Transcripts from a different speech engine are dropped so they get
     * redone by the current one (a better engine must not leave old text behind).
     */
    public void adoptSpeechEngine(String engine) {
        // Transcripts take hours to redo, so only a real engine change drops them.
        String prev = getMeta("speechEngine");
        if (engine.equals(prev)) return;
        if (prev != null) getWritableDatabase().execSQL("UPDATE files SET transcript = NULL WHERE transcript IS NOT NULL");
        setMeta("speechEngine", engine);
    }

    /** Photo vectors from a different image model are meaningless to the new one: drop them so they get recomputed. */
    public void adoptImageModel(String model) {
        // ".v2": vectors from before the model was recorded came from an unknown (older) model — recompute them.
        String prev = getMeta("imageModel.v2");
        if (model.equals(prev)) return;
        getWritableDatabase().execSQL("UPDATE files SET vec = NULL WHERE vec IS NOT NULL");
        setMeta("imageModel.v2", model);
    }

    /** True when the file is unknown or changed since it was indexed. */
    public boolean needsIndex(String docId, long mtimeMs, long size) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT mtime_ms, size FROM files WHERE doc_id = ?", new String[]{docId})) {
            return !c.moveToFirst() || c.getLong(0) != mtimeMs || c.getLong(1) != size;
        }
    }

    /** Indexed, but recognition (vec / transcript) has not run yet — e.g. the model arrived later. */
    public boolean needsRecognition(String docId, boolean wantVec, boolean wantTranscript) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT vec IS NULL, transcript IS NULL FROM files WHERE doc_id = ?", new String[]{docId})) {
            if (!c.moveToFirst()) return true;
            return (wantVec && c.getInt(0) == 1) || (wantTranscript && c.getInt(1) == 1);
        }
    }

    public void setRecognition(String docId, @Nullable byte[] vec, @Nullable String transcript) {
        ContentValues v = new ContentValues();
        if (vec != null) v.put("vec", vec);
        if (transcript != null) v.put("transcript", transcript);
        if (v.size() > 0) getWritableDatabase().update("files", v, "doc_id = ?", new String[]{docId});
    }

    public int countRecognised() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM files WHERE vec IS NOT NULL OR transcript IS NOT NULL", null)) {
            return c.moveToFirst() ? c.getInt(0) : 0;
        }
    }

    public void upsert(Row r) {
        ContentValues v = new ContentValues();
        v.put("doc_id", r.docId);
        v.put("path", r.path);
        v.put("name", r.name);
        v.put("name_lc", r.name.toLowerCase(Locale.ROOT));
        v.put("kind", r.kind);
        v.put("mime", r.mime);
        v.put("mtime_ms", r.mtimeMs);
        v.put("size", r.size);
        if (r.whenMs != null) v.put("when_ms", r.whenMs); else v.putNull("when_ms");
        if (r.lat != null) v.put("lat", r.lat); else v.putNull("lat");
        if (r.lon != null) v.put("lon", r.lon); else v.putNull("lon");
        v.put("country", r.country);
        v.put("city", r.city);
        if (r.vec != null) v.put("vec", r.vec);
        if (r.transcript != null) v.put("transcript", r.transcript);
        getWritableDatabase().insertWithOnConflict("files", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Drop rows whose document no longer exists in the tree. */
    public int deleteMissing(Set<String> liveDocIds) {
        SQLiteDatabase db = getWritableDatabase();
        List<String> dead = new ArrayList<>();
        try (Cursor c = db.rawQuery("SELECT doc_id FROM files", null)) {
            while (c.moveToNext()) if (!liveDocIds.contains(c.getString(0))) dead.add(c.getString(0));
        }
        db.beginTransaction();
        try {
            for (String id : dead) db.delete("files", "doc_id = ?", new String[]{id});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return dead.size();
    }

    /**
     * Drop the rows at `path` or below it (any of its spellings), e.g. after the file was deleted
     * or moved away. Returns how many went.
     */
    public int removeUnder(List<String> spellings) {
        StringBuilder where = new StringBuilder();
        List<String> args = new ArrayList<>();
        appendUnder(where, args, spellings);
        if (args.isEmpty()) return 0;
        return getWritableDatabase().delete("files", where.toString(), args.toArray(new String[0]));
    }

    /**
     * A file moved from `oldPath` (any of its spellings) to `newPath`, and the storage may have
     * given it a new document id: when the old row is the same file (same size, mtime and kind),
     * re-key it instead of indexing it again, so its photo vector and transcript survive the move.
     * Returns false when there was no such row (the caller indexes the file afresh).
     */
    public boolean rekey(List<String> oldPath, String newDocId, String newPath, String newName, String newKind, long mtimeMs, long size) {
        SQLiteDatabase db = getWritableDatabase();
        for (String old : oldPath) {
            String oldId;
            try (Cursor c = db.rawQuery("SELECT doc_id FROM files WHERE path = ? AND mtime_ms = ? AND size = ? AND kind = ?",
                    new String[]{old, String.valueOf(mtimeMs), String.valueOf(size), newKind})) {
                if (!c.moveToFirst()) continue;
                oldId = c.getString(0);
            }
            db.beginTransaction();
            try {
                if (!oldId.equals(newDocId)) db.delete("files", "doc_id = ?", new String[]{newDocId});
                ContentValues v = new ContentValues();
                v.put("doc_id", newDocId);
                v.put("path", newPath);
                v.put("name", newName);
                v.put("name_lc", newName.toLowerCase(Locale.ROOT));
                db.update("files", v, "doc_id = ?", new String[]{oldId});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return true;
        }
        return false;
    }

    /**
     * Drop rows that sit exactly at `path` (any spelling) under another document id than
     * `keepDocId` — what is left of a file that a write or an upload's rename just replaced.
     */
    public int removeAtExcept(List<String> spellings, String keepDocId) {
        int n = 0;
        for (String p : spellings) {
            if (p == null || p.isEmpty()) continue;
            n += getWritableDatabase().delete("files", "path = ? AND doc_id != ?", new String[]{p, keepDocId});
        }
        return n;
    }

    /** `(path = ? OR substr(path, 1, length(?)) = ?)` for each spelling; nothing for an empty list or the root "". */
    static void appendUnder(StringBuilder where, List<String> args, List<String> spellings) {
        List<String> real = new ArrayList<>();
        for (String s : spellings) if (s != null && !s.isEmpty()) real.add(s);
        if (real.isEmpty()) return;
        where.append("(");
        for (int i = 0; i < real.size(); i++) {
            String p = real.get(i);
            where.append(i > 0 ? " OR " : "").append("path = ? OR substr(path, 1, length(?)) = ?");
            args.add(p); args.add(p + "/"); args.add(p + "/");
        }
        where.append(")");
    }

    public int count() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM files", null)) {
            return c.moveToFirst() ? c.getInt(0) : 0;
        }
    }

    /** Filtered rows, newest first (largest first when a size floor is asked for). `limit` ≤ 0 = no limit. */
    public List<Row> query(Filter f, int limit) {
        StringBuilder where = new StringBuilder("1=1");
        List<String> args = new ArrayList<>();
        if (f.kind != null) { where.append(" AND kind = ?"); args.add(f.kind); }
        if (f.country != null) { where.append(" AND country = ?"); args.add(f.country); }
        if (f.city != null) { where.append(" AND city = ? COLLATE NOCASE"); args.add(f.city); }
        if (f.dateFrom != null) { where.append(" AND when_ms >= ?"); args.add(String.valueOf(f.dateFrom)); }
        if (f.dateTo != null) { where.append(" AND when_ms < ?"); args.add(String.valueOf(f.dateTo)); }
        if (f.minSize != null) { where.append(" AND size >= ?"); args.add(String.valueOf(f.minSize)); }
        if (f.keywordsInTranscript && !f.keywords.isEmpty()) {
            // A recording matches when ANY keyword was heard: speech recognition
            // drops words, and "budget meeting" should still find the meeting
            // that only had "budget" transcribed. Callers rank by how many hit.
            where.append(" AND transcript IS NOT NULL AND (");
            for (int i = 0; i < f.keywords.size(); i++) {
                where.append(i > 0 ? " OR " : "").append("lower(transcript) LIKE ? ESCAPE '\\'");
                args.add(like(f.keywords.get(i)));
            }
            where.append(")");
        } else {
            for (String kw : f.keywords) {
                where.append(" AND name_lc LIKE ? ESCAPE '\\'");
                args.add(like(kw));
            }
        }
        if (f.withVec) where.append(" AND vec IS NOT NULL");
        if (!f.under.isEmpty()) {
            StringBuilder under = new StringBuilder();
            appendUnder(under, args, f.under);
            if (under.length() > 0) where.append(" AND ").append(under);
        }
        String order = f.minSize != null ? "size DESC, when_ms DESC" : "when_ms DESC, path ASC";
        String sql = "SELECT doc_id, path, name, kind, mime, mtime_ms, size, when_ms, lat, lon, country, city, vec, transcript FROM files WHERE "
                + where + " ORDER BY " + order + (limit > 0 ? " LIMIT " + limit : "");
        List<Row> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery(sql, args.toArray(new String[0]))) {
            while (c.moveToNext()) {
                Row r = new Row();
                r.docId = c.getString(0);
                r.path = c.getString(1);
                r.name = c.getString(2);
                r.kind = c.getString(3);
                r.mime = c.isNull(4) ? null : c.getString(4);
                r.mtimeMs = c.getLong(5);
                r.size = c.getLong(6);
                r.whenMs = c.isNull(7) ? null : c.getLong(7);
                r.lat = c.isNull(8) ? null : c.getDouble(8);
                r.lon = c.isNull(9) ? null : c.getDouble(9);
                r.country = c.isNull(10) ? null : c.getString(10);
                r.city = c.isNull(11) ? null : c.getString(11);
                r.vec = c.isNull(12) ? null : c.getBlob(12);
                r.transcript = c.isNull(13) ? null : c.getString(13);
                out.add(r);
            }
        }
        return out;
    }

    private static String like(String kw) {
        return "%" + kw.toLowerCase(Locale.ROOT).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }

    // ------------------------------------------------------------ vectors

    public static byte[] encodeVec(float[] v) {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(v.length * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        for (float x : v) b.putFloat(x);
        return b.array();
    }

    public static float[] decodeVec(byte[] b) {
        java.nio.FloatBuffer f = java.nio.ByteBuffer.wrap(b).order(java.nio.ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
        float[] v = new float[f.remaining()];
        f.get(v);
        return v;
    }

    // ------------------------------------------------------------ kind

    private static final java.util.regex.Pattern SCREENSHOT_NAME =
            java.util.regex.Pattern.compile("(?i)screen[ _-]?shot|스크린샷|스크린 샷|캡처|캡쳐");

    /** Category from mime + name. Pure so it can be unit-tested; mirrors the corpus generator's rules. */
    public static String kindOf(@Nullable String mime, String name) {
        String m = mime == null ? "" : mime.toLowerCase(Locale.ROOT);
        String ext = name.lastIndexOf('.') >= 0 ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        if (m.startsWith("image/") || in(ext, "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "dng", "raw")) {
            return SCREENSHOT_NAME.matcher(name).find() ? SCREENSHOT : PHOTO;
        }
        if (m.startsWith("video/") || in(ext, "mp4", "mov", "mkv", "avi", "webm", "3gp", "m4v")) return VIDEO;
        if (m.startsWith("audio/") || m.equals("application/ogg") || in(ext, "mp3", "m4a", "wav", "aac", "flac", "ogg", "oga", "opus", "amr", "wma", "3ga")) return AUDIO;
        if (m.equals("application/pdf") || ext.equals("pdf")) return PDF;
        if (in(ext, "xls", "xlsx", "csv", "numbers", "ods") || m.contains("spreadsheet") || m.contains("excel")) return SPREADSHEET;
        if (in(ext, "ppt", "pptx", "key", "odp") || m.contains("presentation") || m.contains("powerpoint")) return PRESENTATION;
        if (in(ext, "zip", "rar", "7z", "tar", "gz", "tgz") || m.contains("zip") || m.contains("compressed")) return ARCHIVE;
        if (in(ext, "doc", "docx", "hwp", "hwpx", "txt", "md", "rtf", "odt", "pages") || m.startsWith("text/") || m.contains("word") || m.contains("hwp")) return DOCUMENT;
        return OTHER;
    }

    private static boolean in(String ext, String... exts) {
        for (String e : exts) if (e.equals(ext)) return true;
        return false;
    }
}
