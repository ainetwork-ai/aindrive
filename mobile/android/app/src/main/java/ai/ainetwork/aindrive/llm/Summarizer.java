package ai.ainetwork.aindrive.llm;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.clip.ModelStore;

import com.google.ai.edge.litertlm.Backend;
import com.google.ai.edge.litertlm.Content;
import com.google.ai.edge.litertlm.Contents;
import com.google.ai.edge.litertlm.Conversation;
import com.google.ai.edge.litertlm.ConversationConfig;
import com.google.ai.edge.litertlm.Engine;
import com.google.ai.edge.litertlm.EngineConfig;
import com.google.ai.edge.litertlm.Message;
import com.google.ai.edge.litertlm.SamplerConfig;
import com.google.ai.edge.litertlm.ThinkingConfig;

import java.io.IOException;
import java.util.Collections;
import java.util.List;

/**
 * The one place an LLM runs on the phone, used ONLY to turn text the device
 * already produced (call transcripts) into a few sentences. Search never
 * goes through it — the index answers searches — so it is optional: without
 * the model the call report falls back to topic words.
 *
 * Runtime: Google's LiteRT-LM (`.litertlm` bundles — Gemma 4 E2B by default;
 * Qwen3.5 works too). MediaPipe's older `.task` path was dropped: its
 * byte-level decoding garbled Korean. Loaded lazily, one instance, released
 * after a report so the service stays small.
 */
public final class Summarizer implements AutoCloseable {
    private static final String TAG = "AindriveLlm";
    private static final int MAX_TOKENS = 4096;
    /** Per-person budget for transcript text, in characters (Korean ≈ 1 token per 1.5 chars). */
    public static final int EXCERPT_CHARS = 3200;

    public final String engine, name;
    private @Nullable Engine litert;

    public Summarizer(Context ctx, ModelStore store) throws IOException {
        engine = store.manifest.optString("engine", "litert-lm");
        name = store.manifest.optString("model", engine);
        String path = store.file("model").getAbsolutePath();
        try {
            int threads = Math.max(2, Math.min(6, Runtime.getRuntime().availableProcessors() - 2));
            EngineConfig cfg = new EngineConfig(path, new Backend.CPU(threads, null), null, null, MAX_TOKENS, null, ctx.getCacheDir().getAbsolutePath());
            litert = new Engine(cfg);
            litert.initialize();
        } catch (RuntimeException e) {
            throw new IOException("could not load the summariser (" + name + "): " + e.getMessage(), e);
        }
    }

    /**
     * "What do I usually talk about with this person?" from transcript
     * excerpts (newest first). Returns null when the model produced nothing usable.
     */
    public @Nullable String callsWith(String person, List<String> excerpts, boolean korean) {
        StringBuilder text = new StringBuilder();
        int per = Math.max(400, EXCERPT_CHARS / Math.max(1, excerpts.size()));
        for (int i = 0; i < excerpts.size(); i++) {
            String t = excerpts.get(i).trim();
            if (t.length() > per) t = t.substring(0, per) + "…";
            text.append(korean ? "[통화 " : "[Call ").append(i + 1).append("]\n").append(t).append("\n\n");
        }
        String system = korean
                ? "당신은 통화 녹취를 읽고 핵심만 정리하는 비서입니다. 녹취는 음성 인식 결과라 오타와 끊김이 있습니다. 추측하지 말고 녹취에 있는 내용만 쓰세요."
                : "You are an assistant who reads call transcripts and states the gist. Transcripts come from speech recognition and contain errors. Do not guess; use only what is in the text.";
        String user = korean
                ? "다음은 나와 \"" + person + "\"의 최근 통화 녹취 발췌입니다.\n\n" + text
                  + "이 사람과 주로 어떤 이야기를 나누는지 2~3문장으로 요약하세요. 구체적인 주제(예: 투자 조건, 일정, 제품)를 언급하고, 한국어로 답하세요. 서론 없이 요약만 쓰세요."
                : "Below are excerpts of my recent calls with \"" + person + "\".\n\n" + text
                  + "In 2–3 sentences, summarise what we usually talk about. Name the concrete subjects (e.g. investment terms, schedules, a product). Answer in English, summary only, no preamble.";
        return generate(system, user, person);
    }

    /** One prompt, one answer; null when nothing usable came back. */
    public @Nullable String generate(String system, String user, String what) {
        try {
            String out;
            {
                ConversationConfig cc = new ConversationConfig(Contents.Companion.of(system), Collections.emptyList(), Collections.emptyList(),
                        new SamplerConfig(20, 0.9, 0.2, 7), false, Collections.emptyList(), Collections.emptyMap(), null, false, 400,
                        new ThinkingConfig(false), false);
                try (Conversation c = litert.createConversation(cc)) {
                    Message m = c.sendMessage(user);
                    StringBuilder sb = new StringBuilder();
                    for (Content part : m.getContents().getContents()) if (part instanceof Content.Text) sb.append(((Content.Text) part).getText());
                    out = sb.toString();
                }
            }
            if (out == null) return null;
            out = out.replaceAll("(?s)<think>.*?</think>", "").trim();
            // A model that echoes the instruction or gives up is worse than the topic words.
            if (out.length() < 12 || out.startsWith("[") || out.contains("<|im_start|>")) return null;
            return out;
        } catch (RuntimeException e) {
            Log.w(TAG, "generation failed for " + what + ": " + e.getMessage());
            return null;
        }
    }

    @Override public void close() {
        if (litert != null) { try { litert.close(); } catch (Exception ignored) { } litert = null; }
    }
}
