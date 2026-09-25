package ai.ainetwork.aindrive.llm;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.clip.ModelStore;

import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;

import java.io.IOException;
import java.util.List;

/**
 * The one place an LLM runs on the phone: a small instruct model (Qwen2.5
 * 1.5B, 8-bit) on MediaPipe's LLM Inference, used ONLY to turn text the
 * device already produced (call transcripts) into a few sentences. Search
 * never goes through it — the index answers searches — so it is optional:
 * without the model the call report falls back to topic words.
 *
 * Memory: the model is ~1.6 GB mapped; loaded lazily, one instance, and
 * released after a report so the foreground service stays small.
 */
public final class Summarizer implements AutoCloseable {
    private static final String TAG = "AindriveLlm";
    /** Model context (prompt + answer). The bundle's KV cache is 4096. */
    private static final int MAX_TOKENS = 4096;
    /** Per-person budget for transcript text, in characters (Korean ≈ 1 token per 1.5 chars). */
    public static final int EXCERPT_CHARS = 3200;

    private final LlmInference llm;

    public Summarizer(Context ctx, ModelStore store) throws IOException {
        try {
            llm = LlmInference.createFromOptions(ctx, LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(store.file("model").getAbsolutePath())
                    .setMaxTokens(MAX_TOKENS)
                    .setMaxTopK(40)
                    .build());
        } catch (RuntimeException e) {
            throw new IOException("could not load the summariser: " + e.getMessage(), e);
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
        String prompt = "<|im_start|>system\n" + system + "<|im_end|>\n<|im_start|>user\n" + user + "<|im_end|>\n<|im_start|>assistant\n";
        try (LlmInferenceSession s = LlmInferenceSession.createFromOptions(llm, LlmInferenceSession.LlmInferenceSessionOptions.builder()
                .setTemperature(0.2f).setTopK(20).setTopP(0.9f).setRandomSeed(7).build())) {
            s.addQueryChunk(prompt);
            String out = s.generateResponse();
            if (out == null) return null;
            out = out.replace("<|im_end|>", "").trim();
            // A model that echoes the instruction or gives up is worse than the topic words.
            if (out.length() < 12 || out.startsWith("[") || out.contains("<|im_start|>")) return null;
            return out;
        } catch (RuntimeException e) {
            Log.w(TAG, "summary failed for " + person + ": " + e.getMessage());
            return null;
        }
    }

    @Override public void close() { llm.close(); }
}
