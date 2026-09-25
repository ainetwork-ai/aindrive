package ai.ainetwork.aindrive.clip;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;

import androidx.annotation.Nullable;

import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

/**
 * MobileCLIP2-S2 (or any MobileCLIP-family export) on ONNX Runtime: an image
 * and a sentence become 512-d unit vectors in the same space, so "a photo of
 * a dog" is close to photos of dogs. On the real test corpus MobileCLIP2-S2
 * ranks best of everything measured (P@4 0.93 vs S0 0.88 vs SigLIP2-B 0.85);
 * the weights sit in `.onnx.data` files next to the graphs (ORT loads them).
 *
 * Preprocessing mirrors the model's preprocessor_config.json exactly: shortest
 * edge → 256, center crop 256×256, RGB in [0, 1], NO mean/std normalisation
 * (MobileCLIP is trained that way). Verified against the Python reference:
 * the same photos rank the same for the same queries.
 *
 * The vision model is fp32 (45 MB) and the text model int8 (43 MB). The
 * int8 vision export is broken (random rankings) and the fp16 one computes
 * wrong vectors on Android's CPU execution provider (cosine ≈ 0.2 with the
 * reference) — do not "optimise" to either.
 */
public final class ClipEmbedder implements AutoCloseable {
    public static final int DIM = 512, SIZE = 256;
    /** Cosine at/above which a photo "is" the query, and how far below the best hit still counts — calibrated per model (manifest). */
    public final float minScore, margin;
    public final String name;

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();
    private final OrtSession vision, text;
    private final ClipTokenizer tokenizer;
    private final Map<String, float[]> textCache = Collections.synchronizedMap(new HashMap<>());

    public ClipEmbedder(Context ctx, ModelStore store) throws IOException {
        try (InputStream v = ctx.getAssets().open("clip/vocab.txt"); InputStream m = ctx.getAssets().open("clip/merges.txt")) {
            tokenizer = new ClipTokenizer(v, m);
        }
        minScore = (float) store.manifest.optDouble("minScore", 0.18);
        margin = (float) store.manifest.optDouble("margin", 0.06);
        name = store.manifest.optString("model", "CLIP");
        try {
            OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
            opts.setIntraOpNumThreads(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1)));
            vision = env.createSession(store.file("vision").getAbsolutePath(), opts);
            text = env.createSession(store.file("text").getAbsolutePath(), opts);
        } catch (OrtException e) {
            throw new IOException("could not load CLIP: " + e.getMessage(), e);
        }
    }

    /** Decode only as much of the file as needed (≈512 px), then embed. Null when the bytes are not an image. */
    public @Nullable float[] embedImage(InputStream in) throws IOException {
        byte[] bytes = in.readAllBytes();
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int sample = 1;
        while (Math.min(o.outWidth, o.outHeight) / (sample * 2) >= SIZE * 2) sample *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = sample;
        o2.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o2);
        if (bmp == null) return null;
        try { return embedBitmap(bmp); } finally { bmp.recycle(); }
    }

    public float[] embedBitmap(Bitmap src) throws IOException {
        // Shortest edge to SIZE, then center crop — same as CLIPFeatureExtractor.
        float scale = (float) SIZE / Math.min(src.getWidth(), src.getHeight());
        int w = Math.max(SIZE, Math.round(src.getWidth() * scale)), h = Math.max(SIZE, Math.round(src.getHeight() * scale));
        Bitmap scaled = Bitmap.createScaledBitmap(src, w, h, true);
        Bitmap crop = Bitmap.createBitmap(scaled, (w - SIZE) / 2, (h - SIZE) / 2, SIZE, SIZE, (Matrix) null, false);
        int[] px = new int[SIZE * SIZE];
        crop.getPixels(px, 0, SIZE, 0, 0, SIZE, SIZE);
        if (scaled != src) scaled.recycle();
        if (crop != scaled) crop.recycle();
        float[] chw = new float[3 * SIZE * SIZE];
        for (int i = 0; i < px.length; i++) {
            int p = px[i];
            chw[i] = ((p >> 16) & 0xFF) / 255f;
            chw[SIZE * SIZE + i] = ((p >> 8) & 0xFF) / 255f;
            chw[2 * SIZE * SIZE + i] = (p & 0xFF) / 255f;
        }
        try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(chw), new long[]{1, 3, SIZE, SIZE});
             OrtSession.Result r = vision.run(Collections.singletonMap("pixel_values", t))) {
            return normalize(((float[][]) r.get(0).getValue())[0]);
        } catch (OrtException e) {
            throw new IOException("vision inference failed: " + e.getMessage(), e);
        }
    }

    /** Embed a sentence; cached, since the same query is asked against many photos. */
    public float[] embedText(String sentence) throws IOException {
        float[] hit = textCache.get(sentence);
        if (hit != null) return hit;
        long[] ids = tokenizer.encode(sentence);
        try (OnnxTensor t = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), new long[]{1, ids.length});
             OrtSession.Result r = text.run(Collections.singletonMap("input_ids", t))) {
            float[] v = normalize(((float[][]) r.get(0).getValue())[0]);
            textCache.put(sentence, v);
            return v;
        } catch (OrtException e) {
            throw new IOException("text inference failed: " + e.getMessage(), e);
        }
    }

    private volatile float[][] labelVecs;

    /** Text vectors of {@link SceneLabels#VOCAB}; ~90 text passes the first time, so warm it off the ask path. */
    public float[][] labelVectors() throws IOException {
        float[][] l = labelVecs;
        if (l != null) return l;
        synchronized (this) {
            if (labelVecs == null) {
                float[][] v = new float[SceneLabels.VOCAB.length][];
                for (int i = 0; i < v.length; i++) v[i] = embedText(SceneLabels.prompt(SceneLabels.VOCAB[i]));
                labelVecs = v;
            }
            return labelVecs;
        }
    }

    public static float dot(float[] a, float[] b) {
        float s = 0;
        for (int i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    static float[] normalize(float[] v) {
        double n = 0;
        for (float x : v) n += x * x;
        float inv = (float) (1 / Math.max(Math.sqrt(n), 1e-9));
        for (int i = 0; i < v.length; i++) v[i] *= inv;
        return v;
    }

    @Override public void close() {
        try { vision.close(); text.close(); } catch (OrtException ignored) { }
    }
}
