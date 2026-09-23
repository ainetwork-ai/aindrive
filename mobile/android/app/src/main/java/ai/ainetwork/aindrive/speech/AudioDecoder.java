package ai.ainetwork.aindrive.speech;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import androidx.annotation.Nullable;

import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * First audio track of any container Android can read (m4a, mp3, ogg/opus,
 * wav, mp4/mkv video…) → 16 kHz mono float PCM, which is what the speech
 * model eats. Decoding is done by the platform codecs (hardware where
 * available); resampling is linear, which is fine for speech.
 *
 * `maxSeconds` bounds the work per file: a two-hour recording is transcribed
 * from its first N minutes, enough to know what the meeting was about.
 */
public final class AudioDecoder {
    public static final int TARGET_RATE = 16_000;

    public static final class Pcm {
        public final float[] samples;      // 16 kHz mono, [-1, 1]
        public final double durationSec;   // of the whole track, not just what was decoded
        public final boolean truncated;
        Pcm(float[] s, double d, boolean t) { samples = s; durationSec = d; truncated = t; }
    }

    /** Null when the file has no audio track. */
    public static @Nullable Pcm decode(FileDescriptor fd, int maxSeconds) throws IOException {
        MediaExtractor ex = new MediaExtractor();
        ex.setDataSource(fd);
        int track = -1; MediaFormat fmt = null;
        for (int i = 0; i < ex.getTrackCount(); i++) {
            MediaFormat f = ex.getTrackFormat(i);
            String mime = f.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) { track = i; fmt = f; break; }
        }
        if (track < 0 || fmt == null) { ex.release(); return null; }
        ex.selectTrack(track);
        double duration = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) / 1e6 : 0;
        MediaCodec codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
        codec.configure(fmt, null, null, 0);
        codec.start();

        FloatGrower out = new FloatGrower((int) Math.min(TARGET_RATE * (long) Math.max(1, maxSeconds), Integer.MAX_VALUE / 2));
        long maxFrames = (long) TARGET_RATE * maxSeconds;
        int rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE), channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        int pcmEncoding = 2; // AudioFormat.ENCODING_PCM_16BIT
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        boolean inputDone = false, outputDone = false, truncated = false;
        Resampler rs = new Resampler(rate, TARGET_RATE);
        try {
            while (!outputDone) {
                if (!inputDone) {
                    int idx = codec.dequeueInputBuffer(10_000);
                    if (idx >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(idx);
                        int n = buf == null ? -1 : ex.readSampleData(buf, 0);
                        if (n < 0) { codec.queueInputBuffer(idx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true; }
                        else { codec.queueInputBuffer(idx, 0, n, ex.getSampleTime(), 0); ex.advance(); }
                    }
                }
                int idx = codec.dequeueOutputBuffer(info, 10_000);
                if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (of.containsKey(MediaFormat.KEY_PCM_ENCODING)) pcmEncoding = of.getInteger(MediaFormat.KEY_PCM_ENCODING);
                    rs = new Resampler(rate, TARGET_RATE);
                } else if (idx >= 0) {
                    ByteBuffer buf = codec.getOutputBuffer(idx);
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset); buf.limit(info.offset + info.size);
                        buf.order(ByteOrder.nativeOrder());
                        float[] mono = toMono(buf, channels, pcmEncoding);
                        for (float s : rs.push(mono)) {
                            if (out.size >= maxFrames) { truncated = true; break; }
                            out.add(s);
                        }
                    }
                    codec.releaseOutputBuffer(idx, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0 || truncated) outputDone = true;
                }
            }
        } finally {
            try { codec.stop(); } catch (Exception ignored) { }
            codec.release();
            ex.release();
        }
        return new Pcm(out.toArray(), duration, truncated);
    }

    private static float[] toMono(ByteBuffer buf, int channels, int pcmEncoding) {
        if (pcmEncoding == 4) { // ENCODING_PCM_FLOAT
            int frames = buf.remaining() / 4 / channels;
            float[] m = new float[frames];
            for (int i = 0; i < frames; i++) { float s = 0; for (int c = 0; c < channels; c++) s += buf.getFloat(); m[i] = s / channels; }
            return m;
        }
        int frames = buf.remaining() / 2 / channels;
        float[] m = new float[frames];
        for (int i = 0; i < frames; i++) { float s = 0; for (int c = 0; c < channels; c++) s += buf.getShort() / 32768f; m[i] = s / channels; }
        return m;
    }

    /** Linear resampler that carries the fractional position across chunks. */
    private static final class Resampler {
        private final double step; private double pos = 0; private float last = 0; private boolean hasLast = false;
        Resampler(int from, int to) { step = (double) from / to; }
        float[] push(float[] in) {
            if (step == 1.0) return in;
            FloatGrower out = new FloatGrower((int) (in.length / step) + 2);
            // Virtual buffer = [last] + in, so interpolation can cross the chunk boundary.
            int n = in.length + (hasLast ? 1 : 0);
            while (pos < n - 1) {
                int i = (int) pos; double frac = pos - i;
                float a = sample(in, i), b = sample(in, i + 1);
                out.add((float) (a + (b - a) * frac));
                pos += step;
            }
            pos -= (n - 1);
            if (in.length > 0) { last = in[in.length - 1]; hasLast = true; }
            return out.toArray();
        }
        private float sample(float[] in, int i) { return hasLast ? (i == 0 ? last : in[i - 1]) : in[i]; }
    }

    private static final class FloatGrower {
        float[] a; int size = 0;
        FloatGrower(int cap) { a = new float[Math.max(16, cap)]; }
        void add(float v) { if (size == a.length) a = java.util.Arrays.copyOf(a, a.length * 2); a[size++] = v; }
        float[] toArray() { return java.util.Arrays.copyOf(a, size); }
    }
}
