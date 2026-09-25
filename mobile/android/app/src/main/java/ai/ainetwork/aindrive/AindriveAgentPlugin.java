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
                @Permission(alias = "mediaLocation", strings = {"android.permission.ACCESS_MEDIA_LOCATION"}),
                @Permission(alias = "callLog", strings = {"android.permission.READ_CALL_LOG"})
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
        // "initial": open the picker AT a folder ("Call", "DCIM") so the user only has to confirm.
        String initial = call.getString("initial");
        if (initial != null && Build.VERSION.SDK_INT >= 26) {
            Uri at = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + initial);
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, at);
        }
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

    // ------------------------------------------------------------ browse

    /**
     * In-app file browser for a shared folder. Reads the same SAF tree the
     * agent serves, so what the user sees here is exactly what the drive shows
     * on the web — no network, works while the drive is off.
     */
    @PluginMethod
    public void listFolder(PluginCall call) {
        String folderUri = call.getString("folderUri");
        String path = call.getString("path", "");
        if (folderUri == null) { call.reject("missing folderUri"); return; }
        try {
            SafFs fs = new SafFs(getContext(), Uri.parse(folderUri));
            com.getcapacitor.JSArray entries = new com.getcapacitor.JSArray();
            for (SafFs.Entry e : fs.list(path)) {
                JSObject o = new JSObject();
                o.put("name", e.name);
                o.put("path", e.path);
                o.put("isDir", e.isDir);
                o.put("size", e.size);
                o.put("mtimeMs", e.mtimeMs);
                o.put("mime", e.mime);
                entries.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("entries", entries);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read folder: " + e.getMessage());
        }
    }

    /**
     * File bytes for the in-app viewer: images come back downscaled (longest
     * edge ≤ maxPx, JPEG) so a 12 MP photo is a few hundred KB on the bridge;
     * anything else is raw, capped at 25 MB.
     */
    @PluginMethod
    public void readFile(PluginCall call) {
        String folderUri = call.getString("folderUri");
        String path = call.getString("path");
        int maxPx = call.getInt("maxPx", 1600);
        if (folderUri == null || path == null) { call.reject("missing folderUri/path"); return; }
        new Thread(() -> {
            try {
                SafFs fs = new SafFs(getContext(), Uri.parse(folderUri));
                SafFs.Entry e = fs.stat(path);
                if (e == null || e.isDir) throw new java.io.FileNotFoundException("no such file");
                byte[] bytes; String mime = e.mime == null ? "application/octet-stream" : e.mime;
                if (mime.startsWith("image/")) {
                    byte[] raw = fs.read(path, 64 * 1024 * 1024);
                    android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                    o.inJustDecodeBounds = true;
                    android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
                    int sample = 1;
                    while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= maxPx) sample *= 2;
                    android.graphics.BitmapFactory.Options o2 = new android.graphics.BitmapFactory.Options();
                    o2.inSampleSize = sample;
                    android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length, o2);
                    if (bmp == null) throw new java.io.IOException("not an image");
                    // Honour EXIF orientation so portrait phone shots don't show sideways.
                    try {
                        androidx.exifinterface.media.ExifInterface ex = new androidx.exifinterface.media.ExifInterface(new java.io.ByteArrayInputStream(raw));
                        int rot = ex.getRotationDegrees();
                        if (rot != 0) {
                            android.graphics.Matrix m = new android.graphics.Matrix(); m.postRotate(rot);
                            android.graphics.Bitmap r = android.graphics.Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                            if (r != bmp) { bmp.recycle(); bmp = r; }
                        }
                    } catch (Exception ignored) { }
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, bos);
                    bmp.recycle();
                    bytes = bos.toByteArray(); mime = "image/jpeg";
                } else {
                    if (e.size > 25L * 1024 * 1024) throw new java.io.IOException("file too large to view in the app");
                    bytes = fs.read(path, (int) Math.min(e.size, 25L * 1024 * 1024));
                }
                JSObject ret = new JSObject();
                ret.put("mime", mime);
                ret.put("name", e.name);
                ret.put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("Could not read file: " + ex.getMessage());
            }
        }, "aindrive-read").start();
    }

    private static final java.util.concurrent.ExecutorService THUMBS = java.util.concurrent.Executors.newFixedThreadPool(6);
    private final java.util.Map<String, SafFs> thumbFs = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * A small JPEG of a photo or video as a file in the app cache (pass its path to
     * Capacitor.convertFileSrc): the phone's own cached thumbnail when it has one — what the
     * gallery shows — else a streamed downsample. Cached on disk, so a second look is instant,
     * and nothing crosses the bridge as base64.
     */
    @PluginMethod
    public void thumbnail(PluginCall call) {
        String folderUri = call.getString("folderUri");
        String path = call.getString("path");
        int px = call.getInt("px", 256);
        if (folderUri == null || path == null) { call.reject("missing folderUri/path"); return; }
        THUMBS.execute(() -> {
            try {
                java.io.File dir = new java.io.File(getContext().getCacheDir(), "thumbs");
                java.io.File f = new java.io.File(dir, sha1(folderUri + "|" + path + "|" + px) + ".jpg");
                if (!(f.isFile() && f.length() > 0)) {
                    SafFs fs = thumbFs.computeIfAbsent(folderUri, u -> new SafFs(getContext(), Uri.parse(u)));
                    String docId = fs.resolve(path);
                    if (docId == null) throw new java.io.FileNotFoundException("no such file");
                    android.graphics.Bitmap bmp = null;
                    try { bmp = android.provider.DocumentsContract.getDocumentThumbnail(getContext().getContentResolver(), fs.uriOf(docId), new android.graphics.Point(px, px), null); }
                    catch (Exception ignored) { }
                    if (bmp == null) bmp = decodeSmall(fs, docId, px);
                    if (bmp == null) throw new java.io.IOException("no preview");
                    dir.mkdirs();
                    java.io.File tmp = new java.io.File(dir, f.getName() + ".tmp");
                    try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out); }
                    bmp.recycle();
                    if (!tmp.renameTo(f)) throw new java.io.IOException("cache write failed");
                }
                JSObject ret = new JSObject();
                ret.put("path", f.getAbsolutePath());
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("No thumbnail: " + ex.getMessage());
            }
        });
    }

    /** Decode at ~px from the file descriptor (no full read into memory), EXIF-rotated. */
    private static @androidx.annotation.Nullable android.graphics.Bitmap decodeSmall(SafFs fs, String docId, int px) throws java.io.IOException {
        try (android.os.ParcelFileDescriptor pfd = fs.openFd(docId)) {
            java.io.FileDescriptor fd = pfd.getFileDescriptor();
            android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeFileDescriptor(fd, null, o);
            if (o.outWidth <= 0) return null;
            int sample = 1;
            while (Math.min(o.outWidth, o.outHeight) / (sample * 2) >= px) sample *= 2;
            android.system.Os.lseek(fd, 0, android.system.OsConstants.SEEK_SET);
            android.graphics.BitmapFactory.Options o2 = new android.graphics.BitmapFactory.Options();
            o2.inSampleSize = sample;
            android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeFileDescriptor(fd, null, o2);
            if (bmp == null) return null;
            try {
                android.system.Os.lseek(fd, 0, android.system.OsConstants.SEEK_SET);
                int rot = new androidx.exifinterface.media.ExifInterface(fd).getRotationDegrees();
                if (rot != 0) {
                    android.graphics.Matrix m = new android.graphics.Matrix(); m.postRotate(rot);
                    android.graphics.Bitmap r = android.graphics.Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                    if (r != bmp) { bmp.recycle(); bmp = r; }
                }
            } catch (Exception ignored) { }
            return bmp;
        } catch (android.system.ErrnoException e) {
            throw new java.io.IOException(e);
        }
    }

    private static String sha1(String s) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-1").digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder();
            for (byte b : d) h.append(String.format("%02x", b));
            return h.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    /** Hand a file to whatever app handles its type (the phone's "open"). */
    @PluginMethod
    public void openFile(PluginCall call) {
        String folderUri = call.getString("folderUri");
        String path = call.getString("path");
        if (folderUri == null || path == null) { call.reject("missing folderUri/path"); return; }
        try {
            SafFs fs = new SafFs(getContext(), Uri.parse(folderUri));
            SafFs.Entry e = fs.stat(path);
            if (e == null) throw new java.io.FileNotFoundException("no such file");
            Intent view = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(fs.uriFor(path), e.isDir ? "*/*" : e.mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(view, e.name));
            call.resolve();
        } catch (android.content.ActivityNotFoundException e) {
            call.reject("No app on this phone can open this file");
        } catch (Exception e) {
            call.reject("Could not open file: " + e.getMessage());
        }
    }

    /** Basic edits for the in-app browser; same SafFs calls the web's RPCs use. */
    @PluginMethod
    public void mkdir(PluginCall call) {
        withFs(call, (fs) -> { fs.mkdirs(call.getString("path", "")); return null; });
    }

    @PluginMethod
    public void rename(PluginCall call) {
        withFs(call, (fs) -> { fs.rename(call.getString("from", ""), call.getString("to", "")); return null; });
    }

    /** Save text (UTF-8) to a file in the folder, replacing it — the in-app editor's Save. */
    @PluginMethod
    public void writeText(PluginCall call) {
        withFs(call, (fs) -> {
            String path = call.getString("path", "");
            byte[] bytes = call.getString("text", "").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            fs.importFile(SafFs.parentOf(path), SafFs.baseName(path), new java.io.ByteArrayInputStream(bytes));
            return null;
        });
    }

    @PluginMethod
    public void delete(PluginCall call) {
        withFs(call, (fs) -> { fs.delete(call.getString("path", "")); return null; });
    }

    private interface FsOp { Object run(SafFs fs) throws Exception; }

    private void withFs(PluginCall call, FsOp op) {
        String folderUri = call.getString("folderUri");
        if (folderUri == null) { call.reject("missing folderUri"); return; }
        try {
            op.run(new SafFs(getContext(), Uri.parse(folderUri)));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "failed" : e.getMessage());
        }
    }

    // ------------------------------------------------------------ add files

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
        String dir = call.getString("path", "");
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
                    fs.importFile(dir, name, in);
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

    /** READ_CALL_LOG for the call-history report; resolves {granted}. */
    @PluginMethod
    public void requestCallLog(PluginCall call) {
        if (getPermissionState("callLog") == com.getcapacitor.PermissionState.GRANTED) { call.resolve(new JSObject().put("granted", true)); return; }
        requestPermissionForAlias("callLog", call, "afterCallLogPermission");
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterCallLogPermission(PluginCall call) {
        call.resolve(new JSObject().put("granted", getPermissionState("callLog") == com.getcapacitor.PermissionState.GRANTED));
    }

    @PluginMethod
    public void start(PluginCall call) {
        boolean source = Boolean.TRUE.equals(call.getBoolean("source", false));
        String[] required = source ? new String[]{"driveId", "folderUri"} : new String[]{"serverUrl", "driveId", "agentToken", "driveSecret", "folderUri"};
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
                .putExtra("indexOnStart", Boolean.TRUE.equals(call.getBoolean("indexOnStart", false)))
                .putExtra("source", Boolean.TRUE.equals(call.getBoolean("source", false)));
        java.util.ArrayList<String> exclude = new java.util.ArrayList<>();
        com.getcapacitor.JSArray ex = call.getArray("excludeUris");
        if (ex != null) for (int i = 0; i < ex.length(); i++) { try { exclude.add(ex.getString(i)); } catch (Exception ignored) { } }
        svc.putStringArrayListExtra("excludeUris", exclude);
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

    /** Download the recognition models (photos + speech, ≈230 MB, verified) and recognise what is indexed. Progress via statusChanged. */
    @PluginMethod
    public void ensureModels(PluginCall call) {
        Intent svc = new Intent(getContext(), AgentService.class).setAction(AgentService.ACTION_ENSURE_MODELS);
        if (AgentService.get() == null) { call.reject("Turn a folder on first"); return; }
        getContext().startService(svc);
        call.resolve(currentStatus());
    }

    /** Ask the on-device agent. Fully offline: gazetteer + local index only. */
    @PluginMethod
    public void ask(PluginCall call) {
        String query = call.getString("query", "");
        org.json.JSONObject context = call.getObject("context");
        AgentService svc = AgentService.get();
        if (svc == null) { call.reject("Turn a drive on first"); return; }
        // SQLite + parse: fast, but keep it off the WebView thread regardless.
        new Thread(() -> {
            try { call.resolve(toJs(svc.ask(query, context))); }
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
