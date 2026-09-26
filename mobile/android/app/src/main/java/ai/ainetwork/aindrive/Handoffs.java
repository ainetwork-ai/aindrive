package ai.ainetwork.aindrive;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

/**
 * Files the owner picked to hand to an outside agent (web/lib/handoff.ts): a random key per file
 * → which folder and path it is, until when. `handoff-read` serves ONLY keys registered here, so a
 * handoff link can never reach any other file — not even a neighbour in the same folder, and not a
 * folder that isn't shared (DCIM sources work: the bytes go out through any connected drive's socket).
 * Persisted, so links keep working across a service restart until they expire.
 */
final class Handoffs {
    private Handoffs() { }

    private static final String PREFS = "aindrive.handoffs";

    static final class Entry {
        final String folderUri, path; final long expiresAt;
        Entry(String folderUri, String path, long expiresAt) { this.folderUri = folderUri; this.path = path; this.expiresAt = expiresAt; }
    }

    static synchronized void register(Context ctx, String key, String folderUri, String path, long expiresAt) {
        try {
            prefs(ctx).edit().putString(key, new JSONObject().put("u", folderUri).put("p", path).put("e", expiresAt).toString()).apply();
        } catch (org.json.JSONException ignored) { }
        prune(ctx);
    }

    static synchronized void forget(Context ctx, String key) { prefs(ctx).edit().remove(key).apply(); }

    static synchronized @Nullable Entry get(Context ctx, String key) {
        String v = prefs(ctx).getString(key, null);
        if (v == null) return null;
        try {
            JSONObject o = new JSONObject(v);
            Entry e = new Entry(o.getString("u"), o.getString("p"), o.getLong("e"));
            if (e.expiresAt <= System.currentTimeMillis()) { forget(ctx, key); return null; }
            return e;
        } catch (org.json.JSONException ex) { return null; }
    }

    /** Bytes [offset, offset+length) of a registered file, with its size. */
    static JSONObject read(Context ctx, String key, long offset, int length) throws Exception {
        Entry e = get(ctx, key);
        if (e == null) throw new IOException("no such handoff (expired or never registered)");
        SafFs fs = new SafFs(ctx, Uri.parse(e.folderUri));
        SafFs.Entry st = fs.stat(e.path);
        if (st == null || st.isDir) throw new java.io.FileNotFoundException("file is gone");
        byte[] data = fs.readChunk(e.path, offset, length);
        return new JSONObject()
                .put("data", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP))
                .put("eof", offset + data.length >= st.size)
                .put("size", st.size);
    }

    private static void prune(Context ctx) {
        SharedPreferences p = prefs(ctx);
        SharedPreferences.Editor ed = p.edit();
        long now = System.currentTimeMillis();
        for (Map.Entry<String, ?> kv : p.getAll().entrySet()) {
            try { if (new JSONObject(String.valueOf(kv.getValue())).getLong("e") <= now) ed.remove(kv.getKey()); }
            catch (org.json.JSONException ex) { ed.remove(kv.getKey()); }
        }
        ed.apply();
    }

    private static SharedPreferences prefs(Context ctx) { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
}
