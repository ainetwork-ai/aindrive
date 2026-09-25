package ai.ainetwork.aindrive;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import ai.ainetwork.aindrive.agent.AskRunner;
import ai.ainetwork.aindrive.clip.ClipEmbedder;
import ai.ainetwork.aindrive.clip.ModelStore;
import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.speech.SpeechRecognizer;
import ai.ainetwork.aindrive.index.Indexer;
import ai.ainetwork.aindrive.index.FileIndex;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The aindrive agent, as an Android foreground service.
 *
 * Same job as `aindrive` on a laptop (cli/src/agent.js): dial OUT to the
 * server over WSS, prove identity with the per-drive agent token, verify the
 * HMAC on every inbound frame, run the RPC against the user's folder, sign the
 * response. No inbound port is ever opened on the phone.
 *
 * One service hosts MANY drives: each picked folder is its own drive with its
 * own credentials and its own socket (a {@link Conn}), exactly as running one
 * desktop agent per directory would be. Drives are keyed by driveId; START
 * adds or replaces one, STOP removes one (or all, without a driveId), and the
 * service exits once no drive is left.
 *
 * It has to be a foreground service, not a WebView timer: Android suspends
 * WebViews and background threads within seconds of leaving the app, which
 * would take the drive offline every time the user switches apps. The
 * persistent notification is the honest price of "my phone is serving files
 * right now", and doubles as the off switch.
 */
public class AgentService extends Service {
    private static final String TAG = "AindriveAgent";
    private static final String CHANNEL_ID = "aindrive_agent";
    private static final int NOTIFICATION_ID = 4201;
    private static final int PROTOCOL_VERSION = 1;

    public static final String ACTION_START = "ai.ainetwork.aindrive.START";
    public static final String ACTION_STOP = "ai.ainetwork.aindrive.STOP";
    /** Dev/QA hooks: `adb shell am startservice -a …ASK --es query "…"` logs the answer; REINDEX rebuilds. */
    public static final String ACTION_ASK = "ai.ainetwork.aindrive.ASK";
    public static final String ACTION_REINDEX = "ai.ainetwork.aindrive.REINDEX";
    /** Download the recognition models (photos + speech), then re-run recognition on every drive. */
    public static final String ACTION_ENSURE_MODELS = "ai.ainetwork.aindrive.ENSURE_MODELS";
    /** Debug: transcribe one file with a given speech manifest and log it — for comparing engines on the same recording. */
    public static final String ACTION_TRANSCRIBE = "ai.ainetwork.aindrive.TRANSCRIBE";
    /** Debug: summarise a text file with a given LLM manifest and log it — for comparing models on the same transcript. */
    public static final String ACTION_SUMMARIZE = "ai.ainetwork.aindrive.SUMMARIZE";
    public static final String EXTRA_DRIVE_ID = "driveId";

    /** Backoff schedule copied from cli/src/agent.js so reconnects feel the same. */
    private static final long[] BACKOFF_MS = {1000, 2000, 4000, 8000, 15000};

    /** Observed by the plugin so the UI can render status without polling the socket. */
    interface StatusListener { void onStatus(JSONObject status); }
    private static volatile StatusListener statusListener;
    static void setStatusListener(@Nullable StatusListener l) { statusListener = l; }

    private static volatile AgentService instance;
    static @Nullable AgentService get() { return instance; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService rpcPool = Executors.newFixedThreadPool(4);
    /** One indexing run at a time across all drives — it is I/O bound on the same storage anyway. */
    private final ExecutorService indexPool = Executors.newSingleThreadExecutor();
    private volatile GeoLookup geo;
    /** driveId → live connection. Insertion order = the order the user started them. */
    private final Map<String, Conn> conns = new LinkedHashMap<>();

    private OkHttpClient http;
    private boolean stopping;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        http = new OkHttpClient.Builder()
                .pingInterval(30, TimeUnit.SECONDS)   // keep NAT/proxies from dropping an idle drive
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // Restarted by the system after a kill: we have no credentials in
            // hand, so all we can do is exit cleanly; the app re-adds drives on
            // its next launch.
            shutdownAll();
            return START_NOT_STICKY;
        }
        if (ACTION_REINDEX.equals(intent.getAction())) {
            reindex(intent.getStringExtra(EXTRA_DRIVE_ID));
            return START_STICKY;
        }
        if (ACTION_ENSURE_MODELS.equals(intent.getAction())) {
            ensureModels();
            return START_STICKY;
        }
        if (ACTION_SUMMARIZE.equals(intent.getAction())) {
            String manifest = intent.getStringExtra("manifest"), file = intent.getStringExtra("file"), person = intent.getStringExtra("person");
            boolean ko = intent.getBooleanExtra("korean", true);
            rpcPool.execute(() -> {
                long t0 = System.currentTimeMillis();
                try {
                    String text = new String(java.nio.file.Files.readAllBytes(new java.io.File(file).toPath()), java.nio.charset.StandardCharsets.UTF_8);
                    ModelStore s = new ModelStore(this, manifest);
                    if (!s.ready()) { Log.w(TAG, "summarize: models for " + manifest + " not downloaded"); return; }
                    try (ai.ainetwork.aindrive.llm.Summarizer sum = new ai.ainetwork.aindrive.llm.Summarizer(this, s)) {
                        long t1 = System.currentTimeMillis();
                        String out = sum.callsWith(person == null ? "X" : person, java.util.Arrays.asList(text.split("\n===\n")), ko);
                        Log.i(TAG, "summarize[" + manifest + "] load=" + (t1 - t0) + "ms run=" + (System.currentTimeMillis() - t1) + "ms → " + out);
                    }
                } catch (Exception e) { Log.w(TAG, "summarize failed", e); }
            });
            return START_STICKY;
        }
        if (ACTION_TRANSCRIBE.equals(intent.getAction())) {
            String manifest = intent.getStringExtra("manifest"), file = intent.getStringExtra("file");
            int secs = intent.getIntExtra("seconds", 180);
            rpcPool.execute(() -> {
                long t0 = System.currentTimeMillis();
                try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                    ModelStore s = new ModelStore(this, manifest);
                    if (!s.ready()) { Log.w(TAG, "transcribe: models for " + manifest + " not downloaded"); return; }
                    try (SpeechRecognizer r = new SpeechRecognizer(this, s)) {
                        long t1 = System.currentTimeMillis();
                        SpeechRecognizer.Transcript t = r.transcribe(in.getFD(), secs);
                        Log.i(TAG, "transcribe[" + manifest + "] load=" + (t1 - t0) + "ms run=" + (System.currentTimeMillis() - t1) + "ms audio=" + (t == null ? 0 : Math.round(t.durationSec)) + "s → " + (t == null ? "" : t.text));
                    }
                } catch (Exception e) { Log.w(TAG, "transcribe failed", e); }
            });
            return START_STICKY;
        }
        if (ACTION_ASK.equals(intent.getAction())) {
            String q = intent.getStringExtra("query");
            String ctx = intent.getStringExtra("context");
            rpcPool.execute(() -> {
                try { Log.i(TAG, "ask(" + q + ") → " + ask(q == null ? "" : q, ctx == null ? null : new JSONObject(ctx)).toString(2)); }
                catch (Exception e) { Log.w(TAG, "ask failed", e); }
            });
            return START_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            String id = intent.getStringExtra(EXTRA_DRIVE_ID);
            if (id == null) shutdownAll(); else stopDrive(id);
            return START_NOT_STICKY;
        }

        String driveId = intent.getStringExtra("driveId");
        // Called on every START so Android 12+ never sees a started-but-not-
        // foregrounded service; re-calling with the same id is a no-op update.
        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"));
        stopping = false;

        Conn conn = new Conn(
                intent.getStringExtra("serverUrl"),
                driveId,
                intent.getStringExtra("agentToken"),
                intent.getStringExtra("driveSecret"),
                intent.getStringExtra("folderLabel"));
        conn.source = intent.getBooleanExtra("source", false);
        try {
            Uri tree = Uri.parse(intent.getStringExtra("folderUri"));
            conn.fs = new SafFs(this, tree, intent.getStringArrayListExtra("excludeUris"));
            conn.index = new FileIndex(this, driveId);
            conn.index.adoptSpeechEngine(speechEngineName());
            try { conn.index.adoptImageModel(clipStore().manifest.optString("model", "")); } catch (Exception ignored) { }
            conn.rpc = new RpcHandler(this, conn.fs, driveId, conn::askRunner);
        } catch (Exception e) {
            conn.lastError = "Could not open folder: " + e.getMessage();
            synchronized (conns) { conns.put(driveId, conn); }
            notifyStatus();
            return START_STICKY;
        }

        Conn previous;
        synchronized (conns) { previous = conns.put(driveId, conn); }
        if (previous != null) previous.close();
        if (!conn.source) conn.connect();
        if (intent.getBooleanExtra("indexOnStart", false)) reindex(driveId);
        // START_STICKY: if Android reclaims us under memory pressure, come back
        // and reconnect rather than leaving the drive silently offline.
        return START_STICKY;
    }

    // ------------------------------------------------------------ one drive

    /** Everything that belongs to ONE drive: credentials, folder, socket, counters. */
    private final class Conn {
        final String serverUrl, driveId, agentToken, driveSecret, folderLabel;
        final AtomicInteger rpcCount = new AtomicInteger();
        /**
         * An agent SOURCE: a folder the agent may read for its tasks (call
         * recordings, the camera roll) that is NOT served to the web. No
         * socket; anything the agent produces from it is written into a
         * shared drive ({@link #outputConn()}).
         */
        boolean source;
        SafFs fs;
        RpcHandler rpc;
        FileIndex index;
        Indexer indexer;
        AskRunner ask;
        WebSocket ws;
        volatile boolean connected;
        volatile boolean closed;
        int attempt;
        String lastError;

        Conn(String serverUrl, String driveId, String agentToken, String driveSecret, String folderLabel) {
            this.serverUrl = serverUrl;
            this.driveId = driveId;
            this.agentToken = agentToken;
            this.driveSecret = driveSecret;
            this.folderLabel = folderLabel;
        }

        void connect() {
            if (closed || stopping) return;
            String wsUrl = toWsUrl(serverUrl, driveId);
            Request req = new Request.Builder()
                    .url(wsUrl)
                    .addHeader("authorization", "Bearer " + agentToken)
                    .build();
            ws = http.newWebSocket(req, new WebSocketListener() {
                @Override public void onOpen(WebSocket socket, Response response) {
                    connected = true;
                    attempt = 0;
                    lastError = null;
                    Log.i(TAG, "connected to " + wsUrl);
                    try {
                        socket.send(new JSONObject()
                                .put("type", "agent-hello")
                                .put("hostname", Build.MODEL != null ? Build.MODEL : "android")
                                .toString());
                    } catch (Exception ignored) { }
                    notifyStatus();
                }

                @Override public void onMessage(WebSocket socket, String text) {
                    rpcPool.execute(() -> onFrame(socket, text));
                }

                @Override public void onClosed(WebSocket socket, int code, String reason) {
                    connected = false;
                    scheduleReconnect("Connection closed (" + code + ")");
                }

                @Override public void onFailure(WebSocket socket, Throwable t, @Nullable Response response) {
                    connected = false;
                    scheduleReconnect(t.getMessage() != null ? t.getMessage() : "Connection failed");
                }
            });
        }

        void scheduleReconnect(String why) {
            if (closed || stopping) return;
            lastError = why;
            notifyStatus();
            long wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
            attempt++;
            main.postDelayed(this::connect, wait);
        }

        synchronized AskRunner askRunner() {
            if (ask == null) ask = new AskRunner(index, geo(), AgentService.this::clipOrNull, fileOps(), AgentService.this::callLog, AgentService.this::speechOrNull,
                    AgentService.this::summarizerOrNull, AgentService.this::releaseSummarizer, () -> anyIndexerRunning())
                    .withCallIndexes(AgentService.this::callIndexes);
            return ask;
        }

        /** Where the agent writes: this drive, or for a source the first shared drive that is on (null → tasks are reported, not done). */
        private AskRunner.FileOps fileOps() {
            if (!source) return new AskRunner.FileOps() {
                @Override public void copy(String docId, String destRel) throws Exception { fs.copy(docId, destRel); }
                @Override public void move(String fromRel, String destRel) throws Exception { fs.rename(fromRel, destRel); }
                @Override public String uriOf(String rel) throws Exception { return fs.uriFor(rel).toString(); }
                @Override public void write(String rel, byte[] data) throws Exception { fs.mkdirs(SafFs.parentOf(rel)); fs.importFile(SafFs.parentOf(rel), SafFs.baseName(rel), new java.io.ByteArrayInputStream(data)); }
                @Override public android.os.ParcelFileDescriptor openFd(String docId) throws Exception { return fs.openFd(docId); }
            };
            // The output drive is looked up per call: the user may switch a share on after asking once.
            return new AskRunner.FileOps() {
                private SafFs out() throws java.io.IOException {
                    Conn out = outputConn();
                    if (out == null) throw new java.io.IOException("no shared drive is on");
                    return out.fs;
                }
                @Override public boolean canWrite() { return outputConn() != null; }
                @Override public void copy(String docId, String destRel) throws Exception {
                    SafFs o = out();
                    try (java.io.InputStream in = fs.open(docId)) { o.mkdirs(SafFs.parentOf(destRel)); o.importFile(SafFs.parentOf(destRel), SafFs.baseName(destRel), in); }
                }
                @Override public void move(String fromRel, String destRel) throws Exception { throw new java.io.IOException("a source folder is read-only"); }
                @Override public String uriOf(String rel) throws Exception { return out().uriFor(rel).toString(); }
                @Override public void write(String rel, byte[] data) throws Exception { SafFs o = out(); o.mkdirs(SafFs.parentOf(rel)); o.importFile(SafFs.parentOf(rel), SafFs.baseName(rel), new java.io.ByteArrayInputStream(data)); }
                @Override public android.os.ParcelFileDescriptor openFd(String docId) throws Exception { return fs.openFd(docId); }
            };
        }

        synchronized Indexer indexer() {
            if (indexer == null) indexer = new Indexer(fs, index, geo(), new Indexer.Recognisers() {
                @Override public ClipEmbedder clip() { return clipOrNull(); }
                @Override public SpeechRecognizer speech() { return speechOrNull(); }
                // A call archive is thousands of hours: hear the first minutes of each call, newest first, in the background.
                @Override public boolean callArchive() { return isCallSource(driveId); }
                @Override public java.util.Map<String, Integer> callCounts() { return recentCallCounts(); }
                @Override public int speechSeconds() { return isCallSource(driveId) ? ai.ainetwork.aindrive.agent.CallReport.SECONDS_PER_RECORDING : SpeechRecognizer.MAX_SECONDS; }
            });
            return indexer;
        }

        void close() {
            closed = true;
            connected = false;
            if (indexer != null) indexer.cancel();
            if (index != null) { try { index.close(); } catch (Exception ignored) { } }
            if (ws != null) {
                try { ws.close(1001, "agent shutting down"); } catch (Exception ignored) { }
                ws = null;
            }
        }

        void onFrame(WebSocket socket, String text) {
            if (closed) return;
            JSONObject frame;
            try { frame = new JSONObject(text); }
            catch (Exception e) { Log.w(TAG, "frame parse failed (" + text.length() + " chars)", e); return; }

            String type = frame.optString("type", "");
            JSONObject p0 = frame.optJSONObject("params");
            Log.d(TAG, "[" + driveId + "] frame type=" + type + " method=" + (p0 == null ? "-" : p0.optString("method", "?"))
                    + " chars=" + text.length());
            if ("hello".equals(type)) return;
            if (type.startsWith("sync-")) return; // multi-device gossip: desktop-only for now
            if (!"request".equals(type) || frame.optString("reqId", "").isEmpty()) { Log.w(TAG, "dropped non-request frame"); return; }
            if (frame.optInt("v", -1) != PROTOCOL_VERSION) { Log.w(TAG, "dropped frame: protocol v=" + frame.optInt("v", -1)); return; }

            String sig = frame.optString("sig", null);
            JSONObject signed = copyWithout(frame, "sig", "type");
            if (!Sig.verify(driveSecret, signed, sig)) {
                Log.w(TAG, "dropped forged request");
                return;
            }

            String reqId = frame.optString("reqId");
            JSONObject response = new JSONObject();
            try {
                JSONObject params = frame.optJSONObject("params");
                if (params == null) throw new IllegalArgumentException("missing params");
                JSONObject result = rpc.handle(params);
                response.put("reqId", reqId).put("ok", true).put("result", result);
                rpcCount.incrementAndGet();
            } catch (Exception e) {
                Log.w(TAG, "rpc " + (p0 == null ? "?" : p0.optString("method", "?")) + " failed", e);
                try {
                    response.put("reqId", reqId).put("ok", false).put("error", sanitize(e.getMessage()));
                } catch (Exception ignored) { return; }
            }

            try {
                // Sign the payload WITHOUT `type`, then add `type` — exactly what the
                // desktop agent does, and what the server strips before verifying.
                String responseSig = Sig.sign(driveSecret, response);
                response.put("type", "response").put("sig", responseSig);
                socket.send(response.toString());
            } catch (Exception e) {
                Log.e(TAG, "send failed", e);
            }
            notifyStatus();
        }

        JSONObject statusJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("driveId", driveId);
                o.put("source", source);
                o.put("folderLabel", folderLabel == null ? JSONObject.NULL : folderLabel);
                o.put("running", !closed && !stopping);
                o.put("connected", connected);
                o.put("rpcCount", rpcCount.get());
                o.put("lastError", lastError == null ? JSONObject.NULL : lastError);
                JSONObject ix = new JSONObject();
                Indexer in = indexer;
                ix.put("indexed", index == null ? 0 : index.count());
                ix.put("running", in != null && in.running);
                ix.put("done", in == null ? 0 : in.done);
                ix.put("total", in == null ? 0 : in.total);
                ix.put("failed", in == null ? 0 : in.failed);
                ix.put("phase", in == null ? "idle" : in.phase);
                ix.put("lastRunMs", in == null ? 0 : in.lastRunMs);
                ix.put("recognised", in == null ? 0 : in.recognised);
                ix.put("toRecognise", in == null ? 0 : in.toRecognise);
                ix.put("recognisedTotal", index == null ? 0 : index.countRecognised());
                o.put("index", ix);
            } catch (Exception ignored) { }
            return o;
        }
    }

    // ------------------------------------------------------------ recognition models

    /** Which speech model the indexer and the call report use; the others stay selectable for the TRANSCRIBE benchmark hook. */
    static final String SPEECH_MANIFEST = "speech/qwen3-asr.json";
    /** The summariser's model; other manifests under assets/llm stay selectable for the SUMMARIZE benchmark hook. */
    static final String LLM_MANIFEST = "llm/gemma-4-e2b.json";
    static final String CLIP_MANIFEST = "clip/mobileclip2-s2.json";
    private volatile ModelStore clipStore, speechStore, llmStore;
    private volatile ai.ainetwork.aindrive.llm.Summarizer summarizer;
    private volatile ClipEmbedder clip;
    private volatile SpeechRecognizer speech;
    private volatile boolean modelsDownloading;
    private volatile String modelsError;
    private volatile long modelsDone, modelsTotal;

    private ModelStore clipStore() throws java.io.IOException {
        if (clipStore == null) clipStore = new ModelStore(this, CLIP_MANIFEST);
        return clipStore;
    }

    /** The speech engine's name from its manifest — transcripts are only comparable within one engine. */
    private String speechEngineName() {
        try { return speechStore().manifest.optString("engine", "whisper") + "/" + speechStore().manifest.optString("model", ""); }
        catch (Exception e) { return "unknown"; }
    }

    private ModelStore llmStore() throws java.io.IOException {
        if (llmStore == null) llmStore = new ModelStore(this, LLM_MANIFEST);
        return llmStore;
    }

    /** The summariser, loaded on first use when its model is present; null otherwise (reports fall back to topic words). */
    synchronized @Nullable ai.ainetwork.aindrive.llm.Summarizer summarizerOrNull() {
        if (summarizer == null) {
            try { ModelStore s = llmStore(); if (s.ready()) summarizer = new ai.ainetwork.aindrive.llm.Summarizer(this, s); }
            catch (Exception e) { Log.w(TAG, "summariser unavailable: " + e.getMessage()); }
        }
        return summarizer;
    }

    /** Free the ~1.6 GB model after a report. */
    synchronized void releaseSummarizer() {
        if (summarizer != null) { try { summarizer.close(); } catch (Exception ignored) { } summarizer = null; }
    }

    private ModelStore speechStore() throws java.io.IOException {
        if (speechStore == null) speechStore = new ModelStore(this, SPEECH_MANIFEST);
        return speechStore;
    }

    /** The photo recogniser if its files are on the phone; null otherwise (never downloads here). */
    @Nullable ClipEmbedder clipOrNull() {
        ClipEmbedder c = clip;
        if (c != null) return c;
        synchronized (this) {
            if (clip == null) {
                try { ModelStore s = clipStore(); if (s.ready()) clip = new ClipEmbedder(this, s); }
                catch (Exception e) { Log.w(TAG, "clip unavailable: " + e.getMessage()); }
            }
            return clip;
        }
    }

    @Nullable SpeechRecognizer speechOrNull() {
        SpeechRecognizer r = speech;
        if (r != null) return r;
        synchronized (this) {
            if (speech == null) {
                try { ModelStore s = speechStore(); if (s.ready()) speech = new SpeechRecognizer(this, s); }
                catch (Exception e) { Log.w(TAG, "speech unavailable: " + e.getMessage()); }
            }
            return speech;
        }
    }

    private static JSONObject modelInfo(String id, String role, ModelStore s, boolean ready) throws Exception {
        return new JSONObject().put("id", id).put("role", role).put("name", s.manifest.optString("model", "")).put("license", s.manifest.optString("license", ""))
                .put("engine", s.manifest.optString("engine", "")).put("bytes", s.totalBytes()).put("ready", ready);
    }

    JSONObject modelsJson() {
        JSONObject o = new JSONObject();
        try {
            boolean clipReady = false, speechReady = false, llmReady = false; long total = 0;
            try { clipReady = clipStore().ready(); total += clipStore().totalBytes(); } catch (Exception ignored) { }
            try { speechReady = speechStore().ready(); total += speechStore().totalBytes(); } catch (Exception ignored) { }
            try { llmReady = llmStore().ready(); total += llmStore().totalBytes(); } catch (Exception ignored) { }
            // What runs where — shown in the app so the user knows exactly which models see their data.
            JSONArray list = new JSONArray();
            try { list.put(modelInfo("image", "Image", clipStore(), clipReady)); } catch (Exception ignored) { }
            try { list.put(modelInfo("speech", "Speech", speechStore(), speechReady)); } catch (Exception ignored) { }
            try { list.put(modelInfo("llm", "LLM", llmStore(), llmReady)); } catch (Exception ignored) { }
            o.put("list", list).put("llm", llmReady);
            o.put("photos", clipReady).put("speech", speechReady).put("ready", clipReady && speechReady)
             .put("downloading", modelsDownloading).put("done", modelsDone).put("total", modelsDownloading ? modelsTotal : total)
             .put("error", modelsError == null ? JSONObject.NULL : modelsError);
        } catch (Exception ignored) { }
        return o;
    }

    /** Fetch both model sets (verified), then recognise everything already indexed. */
    void ensureModels() {
        if (modelsDownloading) return;
        modelsDownloading = true; modelsError = null; modelsDone = 0;
        indexPool.execute(() -> {
            try {
                ModelStore[] stores = {clipStore(), speechStore(), llmStore()};
                modelsTotal = stores[0].totalBytes() + stores[1].totalBytes() + stores[2].totalBytes();
                final long[] base = {0};
                for (ModelStore s : stores) {
                    final long[] fileDone = {0};
                    long storeBase = base[0];
                    s.ensure((id, done, tot) -> { modelsDone = storeBase + fileDone[0] + done; if (done >= tot) { fileDone[0] += tot; } notifyStatus(); });
                    base[0] += s.totalBytes();
                }
                modelsDone = modelsTotal;
                Log.i(TAG, "models ready");
            } catch (Exception e) {
                modelsError = e.getMessage();
                Log.w(TAG, "model download failed", e);
            } finally {
                modelsDownloading = false;
                notifyStatus();
            }
            if (modelsError == null) reindex(null);
        });
    }

    // ------------------------------------------------------------ on-device agent

    /** Gazetteer is ~34k rows; load once per process, lazily, off the main thread. */
    private GeoLookup geo() {
        GeoLookup g = geo;
        if (g == null) {
            synchronized (this) {
                if (geo == null) {
                    // AAPT already inflates .gz assets and drops the suffix: the bundled
                    // geo/cities.tsv.gz is read back as geo/cities.tsv.
                    try { geo = GeoLookup.load(getAssets().open("geo/cities.tsv")); }
                    catch (Exception e) { throw new RuntimeException("gazetteer load failed: " + e.getMessage(), e); }
                }
                g = geo;
            }
        }
        return g;
    }

    /** (Re)index one drive, or every drive when driveId is null. Returns false if none matched. */
    boolean reindex(@Nullable String driveId) {
        java.util.List<Conn> targets = new java.util.ArrayList<>();
        synchronized (conns) {
            for (Conn c : conns.values()) if ((driveId == null || driveId.equals(c.driveId)) && c.fs != null) targets.add(c);
        }
        for (Conn c : targets) {
            indexPool.execute(() -> {
                try { c.indexer().runOnce((done, total, phase) -> notifyStatus()); }
                catch (RuntimeException e) { c.lastError = e.getMessage(); Log.w(TAG, "index failed", e); notifyStatus(); }
            });
        }
        return !targets.isEmpty();
    }

    /**
     * Ask every running drive and merge, newest first. One phone, one user —
     * the folders are all theirs, so a question spans all of them.
     */
    /** Drive ids of the agent sources (fixed: one folder of each kind). */
    public static final String SOURCE_CALLS = "src-calls", SOURCE_PHOTOS = "src-photos";
    /** "src-calls" (Call/) and "src-calls-new" (Recordings/Call/): Samsung keeps call recordings in two places over the years. */
    static boolean isCallSource(String driveId) { return driveId != null && driveId.startsWith(SOURCE_CALLS); }

    /** Calls per contact name in the last year, from the call log (empty without READ_CALL_LOG). */
    java.util.Map<String, Integer> recentCallCounts() {
        java.util.Map<String, Integer> out = new java.util.HashMap<>();
        java.util.List<ai.ainetwork.aindrive.agent.CallReport.Call> log = callLog();
        if (log == null) return out;
        long since = System.currentTimeMillis() - ai.ainetwork.aindrive.agent.CallReport.WINDOW_MS;
        for (ai.ainetwork.aindrive.agent.CallReport.Call c : log)
            if (c.whenMs >= since && c.name != null && !c.name.trim().isEmpty()) out.merge(c.name.replaceFirst("^#", "").replaceAll("\\s+", " ").trim(), 1, Integer::sum);
        return out;
    }

    java.util.List<FileIndex> callIndexes() {
        java.util.List<FileIndex> out = new java.util.ArrayList<>();
        synchronized (conns) { for (Conn c : conns.values()) if (isCallSource(c.driveId) && c.index != null) out.add(c.index); }
        return out;
    }

    /** A call folder still transcribing: the report should not start a second recogniser next to it. */
    boolean anyIndexerRunning() {
        synchronized (conns) { for (Conn c : conns.values()) if (isCallSource(c.driveId) && c.indexer != null && c.indexer.running) return true; }
        return false;
    }

    /** The shared drive that receives what the agent makes out of a source. */
    @Nullable Conn outputConn() {
        synchronized (conns) {
            for (Conn c : conns.values()) if (!c.source && c.fs != null && !c.closed) return c;
        }
        return null;
    }

    /** The phone's call log, newest first; null when READ_CALL_LOG was not granted. */
    @Nullable java.util.List<ai.ainetwork.aindrive.agent.CallReport.Call> callLog() {
        java.util.List<ai.ainetwork.aindrive.agent.CallReport.Call> out = new java.util.ArrayList<>();
        String[] cols = {android.provider.CallLog.Calls.NUMBER, android.provider.CallLog.Calls.CACHED_NAME, android.provider.CallLog.Calls.DURATION, android.provider.CallLog.Calls.DATE};
        try (android.database.Cursor c = getContentResolver().query(android.provider.CallLog.Calls.CONTENT_URI, cols, null, null, android.provider.CallLog.Calls.DATE + " DESC")) {
            if (c == null) return null;
            while (c.moveToNext()) out.add(new ai.ainetwork.aindrive.agent.CallReport.Call(c.getString(0) == null ? "" : c.getString(0), c.getString(1), c.getLong(2), c.getLong(3)));
        } catch (SecurityException e) {
            return null;
        }
        return out;
    }

    JSONObject ask(String query) throws Exception { return ask(query, null); }

    JSONObject ask(String query, @Nullable JSONObject context) throws Exception {
        java.util.List<Conn> targets;
        synchronized (conns) { targets = new java.util.ArrayList<>(conns.values()); }
        if (targets.isEmpty()) throw new IllegalStateException("no drive is running");
        if (ai.ainetwork.aindrive.agent.QueryParser.isCallsTask(query)) {
            // One report, over the call-recordings source when there is one (else the first drive: it may hold recordings).
            Conn c = null;
            java.util.List<FileIndex> callIndexes = new java.util.ArrayList<>();
            for (Conn t : targets) if (isCallSource(t.driveId) && t.fs != null) { if (c == null) c = t; callIndexes.add(t.index); }
            if (c == null) for (Conn t : targets) if (t.fs != null) { c = t; break; }
            if (c == null) throw new IllegalStateException("no drive is running");
            JSONObject r = c.askRunner().ask(query, context);
            Conn out = c.source ? outputConn() : c;
            String outId = out == null ? c.driveId : out.driveId;
            JSONArray s = r.getJSONArray("sources");
            for (int i = 0; i < s.length(); i++) s.getJSONObject(i).put("driveId", c.driveId).put("drive", c.folderLabel == null ? c.driveId : c.folderLabel);
            if (r.has("action")) r.getJSONObject("action").put("driveId", outId);
            return r;
        }
        if (targets.size() == 1) {
            JSONObject r = targets.get(0).askRunner().ask(query, context);
            Conn only = targets.get(0), out = only.source ? outputConn() : only;
            JSONArray s = r.getJSONArray("sources");
            for (int i = 0; i < s.length(); i++) s.getJSONObject(i).put("driveId", only.driveId);
            if (r.has("action")) r.getJSONObject("action").put("driveId", out == null ? only.driveId : out.driveId);
            return r;
        }
        JSONArray sources = new JSONArray();
        StringBuilder answer = new StringBuilder();
        JSONObject actionOut = new JSONObject();
        // Ask every folder first: when any matched exactly, folders that only matched after
        // loosening the question ("ignoring the content words") are left out of the answer.
        java.util.Map<Conn, JSONObject> results = new java.util.LinkedHashMap<>();
        boolean anyExact = false;
        for (Conn c : targets) {
            if (c.fs == null) continue;
            JSONObject r = c.askRunner().ask(query, context);
            results.put(c, r);
            if (r.getJSONArray("sources").length() > 0 && !r.optBoolean("relaxed")) anyExact = true;
        }
        for (java.util.Map.Entry<Conn, JSONObject> e : results.entrySet()) {
            Conn c = e.getKey();
            JSONObject r = e.getValue();
            if (anyExact && r.optBoolean("relaxed")) continue;
            JSONArray s = r.getJSONArray("sources");
            for (int i = 0; i < s.length(); i++) {
                JSONObject src = s.getJSONObject(i);
                // Keep `path` drive-relative (the web deep-link needs it); the
                // folder is named in `drive` so the UI can still show it.
                src.put("driveId", c.driveId).put("drive", c.folderLabel == null ? c.driveId : c.folderLabel);
                sources.put(src);
            }
            if (s.length() > 0) answer.append(answer.length() > 0 ? " " : "").append(c.folderLabel).append(": ").append(r.getString("answer"));
            if (r.has("action") && !r.getJSONObject("action").optBoolean("skipped") && !actionOut.has("folder")) {
                Conn out = c.source ? outputConn() : c;
                actionOut = r.getJSONObject("action").put("driveId", out == null ? c.driveId : out.driveId);
            }
        }
        if (answer.length() == 0) {
            // Nobody matched: prefer a folder whose reply says where its photos ARE from over one with no locations.
            String best = null;
            for (JSONObject r : results.values()) {
                String a = r.getString("answer");   // reuse: asking again could repeat a task
                if (best == null || (a.contains(" are from ") || a.contains("이런 곳에서")) && !(best.contains(" are from ") || best.contains("이런 곳에서"))) best = a;
            }
            answer.append(best == null ? "" : best);
        }
        JSONObject merged = new JSONObject().put("answer", answer.toString()).put("sources", sources);
        if (actionOut.has("folder")) merged.put("action", actionOut);
        return merged;
    }

    /** Mirrors toWsUrl in cli/src/agent.js. */
    static String toWsUrl(String server, String driveId) {
        String base = server.replaceAll("/+$", "");
        String scheme = base.startsWith("https://") ? "wss://" : "ws://";
        String host = base.replaceFirst("^https?://", "");
        return scheme + host + "/api/agent/connect?driveId=" + Uri.encode(driveId);
    }

    private static JSONObject copyWithout(JSONObject src, String... drop) {
        JSONObject out = new JSONObject();
        java.util.List<String> skip = java.util.Arrays.asList(drop);
        for (java.util.Iterator<String> it = src.keys(); it.hasNext(); ) {
            String k = it.next();
            if (skip.contains(k)) continue;
            try { out.put(k, src.get(k)); } catch (Exception ignored) { }
        }
        return out;
    }

    /** Strip anything path-shaped out of error text before it leaves the phone. */
    static String sanitize(String msg) {
        String s = msg == null || msg.isEmpty() ? "error" : msg;
        s = s.replaceAll("(content://|/)[A-Za-z0-9_.%:/-]+", "<path>");
        return s.length() > 300 ? s.substring(0, 300) : s;
    }

    // ------------------------------------------------------------ status

    /**
     * Shape mirrored by src/plugin.ts `AgentStatus`: `drives[]` carries one row
     * per drive; the top-level `running`/`connected` are aggregates.
     */
    JSONObject statusJson() {
        JSONObject o = new JSONObject();
        JSONArray drives = new JSONArray();
        boolean anyConnected = false;
        synchronized (conns) {
            for (Conn c : conns.values()) {
                drives.put(c.statusJson());
                anyConnected |= c.connected;
            }
        }
        try {
            o.put("running", !stopping && drives.length() > 0);
            o.put("connected", anyConnected);
            o.put("drives", drives);
            o.put("models", modelsJson());
        } catch (Exception ignored) { }
        return o;
    }

    private String notificationText() {
        int total, online;
        StringBuilder labels = new StringBuilder();
        synchronized (conns) {
            total = conns.size();
            online = 0;
            for (Conn c : conns.values()) {
                Indexer in = c.indexer;
                if (in != null && in.running) {
                    String what = "recognising".equals(in.phase) ? "Recognising " + in.recognised + " / " + in.toRecognise : "Indexing " + in.done + " / " + in.total;
                    return what + " · " + (c.folderLabel == null ? "Folder" : c.folderLabel);
                }
                if (modelsDownloading) return "Downloading recognition models " + (modelsDone / 1_000_000) + " / " + (modelsTotal / 1_000_000) + " MB";
                if (c.connected) online++;
                if (labels.length() > 0) labels.append(", ");
                labels.append(c.folderLabel == null ? "Folder" : c.folderLabel);
            }
        }
        if (total == 0) return "Stopped";
        if (online == total) return "Online · " + labels;
        if (online == 0) return "Reconnecting… · " + labels;
        return "Online " + online + "/" + total + " · " + labels;
    }

    private void notifyStatus() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && !stopping) nm.notify(NOTIFICATION_ID, buildNotification(notificationText()));
        StatusListener l = statusListener;
        if (l != null) main.post(() -> l.onStatus(statusJson()));
    }

    private void stopDrive(String driveId) {
        Conn c;
        boolean empty;
        synchronized (conns) {
            c = conns.remove(driveId);
            empty = conns.isEmpty();
        }
        if (c != null) c.close();
        if (empty) shutdownAll(); else notifyStatus();
    }

    private void shutdownAll() {
        stopping = true;
        synchronized (conns) {
            for (Conn c : conns.values()) c.close();
            conns.clear();
        }
        notifyStatus();
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        rpcPool.shutdownNow();
        indexPool.shutdownNow();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Nullable @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------ notification

    private Notification buildNotification(String text) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "aindrive agent", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Shown while this phone's folders are being shared as drives");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, AgentService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return b.setContentTitle("aindrive")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentIntent(openPi)
                .addAction(new Notification.Action.Builder(null, "Stop all", stopPi).build())
                .setOngoing(true)
                .build();
    }
}
