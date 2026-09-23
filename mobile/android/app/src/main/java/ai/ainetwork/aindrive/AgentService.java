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

import org.json.JSONObject;

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
    private final AtomicInteger rpcCount = new AtomicInteger();

    private OkHttpClient http;
    private WebSocket ws;
    private boolean connected;
    private boolean stopping;
    private int attempt;
    private String lastError;

    private String serverUrl, driveId, agentToken, driveSecret, folderLabel;
    private SafFs fs;
    private RpcHandler rpc;

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
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            shutdown();
            return START_NOT_STICKY;
        }
        serverUrl = intent.getStringExtra("serverUrl");
        driveId = intent.getStringExtra("driveId");
        agentToken = intent.getStringExtra("agentToken");
        driveSecret = intent.getStringExtra("driveSecret");
        String folderUri = intent.getStringExtra("folderUri");
        folderLabel = intent.getStringExtra("folderLabel");

        startForeground(NOTIFICATION_ID, buildNotification("Connecting…"));

        try {
            Uri tree = Uri.parse(folderUri);
            fs = new SafFs(this, tree);
            rpc = new RpcHandler(this, fs, driveId);
        } catch (Exception e) {
            fail("Could not open folder: " + e.getMessage());
            return START_NOT_STICKY;
        }

        stopping = false;
        attempt = 0;
        connect();
        // START_STICKY: if Android reclaims us under memory pressure, come back
        // and reconnect rather than leaving the drive silently offline.
        return START_STICKY;
    }

    // ------------------------------------------------------------ socket

    private void connect() {
        if (stopping) return;
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
                notifyStatus("Online · " + safeLabel());
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

    /** Mirrors toWsUrl in cli/src/agent.js. */
    static String toWsUrl(String server, String driveId) {
        String base = server.replaceAll("/+$", "");
        String scheme = base.startsWith("https://") ? "wss://" : "ws://";
        String host = base.replaceFirst("^https?://", "");
        return scheme + host + "/api/agent/connect?driveId=" + Uri.encode(driveId);
    }

    private void scheduleReconnect(String why) {
        if (stopping) return;
        lastError = why;
        notifyStatus("Reconnecting… (" + why + ")");
        long wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        main.postDelayed(this::connect, wait);
    }

    // ------------------------------------------------------------ frames

    private void onFrame(WebSocket socket, String text) {
        JSONObject frame;
        try { frame = new JSONObject(text); }
        catch (Exception e) { Log.w(TAG, "frame parse failed (" + text.length() + " chars)", e); return; }

        String type = frame.optString("type", "");
        JSONObject p0 = frame.optJSONObject("params");
        Log.d(TAG, "frame type=" + type + " method=" + (p0 == null ? "-" : p0.optString("method", "?"))
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
            Log.w(TAG, "rpc " + (frame.optJSONObject("params") == null ? "?" : frame.optJSONObject("params").optString("method", "?")) + " failed", e);
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
        notifyStatus(connected ? "Online · " + safeLabel() : "Offline");
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

    JSONObject statusJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("running", !stopping && ws != null);
            o.put("connected", connected);
            o.put("driveId", driveId == null ? JSONObject.NULL : driveId);
            o.put("folderLabel", folderLabel == null ? JSONObject.NULL : folderLabel);
            o.put("rpcCount", rpcCount.get());
            o.put("lastError", lastError == null ? JSONObject.NULL : lastError);
        } catch (Exception ignored) { }
        return o;
    }

    private void notifyStatus(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text));
        StatusListener l = statusListener;
        if (l != null) main.post(() -> l.onStatus(statusJson()));
    }

    private void fail(String why) {
        lastError = why;
        notifyStatus(why);
        stopSelf();
    }

    private String safeLabel() {
        return folderLabel == null ? "Folder" : folderLabel;
    }

    private void shutdown() {
        stopping = true;
        connected = false;
        if (ws != null) {
            try { ws.close(1001, "agent shutting down"); } catch (Exception ignored) { }
            ws = null;
        }
        notifyStatus("Stopped");
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        rpcPool.shutdownNow();
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
                ch.setDescription("Shown while this phone's folder is being shared as a drive");
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
                .addAction(new Notification.Action.Builder(null, "Stop", stopPi).build())
                .setOngoing(true)
                .build();
    }
}
