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
import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.index.Indexer;
import ai.ainetwork.aindrive.index.PhotoIndex;

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
        if (ACTION_ASK.equals(intent.getAction())) {
            String q = intent.getStringExtra("query");
            rpcPool.execute(() -> {
                try { Log.i(TAG, "ask(" + q + ") → " + ask(q == null ? "" : q).toString(2)); }
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
        try {
            Uri tree = Uri.parse(intent.getStringExtra("folderUri"));
            conn.fs = new SafFs(this, tree);
            conn.index = new PhotoIndex(this, driveId);
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
        conn.connect();
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
        SafFs fs;
        RpcHandler rpc;
        PhotoIndex index;
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
            if (ask == null) ask = new AskRunner(index, geo());
            return ask;
        }

        synchronized Indexer indexer() {
            if (indexer == null) indexer = new Indexer(fs, index, geo());
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
                o.put("index", ix);
            } catch (Exception ignored) { }
            return o;
        }
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
    JSONObject ask(String query) throws Exception {
        java.util.List<Conn> targets;
        synchronized (conns) { targets = new java.util.ArrayList<>(conns.values()); }
        if (targets.isEmpty()) throw new IllegalStateException("no drive is running");
        if (targets.size() == 1) return targets.get(0).askRunner().ask(query);
        JSONArray sources = new JSONArray();
        StringBuilder answer = new StringBuilder();
        for (Conn c : targets) {
            if (c.fs == null) continue;
            JSONObject r = c.askRunner().ask(query);
            JSONArray s = r.getJSONArray("sources");
            for (int i = 0; i < s.length(); i++) {
                JSONObject src = s.getJSONObject(i);
                src.put("driveId", c.driveId).put("path", (c.folderLabel == null ? c.driveId : c.folderLabel) + "/" + src.getString("path"));
                sources.put(src);
            }
            if (s.length() > 0) answer.append(answer.length() > 0 ? " " : "").append(c.folderLabel).append(": ").append(r.getString("answer"));
        }
        if (answer.length() == 0) answer.append(targets.get(0).askRunner().ask(query).getString("answer"));
        return new JSONObject().put("answer", answer.toString()).put("sources", sources);
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
                if (in != null && in.running) return "Indexing photos " + in.done + " / " + in.total + " · " + (c.folderLabel == null ? "Folder" : c.folderLabel);
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
