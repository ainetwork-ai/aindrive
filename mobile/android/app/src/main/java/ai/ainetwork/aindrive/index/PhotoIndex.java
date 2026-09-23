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
import java.util.Set;

/**
 * Per-drive photo index: what the on-device agent searches instead of walking
 * the folder at question time.
 *
 * Lives in app-private storage (filesDir/index/<driveId>.db), never in the
 * user's folder — the same rule as the yjs snapshots: the phone's Documents
 * directory must not grow an .aindrive/ control directory the user did not
 * ask for. Rows are keyed by the SAF document id, which survives renames, so
 * a moved photo is not re-read.
 */
public final class PhotoIndex extends SQLiteOpenHelper {
    private static final int SCHEMA = 1;

    public static final class Row {
        public String docId, path, country, city;
        public long mtimeMs, size;
        public @Nullable Long takenAt;
        public @Nullable Double lat, lon;
    }

    /** Hard filters; null means "any". Ranking is the caller's job. */
    public static final class Filter {
        public @Nullable String country, city;
        public @Nullable Long dateFrom, dateTo;
    }

    public PhotoIndex(Context ctx, String driveId) {
        super(ctx, dbPath(ctx, driveId), null, SCHEMA);
    }

    private static String dbPath(Context ctx, String driveId) {
        File dir = new File(ctx.getFilesDir(), "index");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, driveId.replaceAll("[^A-Za-z0-9_-]", "_") + ".db").getAbsolutePath();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE photos ("
                + "doc_id TEXT PRIMARY KEY, path TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,"
                + "taken_at INTEGER, lat REAL, lon REAL, country TEXT, city TEXT, vec BLOB)");
        db.execSQL("CREATE INDEX photos_taken ON photos(taken_at)");
        db.execSQL("CREATE INDEX photos_country ON photos(country)");
        db.execSQL("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
        db.execSQL("DROP TABLE IF EXISTS photos");
        db.execSQL("DROP TABLE IF EXISTS meta");
        onCreate(db);
    }

    /** True when the file is unknown or changed since it was indexed. */
    public boolean needsIndex(String docId, long mtimeMs) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT mtime_ms FROM photos WHERE doc_id = ?", new String[]{docId})) {
            return !c.moveToFirst() || c.getLong(0) != mtimeMs;
        }
    }

    public void upsert(Row r) {
        ContentValues v = new ContentValues();
        v.put("doc_id", r.docId);
        v.put("path", r.path);
        v.put("mtime_ms", r.mtimeMs);
        v.put("size", r.size);
        if (r.takenAt != null) v.put("taken_at", r.takenAt); else v.putNull("taken_at");
        if (r.lat != null) v.put("lat", r.lat); else v.putNull("lat");
        if (r.lon != null) v.put("lon", r.lon); else v.putNull("lon");
        v.put("country", r.country);
        v.put("city", r.city);
        getWritableDatabase().insertWithOnConflict("photos", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Drop rows whose document no longer exists in the tree. */
    public int deleteMissing(Set<String> liveDocIds) {
        SQLiteDatabase db = getWritableDatabase();
        List<String> dead = new ArrayList<>();
        try (Cursor c = db.rawQuery("SELECT doc_id FROM photos", null)) {
            while (c.moveToNext()) if (!liveDocIds.contains(c.getString(0))) dead.add(c.getString(0));
        }
        db.beginTransaction();
        try {
            for (String id : dead) db.delete("photos", "doc_id = ?", new String[]{id});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return dead.size();
    }

    public int count() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM photos", null)) {
            return c.moveToFirst() ? c.getInt(0) : 0;
        }
    }

    /** Filtered rows, newest first. `limit` ≤ 0 means no limit. */
    public List<Row> query(Filter f, int limit) {
        StringBuilder where = new StringBuilder("1=1");
        List<String> args = new ArrayList<>();
        if (f.country != null) { where.append(" AND country = ?"); args.add(f.country); }
        if (f.city != null) { where.append(" AND city = ? COLLATE NOCASE"); args.add(f.city); }
        if (f.dateFrom != null) { where.append(" AND taken_at >= ?"); args.add(String.valueOf(f.dateFrom)); }
        if (f.dateTo != null) { where.append(" AND taken_at < ?"); args.add(String.valueOf(f.dateTo)); }
        String sql = "SELECT doc_id, path, mtime_ms, size, taken_at, lat, lon, country, city FROM photos WHERE "
                + where + " ORDER BY taken_at DESC, path ASC" + (limit > 0 ? " LIMIT " + limit : "");
        List<Row> out = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery(sql, args.toArray(new String[0]))) {
            while (c.moveToNext()) {
                Row r = new Row();
                r.docId = c.getString(0);
                r.path = c.getString(1);
                r.mtimeMs = c.getLong(2);
                r.size = c.getLong(3);
                r.takenAt = c.isNull(4) ? null : c.getLong(4);
                r.lat = c.isNull(5) ? null : c.getDouble(5);
                r.lon = c.isNull(6) ? null : c.getDouble(6);
                r.country = c.isNull(7) ? null : c.getString(7);
                r.city = c.isNull(8) ? null : c.getString(8);
                out.add(r);
            }
        }
        return out;
    }
}
