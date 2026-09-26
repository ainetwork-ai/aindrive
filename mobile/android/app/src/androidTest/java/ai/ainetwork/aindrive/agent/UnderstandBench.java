package ai.ainetwork.aindrive.agent;

import android.content.Context;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import ai.ainetwork.aindrive.clip.ModelStore;
import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.llm.Summarizer;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * On-device: the LLM-understanding path with the real Gemma 4 E2B, for the numbers the spec asks
 * before merge — (1) wall-clock per model call, (2) rules-only vs hybrid on
 * {@code files/bench/llm-holdout.json} (pushed with adb; the dialogue benchmark's format), with the
 * same route / intent / joint-goal scoring as DialogueDatasetTest. Report only, nothing asserted:
 * it is read, not gated. Run: {@code ./gradlew connectedDebugAndroidTest
 * -Pandroid.testInstrumentationRunnerArguments.class=ai.ainetwork.aindrive.agent.UnderstandBench}.
 */
@RunWith(AndroidJUnit4.class)
public class UnderstandBench {
    static final String TAG = "UnderstandBench";
    static final String[] SLOTS = {"kind", "city", "country", "date_from", "date_to", "content", "limit", "oldest", "largest"};

    @Test public void run() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        StringBuilder report = new StringBuilder();
        GeoLookup geo;
        // The build strips .gz from assets: geo/cities.tsv.gz is read back as geo/cities.tsv (see AgentService).
        try (InputStream in = ctx.getAssets().open("geo/cities.tsv")) { geo = GeoLookup.load(in); }
        QueryParser parser = new QueryParser(geo);
        ModelStore store = new ModelStore(ctx, "llm/gemma-4-e2b.json");
        if (!store.ready()) { say(report, "model not downloaded"); write(ctx, report); return; }
        android.os.Bundle args = InstrumentationRegistry.getArguments();
        boolean gpu = "true".equals(args.getString("gpu"));
        boolean rawOnly = "true".equals(args.getString("rawOnly"));
        // Speed knobs, tried in order on the S21+: GPU backend; a shorter output (only `route` required, fewer tokens); a shorter user prompt.
        int maxTokens = args.getString("maxTokens") == null ? Understander.MAX_TOKENS : Integer.parseInt(args.getString("maxTokens"));
        boolean shortSchema = "true".equals(args.getString("shortSchema"));
        boolean compact = "true".equals(args.getString("compact"));
        String schema = shortSchema ? Understander.SCHEMA.replace("\"required\":[\"route\",\"kind\",\"place\",\"when\",\"content\",\"task\",\"limit\",\"oldest\",\"largest\"]", "\"required\":[\"route\"]") : Understander.SCHEMA;
        List<String[]> shots = new ArrayList<>();
        for (String[] e : Understander.FEW_SHOT) shots.add(compact ? new String[]{e[0].replace("Previous search: none\nMessage: ", ""), e[1]} : e);
        say(report, String.format(Locale.US, "config gpu=%b maxTokens=%d shortSchema=%b compact=%b fewShot=%d", gpu, maxTokens, shortSchema, compact, shots.size()));
        long t0 = System.currentTimeMillis();
        try (Summarizer llm = new Summarizer(ctx, store, gpu)) {
            say(report, "model load " + (System.currentTimeMillis() - t0) + "ms (" + (gpu ? "GPU" : "CPU") + ")");
            // 1. Raw calls with the few-shot prompt: route and timing per probe; the first call also pays for the examples' prefill.
            String[] probes = {"anything from Sam's wedding?", "show me the stuff from the Jeju trip last spring", "이번 여름에 부산에서 찍은 거 보여줘", "the slides at the park", "book a table for 4 in Jeju", "what's in this folder?", "how many recordings with the bank"};
            List<Long> rawMs = new ArrayList<>();
            for (String q : probes) {
                long t = System.currentTimeMillis();
                String user = compact ? q : Understander.userPrompt(q, null);
                String out = llm.json(Understander.SYSTEM, shots, user, schema, maxTokens);
                long ms = System.currentTimeMillis() - t;
                rawMs.add(ms);
                org.json.JSONObject o = out == null ? null : Understander.firstObject(out);
                say(report, String.format(Locale.US, "raw %dms route=%s  %s  ->  %s", ms, o == null ? "?" : o.optString("route"), q, out == null ? "null" : out.replace('\n', ' ')));
            }
            say(report, "raw per-call ms: " + pct(rawMs));
            // 2. The holdout, rules-only vs hybrid.
            File f = new File(new File(ctx.getFilesDir(), "bench"), "llm-holdout.json");
            if (rawOnly || !f.exists()) { say(report, "no " + f); write(ctx, report); return; }
            JSONObject data = new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            long now = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(data.getString("today")).getTime() + 12L * 3600 * 1000;
            // Score the model, not the phone's clock: a 30 s budget, and the same knobs as the raw probes.
            final String sch = schema; final List<String[]> sh = shots; final int mt = maxTokens;
            Understander und = new Understander(geo, new Understander.Model() {
                @Override public String complete(String system, List<String[]> examples, String user, String jsonSchema) { return llm.json(system, sh, user, sch, mt); }
                @Override public void cancel() { llm.cancel(); }
            }, 30_000);
            Score rules = new Score(), hybrid = new Score();
            List<Long> asked = new ArrayList<>();
            int askedTurns = 0, replaced = 0;
            JSONArray dialogues = data.getJSONArray("dialogues");
            for (int i = 0; i < dialogues.length(); i++) {
                JSONArray turns = dialogues.getJSONObject(i).getJSONArray("turns");
                JSONObject ctxR = null, ctxH = null;
                for (int j = 0; j < turns.length(); j++) {
                    JSONObject want = turns.getJSONObject(j);
                    String u = want.getString("utterance");
                    Router.Turn r = Router.understand(parser, u, now, ctxR);
                    Router.Turn h0 = Router.understand(parser, u, now, ctxH);
                    Router.Turn h = h0;
                    if (UnderstandTrigger.unsure(h0, h0.query != null ? h0.query : h0.parsed)) {
                        askedTurns++;
                        long t = System.currentTimeMillis();
                        Router.Turn m = und.understand(u, now, ctxH, h0);
                        asked.add(System.currentTimeMillis() - t);
                        if (m != null) { h = m; replaced++; }
                    }
                    ctxR = r.nextContext; ctxH = h.nextContext;
                    rules.add(want, r, u, null);
                    hybrid.add(want, h, u, h != h0 ? "model" : null);
                }
            }
            say(report, String.format(Locale.US, "holdout: %d dialogues, %d turns, %d file turns; model asked on %d turns, answer replaced on %d",
                    dialogues.length(), rules.turns, rules.fileTurns, askedTurns, replaced));
            say(report, "rules-only: " + rules.line());
            say(report, "hybrid:     " + hybrid.line());
            if (!asked.isEmpty()) say(report, "model-asked turn ms: " + pct(asked));
            for (Map.Entry<String, List<String>> e : hybrid.misses.entrySet()) {
                say(report, "-- hybrid miss " + e.getKey() + ": " + e.getValue().size());
                for (int k = 0; k < Math.min(8, e.getValue().size()); k++) say(report, "   " + e.getValue().get(k));
            }
        }
        write(ctx, report);
    }

    static void say(StringBuilder r, String s) { Log.i(TAG, s); r.append(s).append('\n'); }

    static String pct(List<Long> ms) {
        List<Long> v = new ArrayList<>(ms); Collections.sort(v);
        return String.format(Locale.US, "n=%d p50 %d  p95 %d  max %d", v.size(), v.get(v.size() / 2), v.get((int) Math.min(v.size() - 1, Math.floor(v.size() * 0.95))), v.get(v.size() - 1));
    }

    static void write(Context ctx, StringBuilder r) throws Exception {
        File dir = new File(ctx.getFilesDir(), "bench"); dir.mkdirs();
        Files.write(new File(dir, "report.txt").toPath(), r.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** DialogueDatasetTest's metrics, copied (the unit-test source set is not visible here). */
    static final class Score {
        int turns, route, intent, fileTurns, joint;
        final Map<String, List<String>> misses = new java.util.TreeMap<>();
        void add(JSONObject want, Router.Turn got, String u, String via) {
            turns++;
            boolean routeOk = got.route.name().toLowerCase(Locale.ROOT).equals(want.optString("route"));
            boolean intentOk = got.intent.equals(want.optString("intent"));
            if (routeOk) route++; else miss("route " + want.optString("route") + "→" + got.route, u, via);
            if (intentOk) intent++; else if (routeOk) miss("intent " + want.optString("intent") + "→" + got.intent, u, via);
            if ("files".equals(want.optString("route")) && !want.isNull("state")) {
                fileTurns++;
                Map<String, String> w = wantState(want.optJSONObject("state")), g = gotState(got.query);
                boolean j = intentOk;
                for (String k : SLOTS) if (!w.get(k).equals(g.get(k))) { j = false; miss("slot " + k, u + "  want " + w.get(k) + "  got " + g.get(k), via); }
                if (j) joint++;
            }
        }
        void miss(String what, String line, String via) { misses.computeIfAbsent(what, k -> new ArrayList<>()).add((via == null ? "" : "[" + via + "] ") + line); }
        String line() {
            return String.format(Locale.US, "route %.4f  intent %.4f  JGA %.4f", (double) route / turns, (double) intent / turns, fileTurns == 0 ? 0 : (double) joint / fileTurns);
        }
    }

    static Map<String, String> wantState(JSONObject st) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("kind", str(st, "kind")); m.put("city", str(st, "city")); m.put("country", str(st, "country"));
        m.put("date_from", str(st, "date_from")); m.put("date_to", str(st, "date_to"));
        List<String> c = new ArrayList<>();
        JSONArray a = st.optJSONArray("content");
        if (a != null) for (int i = 0; i < a.length(); i++) for (String w : a.optString(i).split("\\s+")) c.add(norm(w));
        Collections.sort(c);
        m.put("content", c.toString());
        m.put("limit", String.valueOf(st.optInt("limit")));
        m.put("oldest", String.valueOf(st.optBoolean("oldest")));
        m.put("largest", String.valueOf(st.optBoolean("largest")));
        return m;
    }

    static Map<String, String> gotState(SearchQuery q) {
        Map<String, String> m = new LinkedHashMap<>();
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        m.put("kind", q == null ? "-" : dash(q.kind)); m.put("city", q == null ? "-" : dash(q.city)); m.put("country", q == null ? "-" : dash(q.country));
        m.put("date_from", q == null || q.dateFrom == null ? "-" : f.format(q.dateFrom));
        m.put("date_to", q == null || q.dateTo == null ? "-" : f.format(q.dateTo));
        List<String> c = new ArrayList<>();
        if (q != null) for (String k : QueryParser.contentWords(q.keywords)) c.add(norm(k));
        Collections.sort(c);
        m.put("content", c.toString());
        m.put("limit", String.valueOf(q == null ? 0 : q.limit));
        m.put("oldest", String.valueOf(q != null && q.oldestFirst));
        m.put("largest", String.valueOf(q != null && q.bySize));
        return m;
    }

    static String str(JSONObject o, String k) { return o.isNull(k) ? "-" : o.optString(k); }
    static String dash(String s) { return s == null ? "-" : s; }
    static String norm(String w) {
        String s = w.toLowerCase(Locale.ROOT);
        if (s.endsWith("ies") && s.length() > 4) return s.substring(0, s.length() - 3) + "y";
        if (s.endsWith("es") && (s.endsWith("ches") || s.endsWith("shes") || s.endsWith("xes"))) return s.substring(0, s.length() - 2);
        if (s.endsWith("s") && !s.endsWith("ss") && s.length() > 3) return s.substring(0, s.length() - 1);
        return s;
    }
}
