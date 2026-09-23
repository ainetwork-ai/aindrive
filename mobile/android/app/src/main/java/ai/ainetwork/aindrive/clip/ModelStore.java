package ai.ainetwork.aindrive.clip;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * On-device model files: which ones a feature needs (a manifest in assets),
 * whether they are present, and a verified download when they are not.
 *
 * Models are NOT in the APK (66 MB for CLIP, more for speech) — they land in
 * filesDir/models/<manifest>/ on first use. Every file is checked against the
 * manifest's SHA-256 before it is used, and a partial download never replaces
 * a good file: it is written to a temp name and renamed on success.
 */
public final class ModelStore {
    private static final String TAG = "AindriveModels";

    public interface Progress { void onProgress(String fileId, long done, long total); }

    public static final class Entry {
        public final String id, name, url, sha256;
        public final long bytes;
        Entry(JSONObject j) {
            id = j.optString("id"); name = j.optString("name"); url = j.optString("url");
            sha256 = j.optString("sha256"); bytes = j.optLong("bytes");
        }
    }

    private final File dir;
    private final List<Entry> entries = new ArrayList<>();
    public final JSONObject manifest;

    /** `manifestAsset` like "clip/models.json"; files live under filesDir/models/clip/. */
    public ModelStore(Context ctx, String manifestAsset) throws IOException {
        try (InputStream in = ctx.getAssets().open(manifestAsset)) {
            byte[] b = in.readAllBytes();
            manifest = new JSONObject(new String(b, "UTF-8"));
        } catch (org.json.JSONException e) {
            throw new IOException("bad manifest " + manifestAsset + ": " + e.getMessage());
        }
        JSONArray files = manifest.optJSONArray("files");
        for (int i = 0; files != null && i < files.length(); i++) entries.add(new Entry(files.optJSONObject(i)));
        String group = manifestAsset.contains("/") ? manifestAsset.substring(0, manifestAsset.indexOf('/')) : "models";
        dir = new File(new File(ctx.getFilesDir(), "models"), group);
        if (!dir.exists()) dir.mkdirs();
    }

    public File file(String id) {
        for (Entry e : entries) if (e.id.equals(id)) return new File(dir, e.name);
        throw new IllegalArgumentException("no model " + id);
    }

    public long totalBytes() { long t = 0; for (Entry e : entries) t += e.bytes; return t; }

    /** True when every file exists with the right size (hash is checked at download time). */
    public boolean ready() {
        for (Entry e : entries) { File f = new File(dir, e.name); if (!f.exists() || f.length() != e.bytes) return false; }
        return true;
    }

    /** Download whatever is missing. Blocking; call from a worker. */
    public void ensure(@Nullable Progress progress) throws IOException {
        OkHttpClient http = new OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build();
        for (Entry e : entries) {
            File f = new File(dir, e.name);
            if (f.exists() && f.length() == e.bytes) continue;
            File tmp = new File(dir, e.name + ".part");
            Log.i(TAG, "downloading " + e.name + " (" + e.bytes / 1_000_000 + " MB)");
            Request req = new Request.Builder().url(e.url).build();
            try (Response res = http.newCall(req).execute()) {
                if (!res.isSuccessful() || res.body() == null) throw new IOException("download failed: HTTP " + res.code() + " for " + e.name);
                MessageDigest md;
                try { md = MessageDigest.getInstance("SHA-256"); } catch (Exception ex) { throw new IOException(ex); }
                try (InputStream in = res.body().byteStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[256 * 1024];
                    long done = 0; int n; long lastReport = 0;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n); md.update(buf, 0, n); done += n;
                        if (progress != null && done - lastReport > 1_000_000) { lastReport = done; progress.onProgress(e.id, done, e.bytes); }
                    }
                }
                String hex = hex(md.digest());
                if (!e.sha256.isEmpty() && !hex.equalsIgnoreCase(e.sha256)) {
                    tmp.delete();
                    throw new IOException("checksum mismatch for " + e.name);
                }
                if (!tmp.renameTo(f)) throw new IOException("could not move " + e.name + " into place");
                if (progress != null) progress.onProgress(e.id, e.bytes, e.bytes);
            }
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
