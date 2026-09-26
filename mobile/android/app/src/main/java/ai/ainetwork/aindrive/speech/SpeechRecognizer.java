package ai.ainetwork.aindrive.speech;

import android.content.Context;

import org.json.JSONObject;

import java.io.FileDescriptor;
import java.io.IOException;

import ai.ainetwork.aindrive.clip.ModelStore;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineQwen3AsrModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig;
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;

/**
 * Speech → text on the phone, via sherpa-onnx. Which model is used comes from
 * the manifest (assets/speech/models.json, `engine`: "whisper" | "transducer"
 * | "sense-voice"); the files themselves are downloaded on first use.
 *
 * Long recordings are transcribed in windows (Whisper is trained on 30 s
 * clips and truncates beyond it; CTC/transducer models don't mind but the
 * memory does), and the windows are joined with a space — good enough for
 * "which recording talked about the budget", which is all search needs.
 */
public final class SpeechRecognizer implements AutoCloseable {
    /** Seconds of audio transcribed per file at most; the rest is skipped. */
    public static final int MAX_SECONDS = 15 * 60;
    private static final int WINDOW_SECONDS = 28;

    private final OfflineRecognizer recognizer;
    public final String engine;

    public SpeechRecognizer(Context ctx, ModelStore store) throws IOException {
        JSONObject m = store.manifest;
        engine = m.optString("engine", "whisper");
        OfflineModelConfig model = new OfflineModelConfig();
        if (store.has("tokens")) model.setTokens(store.file("tokens").getAbsolutePath());
        // Big cores only matter here; leave two for the UI and the socket.
        model.setNumThreads(Math.max(2, Math.min(6, Runtime.getRuntime().availableProcessors() - 2)));
        model.setDebug(false);
        model.setProvider("cpu");
        switch (engine) {
            case "whisper": {
                OfflineWhisperModelConfig w = new OfflineWhisperModelConfig();
                w.setEncoder(store.file("encoder").getAbsolutePath());
                w.setDecoder(store.file("decoder").getAbsolutePath());
                w.setLanguage(m.optString("language", ""));   // "" = detect per clip
                w.setTask("transcribe");
                w.setTailPaddings(-1);
                model.setWhisper(w);
                model.setModelType("whisper");
                break;
            }
            case "transducer": {
                OfflineTransducerModelConfig t = new OfflineTransducerModelConfig();
                t.setEncoder(store.file("encoder").getAbsolutePath());
                t.setDecoder(store.file("decoder").getAbsolutePath());
                t.setJoiner(store.file("joiner").getAbsolutePath());
                model.setTransducer(t);
                model.setModelType("transducer");
                break;
            }
            case "sense-voice": {
                OfflineSenseVoiceModelConfig s = new OfflineSenseVoiceModelConfig();
                s.setModel(store.file("model").getAbsolutePath());
                s.setLanguage(m.optString("language", "auto"));
                s.setUseInverseTextNormalization(true);
                model.setSenseVoice(s);
                model.setModelType("sense_voice");
                break;
            }
            case "qwen3-asr": {
                // Qwen3-ASR: conv front-end + encoder + LLM decoder; the tokenizer is a directory next to them.
                OfflineQwen3AsrModelConfig q = new OfflineQwen3AsrModelConfig();
                q.setConvFrontend(store.file("frontend").getAbsolutePath());
                q.setEncoder(store.file("encoder").getAbsolutePath());
                q.setDecoder(store.file("decoder").getAbsolutePath());
                q.setTokenizer(store.file("tokenizer").getParentFile().getAbsolutePath());
                q.setMaxNewTokens(m.optInt("maxNewTokens", 512));
                q.setTemperature(0f);
                model.setQwen3Asr(q);
                model.setModelType("qwen3_asr");
                break;
            }
            default: throw new IOException("unknown speech engine " + engine);
        }
        FeatureConfig feat = new FeatureConfig();
        feat.setSampleRate(AudioDecoder.TARGET_RATE);
        feat.setFeatureDim(80);
        OfflineRecognizerConfig cfg = new OfflineRecognizerConfig();
        cfg.setFeatConfig(feat);
        cfg.setModelConfig(model);
        cfg.setDecodingMethod("greedy_search");
        // Files live on disk, not in assets → assetManager null.
        recognizer = new OfflineRecognizer(null, cfg);
    }

    public static final class Transcript {
        public final String text;
        public final double durationSec;
        public final boolean truncated;
        Transcript(String t, double d, boolean tr) { text = t; durationSec = d; truncated = tr; }
    }

    /** Null when the file has no audio track. */
    public Transcript transcribe(FileDescriptor fd) throws IOException { return transcribe(fd, MAX_SECONDS); }

    /** Same, hearing at most `maxSeconds` — a quick look at a long call. */
    /** Synchronized: the call archive and other folders may share this recogniser from two workers. */
    public synchronized Transcript transcribe(FileDescriptor fd, int maxSeconds) throws IOException {
        AudioDecoder.Pcm pcm = AudioDecoder.decode(fd, Math.min(maxSeconds, MAX_SECONDS));
        if (pcm == null) return null;
        StringBuilder sb = new StringBuilder();
        int win = WINDOW_SECONDS * AudioDecoder.TARGET_RATE;
        for (int off = 0; off < pcm.samples.length; off += win) {
            int n = Math.min(win, pcm.samples.length - off);
            if (n < AudioDecoder.TARGET_RATE / 2) break;   // < 0.5 s of tail: nothing to hear
            float[] chunk = new float[n];
            System.arraycopy(pcm.samples, off, chunk, 0, n);
            OfflineStream s = recognizer.createStream();
            try {
                s.acceptWaveform(chunk, AudioDecoder.TARGET_RATE);
                recognizer.decode(s);
                OfflineRecognizerResult r = recognizer.getResult(s);
                String t = r.getText().trim();
                if (!t.isEmpty()) sb.append(sb.length() > 0 ? " " : "").append(t);
            } finally {
                s.release();
            }
        }
        return new Transcript(sb.toString(), pcm.durationSec, pcm.truncated);
    }

    @Override public void close() { recognizer.release(); }
}
