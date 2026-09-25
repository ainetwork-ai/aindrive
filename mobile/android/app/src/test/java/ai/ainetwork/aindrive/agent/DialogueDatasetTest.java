package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * The aindrive dialogue benchmark (test/resources/dialogues/, made by
 * scripts/make-dialogues.py): DSTC8-style multi-turn dialogues about the
 * phone's files, each user turn annotated with route, intent and the full
 * dialogue state. Every dialogue is replayed through Router.understand — the
 * code the app runs — with the context carried turn to turn as the shell does.
 *
 * Metrics, as in DSTC8 track 4:
 *  - route / intent accuracy over all turns;
 *  - per-slot accuracy and JOINT GOAL ACCURACY (every slot right) over file turns;
 *  - dialogue success: every turn of the dialogue right.
 * `dev` is what the parser is tuned on; `test` has unseen phrasings and values.
 */
public class DialogueDatasetTest {
    /** Floors: raise them as the agent improves; a regression fails the build. */
    static final double MIN_JGA_DEV = 0.99, MIN_JGA_TEST = 0.99, MIN_JGA_HOLDOUT = 0.97, MIN_INTENT = 0.99, MIN_ROUTE = 0.99;

    static QueryParser parser;
    static final String[] SLOTS = {"kind", "city", "country", "date_from", "date_to", "content", "limit", "oldest", "largest"};

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { parser = new QueryParser(GeoLookup.loadGzip(in)); }
    }

    @Test public void dev() throws Exception { run("dev", MIN_JGA_DEV); }

    @Test public void test() throws Exception { run("test", MIN_JGA_TEST); }

    /**
     * Written after dev/test were tuned, with fresh phrasings and places. Its first score (JGA 0.358) exposed the
     * stop-word approach to content words and led to the grammar-based one; the fixes were general, but it has
     * now been looked at — write a new holdout for the next honest number.
     */
    @Test public void holdout() throws Exception { run("holdout", MIN_JGA_HOLDOUT); }

    static final class Score {
        int turns, route, intent, fileTurns, joint, dialogues, success;
        final Map<String, Integer> slotRight = new LinkedHashMap<>();
        final Map<String, List<String>> misses = new TreeMap<>();
        void miss(String what, String line) { misses.computeIfAbsent(what, k -> new ArrayList<>()).add(line); }
    }

    private void run(String split, double minJga) throws Exception {
        JSONObject data;
        try (InputStream in = getClass().getResourceAsStream("/dialogues/" + split + ".json")) {
            data = new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
        long now = AskScenariosTest.at(data.getString("today")) + 12L * 3600 * 1000;   // noon "today"
        Score s = new Score();
        for (String k : SLOTS) s.slotRight.put(k, 0);
        JSONArray dialogues = data.getJSONArray("dialogues");
        for (int i = 0; i < dialogues.length(); i++) {
            JSONObject dlg = dialogues.getJSONObject(i);
            JSONArray turns = dlg.getJSONArray("turns");
            JSONObject context = null;
            boolean allRight = true;
            List<String> transcript = new ArrayList<>();
            for (int j = 0; j < turns.length(); j++) {
                JSONObject want = turns.getJSONObject(j);
                String u = want.getString("utterance");
                Router.Turn got = Router.understand(parser, u, now, context);
                context = got.nextContext;
                s.turns++;
                String route = got.route.name().toLowerCase(Locale.ROOT);
                boolean routeOk = route.equals(want.getString("route"));
                boolean intentOk = got.intent.equals(want.getString("intent"));
                if (routeOk) s.route++; else s.miss("route " + want.getString("route") + "→" + route, ctx(transcript, u));
                if (intentOk) s.intent++; else if (routeOk) s.miss("intent " + want.getString("intent") + "→" + got.intent, ctx(transcript, u));
                boolean ok = routeOk && intentOk;
                if (want.getString("route").equals("files") && !want.isNull("state")) {
                    s.fileTurns++;
                    Map<String, String> w = wantState(want.getJSONObject("state")), g = gotState(got.query);
                    boolean joint = intentOk;
                    for (String k : SLOTS) {
                        if (w.get(k).equals(g.get(k))) s.slotRight.merge(k, 1, Integer::sum);
                        else { joint = false; s.miss("slot " + k, ctx(transcript, u) + "\n      want " + w.get(k) + "  got " + g.get(k)); }
                    }
                    if (joint) s.joint++;
                    ok &= joint;
                }
                if (want.getString("route").equals("calls") && want.optBoolean("share") && (got.query == null || !got.query.share)) {
                    ok = false; s.miss("calls share", ctx(transcript, u));
                }
                allRight &= ok;
                transcript.add(u);
            }
            s.dialogues++;
            if (allRight) s.success++;
        }
        StringBuilder r = new StringBuilder();
        r.append(String.format(Locale.US, "%n== %s: %d dialogues, %d turns (%d file turns)%n", split, s.dialogues, s.turns, s.fileTurns));
        r.append(String.format(Locale.US, "route %.4f  intent %.4f  JGA %.4f  dialogue success %.4f%n",
                (double) s.route / s.turns, (double) s.intent / s.turns, (double) s.joint / s.fileTurns, (double) s.success / s.dialogues));
        for (String k : SLOTS) r.append(String.format(Locale.US, "  %-9s %.4f%n", k, (double) s.slotRight.get(k) / s.fileTurns));
        for (Map.Entry<String, List<String>> e : s.misses.entrySet()) {
            r.append(String.format(Locale.US, "-- %s: %d%n", e.getKey(), e.getValue().size()));
            List<String> ex = e.getValue();
            for (int i = 0; i < Math.min(12, ex.size()); i++) r.append("   ").append(ex.get(i)).append('\n');
        }
        System.out.println(r);
        java.nio.file.Files.write(java.nio.file.Paths.get("build", "dialogue-report-" + split + ".txt"), r.toString().getBytes(StandardCharsets.UTF_8));
        double jga = (double) s.joint / s.fileTurns;
        if (minJga > 0) assertTrue(r.toString(), jga >= minJga && (double) s.intent / s.turns >= MIN_INTENT && (double) s.route / s.turns >= MIN_ROUTE);
    }

    private static String ctx(List<String> before, String u) {
        return (before.isEmpty() ? "" : "[" + String.join(" / ", before.subList(Math.max(0, before.size() - 2), before.size())) + "] ") + "» " + u;
    }

    private static Map<String, String> wantState(JSONObject st) {
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

    private static Map<String, String> gotState(SearchQuery q) {
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

    private static String str(JSONObject o, String k) { return o.isNull(k) ? "-" : o.optString(k); }

    private static String dash(String s) { return s == null ? "-" : s; }

    /** "Receipts" / "receipt", "Flowers" / "flower": content is compared case- and plural-blind. */
    static String norm(String w) {
        String s = w.toLowerCase(Locale.ROOT);
        if (s.endsWith("ies") && s.length() > 4) return s.substring(0, s.length() - 3) + "y";
        if (s.endsWith("es") && (s.endsWith("ches") || s.endsWith("shes") || s.endsWith("xes"))) return s.substring(0, s.length() - 2);
        if (s.endsWith("s") && !s.endsWith("ss") && s.length() > 3) return s.substring(0, s.length() - 1);
        return s;
    }
}
