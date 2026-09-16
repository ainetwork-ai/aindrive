package ai.ainetwork.aindrive;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONObject;

/**
 * Bridge between the shell UI (src/main.ts) and the native agent.
 *
 * Folder access goes through the Storage Access Framework rather than
 * READ_EXTERNAL_STORAGE: the user picks exactly one tree, we take a
 * *persistable* grant on it so the drive survives reboots, and we can never
 * read anything they did not hand over. That is the mobile equivalent of
 * running `aindrive` inside one directory.
 */
@CapacitorPlugin(
        name = "AindriveAgent",
        permissions = {
                @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"})
        })
public class AindriveAgentPlugin extends Plugin {

    @Override
    public void load() {
        AgentService.setStatusListener(status -> notifyListeners("statusChanged", toJs(status)));
    }

    // ------------------------------------------------------------ folder

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri tree = data == null ? null : data.getData();
        if (tree == null) {
            call.reject("폴더 선택이 취소되었습니다");
            return;
        }
        // Without this the grant dies with the activity and the drive breaks on
        // the next launch with an opaque SecurityException.
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    tree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("폴더 접근 권한을 유지할 수 없습니다: " + e.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        ret.put("label", labelFor(tree));
        call.resolve(ret);
    }

    /** Best-effort human name for the picked tree; falls back to the raw document id. */
    private String labelFor(Uri tree) {
        String docId = DocumentsContract.getTreeDocumentId(tree);
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
            ContentResolver cr = getContext().getContentResolver();
            try (android.database.Cursor c = cr.query(
                    docUri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String name = c.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) { }
        int colon = docId.lastIndexOf(':');
        String tail = colon >= 0 ? docId.substring(colon + 1) : docId;
        return tail.isEmpty() ? "내 폴더" : tail;
    }

    // ------------------------------------------------------------ agent

    @PluginMethod
    public void start(PluginCall call) {
        String[] required = {"serverUrl", "driveId", "agentToken", "driveSecret", "folderUri"};
        for (String k : required) {
            if (call.getString(k) == null) {
                call.reject("missing " + k);
                return;
            }
        }
        // Android 13+ silently drops the foreground-service notification without
        // this, which makes a running drive look stopped.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        launch(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        // A refused notification permission is not fatal — the drive still
        // serves, the user just loses the status row and the stop button.
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent svc = new Intent(getContext(), AgentService.class)
                .setAction(AgentService.ACTION_START)
                .putExtra("serverUrl", call.getString("serverUrl"))
                .putExtra("driveId", call.getString("driveId"))
                .putExtra("agentToken", call.getString("agentToken"))
                .putExtra("driveSecret", call.getString("driveSecret"))
                .putExtra("folderUri", call.getString("folderUri"))
                .putExtra("folderLabel", call.getString("folderLabel", ""));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        call.resolve(currentStatus());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().startService(new Intent(getContext(), AgentService.class).setAction(AgentService.ACTION_STOP));
        JSObject offline = new JSObject();
        offline.put("running", false);
        offline.put("connected", false);
        offline.put("driveId", null);
        offline.put("folderLabel", null);
        offline.put("rpcCount", 0);
        offline.put("lastError", null);
        call.resolve(offline);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(currentStatus());
    }

    /**
     * JSObject.fromJSONObject declares JSONException, which cannot escape a
     * listener lambda. The status object is built by us and always well-formed,
     * so a failure here means a programming error, not a runtime condition —
     * fall back to an empty object rather than crashing the agent.
     */
    private static JSObject toJs(JSONObject src) {
        try {
            return JSObject.fromJSONObject(src);
        } catch (org.json.JSONException e) {
            return new JSObject();
        }
    }

    private JSObject currentStatus() {
        AgentService svc = AgentService.get();
        if (svc == null) {
            JSObject idle = new JSObject();
            idle.put("running", false);
            idle.put("connected", false);
            idle.put("driveId", null);
            idle.put("folderLabel", null);
            idle.put("rpcCount", 0);
            idle.put("lastError", null);
            return idle;
        }
        return toJs(svc.statusJson());
    }
}
