package ai.ainetwork.aindrive.index;

import android.util.Log;

import ai.ainetwork.aindrive.SafFs;

import java.io.InputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Walks one drive's SAF tree and fills its {@link FileIndex}.
 *
 * Every file gets a row (kind, name, size, when); only photos are opened, and
 * only for their EXIF header. Incremental: a file whose (docId, mtime, size)
 * is already indexed is skipped, so a re-run over an unchanged folder costs
 * one directory query per folder and no file reads. Per-file failures
 * (corrupt EXIF, unreadable provider) are counted and skipped — one bad photo
 * must not stop the other ten thousand.
 */
public final class Indexer {
    private static final String TAG = "AindriveIndexer";

    public interface Progress { void onProgress(int done, int total, String phase); }

    /** Live counters, read by the status JSON while a run is in flight. */
    public volatile boolean running;
    public volatile int done, total, failed;
    public volatile String phase = "idle";
    public volatile long lastRunMs;

    private final SafFs fs;
    private final FileIndex index;
    private final GeoLookup geo;
    private final AtomicBoolean cancel = new AtomicBoolean();

    public Indexer(SafFs fs, FileIndex index, GeoLookup geo) {
        this.fs = fs;
        this.index = index;
        this.geo = geo;
    }

    public void cancel() { cancel.set(true); }

    public void runOnce(Progress progress) {
        if (running) return;
        running = true;
        cancel.set(false);
        done = 0; failed = 0; total = 0;
        try {
            phase = "scanning";
            progress.onProgress(0, 0, phase);
            List<SafFs.Entry> files = fs.walkFiles();
            total = files.size();
            Set<String> live = new HashSet<>();
            phase = "indexing";
            for (SafFs.Entry e : files) {
                if (cancel.get()) { phase = "cancelled"; return; }
                live.add(e.docId);
                if (index.needsIndex(e.docId, e.mtimeMs, e.size)) {
                    try { indexOne(e); }
                    catch (Exception ex) { failed++; Log.w(TAG, "skip " + e.name + ": " + ex.getMessage()); }
                }
                done++;
                if (done % 50 == 0) progress.onProgress(done, total, phase);
            }
            int removed = index.deleteMissing(live);
            phase = "done";
            lastRunMs = System.currentTimeMillis();
            Log.i(TAG, "indexed " + total + " files (" + failed + " failed, " + removed + " removed)");
            progress.onProgress(done, total, phase);
        } catch (Exception ex) {
            phase = "error: " + ex.getMessage();
            Log.w(TAG, "index run failed", ex);
            progress.onProgress(done, total, phase);
        } finally {
            running = false;
        }
    }

    private void indexOne(SafFs.Entry e) throws Exception {
        FileIndex.Row r = new FileIndex.Row();
        r.docId = e.docId;
        r.path = e.path;
        r.name = e.name;
        r.mime = e.mime;
        r.kind = FileIndex.kindOf(e.mime, e.name);
        r.mtimeMs = e.mtimeMs;
        r.size = e.size;
        r.whenMs = e.mtimeMs > 0 ? e.mtimeMs : null;
        if (FileIndex.PHOTO.equals(r.kind) || FileIndex.SCREENSHOT.equals(r.kind)) {
            try (InputStream in = fs.open(e.docId)) {
                ExifMeta m = ExifMeta.read(in);
                if (m.takenAtMs != null) r.whenMs = m.takenAtMs;
                r.lat = m.lat;
                r.lon = m.lon;
                if (m.lat != null && m.lon != null) {
                    GeoLookup.City c = geo.nearest(m.lat, m.lon);
                    if (c != null) { r.country = c.country; r.city = c.name; }
                }
            }
        }
        index.upsert(r);
        Log.d(TAG, "indexed " + e.name + " kind=" + r.kind + " when=" + r.whenMs + " gps=" + r.lat + "," + r.lon + " → " + r.city + "/" + r.country);
    }
}
