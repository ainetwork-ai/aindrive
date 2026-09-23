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
 * READ_EXTERNAL_STORAGE: the user picks a tree per drive, we take a
 * *persistable* grant on it so the drive survives reboots, and we can never
 * read anything they did not hand over. Each picked folder becomes its own
 * drive with its own socket — the mobile equivalent of running one `aindrive`
 * per directory. `start` adds a drive, `stop({driveId})` removes one, and
 * `stop()` with no id takes everything offline.
 */
@CapacitorPlugin(
        name = "AindriveAgent",
        permissions = {
                @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"}),
                @Permission(alias = "mediaLocation", strings = {"android.permission.ACCESS_MEDIA_LOCATION"})
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
            call.reject("Folder selection was cancelled");
            return;
        }
        // Without this the grant dies with the activity and the drive breaks on
        // the next launch with an opaque SecurityException.
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    tree,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Could not persist folder access permission: " + e.getMessage());
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
        return tail.isEmpty() ? "My folder" : tail;
    }

    // ------------------------------------------------------------ create + fill

    /**
     * "Share a NEW folder": the user picks where it should live (a SAF tree,
     * granted persistably), we create the sub-folder there and hand back a
     * folder handle rooted at it (see SafFs.subfolderUri). The parent grant is
     * what makes the sub-folder readable; the handle keeps both.
     */
    @PluginMethod
    public void createFolder(PluginCall call) {
        String name = call.getString("name", "").trim();
        if (name.isEmpty() || name.contains("/") || name.startsWith(".")) {
            call.reject("Enter a folder name without slashes");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "parentPicked");
    }

    @ActivityCallback
    private void parentPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri tree = data == null ? null : data.getData();
        if (tree == null) {
            call.reject("Location selection was cancelled");
            return;
        }
        String name = call.getString("name", "").trim();
        ContentResolver cr = getContext().getContentResolver();
        try {
            cr.takePersistableUriPermission(
                    tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            Uri parentDoc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            Uri created = DocumentsContract.createDocument(cr, parentDoc, DocumentsContract.Document.MIME_TYPE_DIR, name);
            if (created == null) throw new java.io.IOException("the storage provider refused to create a folder here");
            JSObject ret = new JSObject();
            ret.put("uri", SafFs.subfolderUri(tree, DocumentsContract.getDocumentId(created)).toString());
            // Providers may de-duplicate ("name (1)"); report what really exists.
            ret.put("label", displayName(created, name));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not create folder: " + e.getMessage());
        }
    }

    /**
     * "Put files into a shared folder": the phone has no drag-and-drop, so the
     * system file picker is the drop. Each picked document is copied into the
     * folder root (replacing a same-named file, like a desktop overwrite).
     */
    @PluginMethod
    public void addFiles(PluginCall call) {
        if (call.getString("folderUri") == null) {
            call.reject("missing folderUri");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "filesPicked");
    }

    @ActivityCallback
    private void filesPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        java.util.List<Uri> picked = new java.util.ArrayList<>();
        if (data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) picked.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                picked.add(data.getData());
            }
        }
        if (picked.isEmpty()) {
            call.reject("File selection was cancelled");
            return;
        }
        Uri folder = Uri.parse(call.getString("folderUri"));
        // Copies can be large; keep them off the main thread so the WebView
        // stays responsive, then resolve back on it.
        new Thread(() -> {
            ContentResolver cr = getContext().getContentResolver();
            com.getcapacitor.JSArray names = new com.getcapacitor.JSArray();
            com.getcapacitor.JSArray failed = new com.getcapacitor.JSArray();
            SafFs fs;
            try { fs = new SafFs(getContext(), folder); }
            catch (Exception e) { call.reject("Folder is no longer accessible: " + e.getMessage()); return; }
            for (Uri src : picked) {
                String name = displayName(src, "file");
                try (java.io.InputStream in = cr.openInputStream(src)) {
                    if (in == null) throw new java.io.IOException("unreadable");
                    fs.importFile(name, in);
                    names.put(name);
                } catch (Exception e) {
                    failed.put(name + ": " + e.getMessage());
                }
            }
            JSObject ret = new JSObject();
            ret.put("added", names);
            ret.put("failed", failed);
            call.resolve(ret);
        }, "aindrive-import").start();
    }

    private String displayName(Uri doc, String fallback) {
        try (android.database.Cursor c = getContext().getContentResolver().query(
                doc, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) { }
        return fallback;
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
                .putExtra("folderLabel", call.getString("folderLabel", ""))
                .putExtra("indexOnStart", Boolean.TRUE.equals(call.getBoolean("indexOnStart", false)));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        call.resolve(currentStatus());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent svc = new Intent(getContext(), AgentService.class).setAction(AgentService.ACTION_STOP);
        String driveId = call.getString("driveId");
        if (driveId != null) svc.putExtra(AgentService.EXTRA_DRIVE_ID, driveId);
        getContext().startService(svc);
        if (driveId == null) {
            call.resolve(idleStatus());
            return;
        }
        // The service removes the drive on the main looper after we return —
        // report the expected shape rather than the stale one.
        AgentService agent = AgentService.get();
        JSONObject src = agent == null ? null : agent.statusJson();
        JSONObject out = new JSONObject();
        org.json.JSONArray kept = new org.json.JSONArray();
        boolean anyConnected = false;
        try {
            org.json.JSONArray drives = src == null ? null : src.optJSONArray("drives");
            for (int i = 0; drives != null && i < drives.length(); i++) {
                JSONObject d = drives.getJSONObject(i);
                if (driveId.equals(d.optString("driveId"))) continue;
                kept.put(d);
                anyConnected |= d.optBoolean("connected");
            }
            out.put("running", kept.length() > 0);
            out.put("connected", anyConnected);
            out.put("drives", kept);
        } catch (org.json.JSONException ignored) { }
        call.resolve(toJs(out));
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(currentStatus());
    }

    // ------------------------------------------------------------ on-device agent

    /** Build/refresh the photo index for one drive (or all). Progress arrives via statusChanged. */
    @PluginMethod
    public void reindex(PluginCall call) {
        // Android 10+ redacts GPS from media streams unless this is granted, and
        // an index without locations cannot answer "photos from Paris".
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("mediaLocation") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("mediaLocation", call, "afterMediaLocationPermission");
            return;
        }
        doReindex(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterMediaLocationPermission(PluginCall call) {
        // Refused → index anyway; dates still work, places will be empty.
        doReindex(call);
    }

    private void doReindex(PluginCall call) {
        AgentService svc = AgentService.get();
        if (svc == null) { call.reject("Turn a drive on first"); return; }
        if (!svc.reindex(call.getString("driveId"))) { call.reject("That drive is not running"); return; }
        call.resolve(currentStatus());
    }

    /** Ask the on-device agent. Fully offline: gazetteer + local index only. */
    @PluginMethod
    public void ask(PluginCall call) {
        String query = call.getString("query", "");
        AgentService svc = AgentService.get();
        if (svc == null) { call.reject("Turn a drive on first"); return; }
        // SQLite + parse: fast, but keep it off the WebView thread regardless.
        new Thread(() -> {
            try { call.resolve(toJs(svc.ask(query))); }
            catch (Exception e) { call.reject(e.getMessage() == null ? "ask failed" : e.getMessage()); }
        }, "aindrive-ask").start();
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

    private static JSObject idleStatus() {
        JSObject idle = new JSObject();
        idle.put("running", false);
        idle.put("connected", false);
        idle.put("drives", new com.getcapacitor.JSArray());
        return idle;
    }

    private JSObject currentStatus() {
        AgentService svc = AgentService.get();
        if (svc == null) return idleStatus();
        return toJs(svc.statusJson());
    }
}
