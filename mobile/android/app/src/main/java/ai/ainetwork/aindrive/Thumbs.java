package ai.ainetwork.aindrive;

import android.content.Context;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * A small JPEG of a photo or video in a shared folder, cached in the app's cache dir: the phone's
 * own thumbnail when it has one (what the gallery shows), else a streamed downsample. Used by the
 * app's grid (AindriveAgentPlugin.thumbnail) and by other devices (RpcHandler "thumbnail"), which
 * then move tens of KB instead of the camera original.
 */
final class Thumbs {
    private Thumbs() { }

    /** @param key identifies the folder in the cache key (its tree uri). */
    static File jpeg(Context ctx, SafFs fs, String key, String path, int px) throws IOException {
        File dir = new File(ctx.getCacheDir(), "thumbs");
        File f = new File(dir, sha1(key + "|" + path + "|" + px) + ".jpg");
        if (f.isFile() && f.length() > 0) return f;
        String docId = fs.resolve(path);
        if (docId == null) throw new FileNotFoundException("no such file");
        android.graphics.Bitmap bmp = null;
        try { bmp = android.provider.DocumentsContract.getDocumentThumbnail(ctx.getContentResolver(), fs.uriOf(docId), new android.graphics.Point(px, px), null); }
        catch (Exception ignored) { }
        if (bmp == null) bmp = decodeSmall(fs, docId, px);
        if (bmp == null) throw new IOException("no preview");
        dir.mkdirs();
        File tmp = new File(dir, f.getName() + "." + Thread.currentThread().getId() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, out); }
        bmp.recycle();
        if (!tmp.renameTo(f)) throw new IOException("cache write failed");
        return f;
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
}
