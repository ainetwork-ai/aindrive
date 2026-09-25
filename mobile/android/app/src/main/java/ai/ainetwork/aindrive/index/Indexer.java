package ai.ainetwork.aindrive.index;

import android.util.Log;

import ai.ainetwork.aindrive.SafFs;
import ai.ainetwork.aindrive.clip.ClipEmbedder;
import ai.ainetwork.aindrive.speech.SpeechRecognizer;

import androidx.annotation.Nullable;

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

    /** Which recognisers are available for this run; null = that kind of recognition is skipped. */
    public interface Recognisers {
        @Nullable ClipEmbedder clip();
        @Nullable SpeechRecognizer speech();
        /** How much of each recording to hear; a call archive of thousands of hours needs a cap. */
        default int speechSeconds() { return SpeechRecognizer.MAX_SECONDS; }
        /** A call-recordings folder: hear it person by person rather than strictly by date. */
        default boolean callArchive() { return false; }
    }

    public volatile int recognised, toRecognise;

    private final SafFs fs;
    private final FileIndex index;
    private final GeoLookup geo;
    private final Recognisers recognisers;
    private final AtomicBoolean cancel = new AtomicBoolean();

    public Indexer(SafFs fs, FileIndex index, GeoLookup geo, Recognisers recognisers) {
        this.fs = fs;
        this.index = index;
        this.geo = geo;
        this.recognisers = recognisers;
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
            Log.i(TAG, "indexed " + total + " files (" + failed + " failed, " + removed + " removed)");
            recognise(files, progress);
            phase = "done";
            lastRunMs = System.currentTimeMillis();
            progress.onProgress(done, total, phase);
        } catch (Exception ex) {
            phase = "error: " + ex.getMessage();
            Log.w(TAG, "index run failed", ex);
            progress.onProgress(done, total, phase);
        } finally {
            running = false;
        }
    }

    /**
     * Second pass: what is IN the file. Photos get a CLIP vector, audio and
     * video a transcript. Runs after the metadata pass so a fast index is
     * usable while the slow part (≈50 ms per photo, ≈1/13 of the audio's
     * length per recording) catches up. Files already recognised are skipped,
     * so a model that arrives later only costs what it adds.
     */
    private void recognise(List<SafFs.Entry> files, Progress progress) {
        ClipEmbedder clip = recognisers.clip();
        SpeechRecognizer speech = recognisers.speech();
        if (clip == null && speech == null) return;
        phase = "recognising";
        recognised = 0; toRecognise = 0;
        List<SafFs.Entry> todo = new java.util.ArrayList<>();
        for (SafFs.Entry e : files) {
            String kind = FileIndex.kindOf(e.mime, e.name);
            boolean photo = clip != null && (FileIndex.PHOTO.equals(kind) || FileIndex.SCREENSHOT.equals(kind));
            boolean av = speech != null && (FileIndex.AUDIO.equals(kind) || FileIndex.VIDEO.equals(kind));
            if ((photo || av) && index.needsRecognition(e.docId, photo, av)) todo.add(e);
        }
        // Newest first: the calls people ask about are the recent ones, and a long archive is heard over days.
        todo.sort((a, b) -> Long.compare(b.mtimeMs, a.mtimeMs));
        if (recognisers.callArchive()) {
            // Round-robin by person (each one's newest call, then each one's second…), contacts before bare
            // numbers — so after an hour every contact has something heard, not just whoever called last week.
            java.util.Map<String, Integer> seen = new java.util.HashMap<>();
            java.util.Map<SafFs.Entry, Integer> round = new java.util.HashMap<>();
            for (SafFs.Entry e : todo) {
                String who = ai.ainetwork.aindrive.agent.CallReport.personOf(e.name);
                String key = who == null ? "?" + e.name : who;
                int n = seen.merge(key, 1, Integer::sum);
                round.put(e, (n - 1) * 2 + (who != null && ai.ainetwork.aindrive.agent.CallReport.isContact(who) ? 0 : 1));
            }
            todo.sort((a, b) -> round.get(a) != round.get(b).intValue() ? Integer.compare(round.get(a), round.get(b)) : Long.compare(b.mtimeMs, a.mtimeMs));
        }
        toRecognise = todo.size();
        progress.onProgress(0, toRecognise, phase);
        for (SafFs.Entry e : todo) {
            if (cancel.get()) { phase = "cancelled"; return; }
            String kind = FileIndex.kindOf(e.mime, e.name);
            try {
                if (FileIndex.PHOTO.equals(kind) || FileIndex.SCREENSHOT.equals(kind)) {
                    try (InputStream in = fs.open(e.docId)) {
                        float[] v = clip.embedImage(in);
                        if (v != null) index.setRecognition(e.docId, FileIndex.encodeVec(v), null);
                    }
                } else {
                    try (android.os.ParcelFileDescriptor pfd = fs.openFd(e.docId)) {
                        SpeechRecognizer.Transcript t = speech.transcribe(pfd.getFileDescriptor(), recognisers.speechSeconds());
                        // An empty transcript is still a result: the file was heard and had no speech.
                        index.setRecognition(e.docId, null, t == null ? "" : t.text);
                        Log.d(TAG, "transcribed " + e.name + " (" + (t == null ? 0 : Math.round(t.durationSec)) + "s): " + (t == null ? "" : t.text.substring(0, Math.min(120, t.text.length()))));
                    }
                }
            } catch (Exception ex) {
                failed++;
                Log.w(TAG, "recognise " + e.name + ": " + ex.getMessage());
            }
            recognised++;
            if (recognised % 10 == 0) progress.onProgress(recognised, toRecognise, phase);
        }
        Log.i(TAG, "recognised " + recognised + " files (" + failed + " failed)");
        progress.onProgress(recognised, toRecognise, phase);
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
