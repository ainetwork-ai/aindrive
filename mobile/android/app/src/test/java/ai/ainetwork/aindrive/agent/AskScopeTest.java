package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;

/**
 * Phone protocol v2, host side of agent-ask: mode/root parsing, the root prefix
 * filter, and read-only gating (docs: mobile/README.md "agent-ask v2").
 */
public class AskScopeTest {
    static GeoLookup geo;

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { geo = GeoLookup.loadGzip(in); }
    }

    private static AskScope scope(String json) throws Exception { return AskScope.fromParams(new JSONObject(json)); }

    private static void refused(String json, String error) throws Exception {
        try { scope(json); fail("accepted " + json); }
        catch (IOException e) { assertEquals(error, e.getMessage()); }
    }

    // ------------------------------------------------------------ params

    @Test
    public void absentModeKeepsTodaysBehaviour() throws Exception {
        AskScope s = scope("{\"method\":\"agent-ask\",\"agentId\":\"agt_device\",\"query\":\"x\"}");
        assertFalse(s.readOnly);
        assertEquals("", s.root);
        assertFalse(scope("{\"mode\":null}").readOnly);
    }

    @Test
    public void modeIsReadOrActNothingElse() throws Exception {
        assertTrue(scope("{\"mode\":\"read\"}").readOnly);
        assertFalse(scope("{\"mode\":\"act\"}").readOnly);
        refused("{\"mode\":\"READ\"}", "bad_mode");
        refused("{\"mode\":\"delete\"}", "bad_mode");
        refused("{\"mode\":\"\"}", "bad_mode");
        refused("{\"mode\":1}", "bad_mode");
        refused("{\"mode\":true}", "bad_mode");
    }

    @Test
    public void contextIsAcceptedAndIgnored() throws Exception {
        AskScope s = scope("{\"mode\":\"read\",\"root\":\"Camera\",\"context\":{\"anything\":[1,2]}}");
        assertTrue(s.readOnly);
        assertEquals("Camera", s.root);
        assertEquals("", scope("{\"context\":\"not an object\"}").root);
    }

    @Test
    public void rootIsNormalizedLikeTheWebDoes() throws Exception {
        assertEquals("", scope("{\"root\":\"\"}").root);
        assertEquals("", scope("{\"root\":null}").root);
        assertEquals("", scope("{\"root\":\"/\"}").root);
        assertEquals("Camera/2026", scope("{\"root\":\"/Camera//2026/\"}").root);
        assertEquals("Camera/x", scope("{\"root\":\"./Camera/./x\"}").root);
        assertEquals("docs/.aindrive", scope("{\"root\":\"docs/.aindrive\"}").root);   // reserved only at the top
        String nfd = Normalizer.normalize("앨범/여름", Normalizer.Form.NFD);
        assertEquals(Normalizer.normalize("앨범/여름", Normalizer.Form.NFC), AskScope.fromParams(new JSONObject().put("root", nfd)).root);
    }

    @Test
    public void rootRefusesEscapesSystemPathsAndNonStrings() throws Exception {
        refused("{\"root\":\"..\"}", "bad_root");
        refused("{\"root\":\"a/../b\"}", "bad_root");
        refused("{\"root\":\".aindrive\"}", "bad_root");
        refused("{\"root\":\".aindrive/agents\"}", "bad_root");
        refused("{\"root\":\".AINDRIVE/uploads\"}", "bad_root");
        refused("{\"root\":\"/.Aindrive/\"}", "bad_root");
        refused("{\"root\":123}", "bad_root");
        refused("{\"root\":[\"Camera\"]}", "bad_root");
        try { AskScope.fromParams(new JSONObject().put("root", "a\0b")); fail("NUL accepted"); }
        catch (IOException e) { assertEquals("bad_root", e.getMessage()); }
        StringBuilder huge = new StringBuilder();
        while (huge.length() <= AskScope.MAX_ROOT_BYTES) huge.append("abcdefgh/");
        try { AskScope.fromParams(new JSONObject().put("root", huge.toString())); fail("huge root accepted"); }
        catch (IOException e) { assertEquals("bad_root", e.getMessage()); }
    }

    // ------------------------------------------------------------ root filter

    @Test
    public void insideIsTheRootOrBelowItExactly() {
        AskScope s = new AskScope(true, "Camera/2026");
        assertTrue(s.inside("Camera/2026"));
        assertTrue(s.inside("Camera/2026/IMG_1.jpg"));
        assertTrue(s.inside("Camera/2026/trip/IMG_2.jpg"));
        assertTrue(s.inside("/Camera/2026/IMG_1.jpg"));
        assertFalse(s.inside("Camera/20261/IMG_1.jpg"));   // a sibling that shares the prefix
        assertFalse(s.inside("Camera/IMG_0.jpg"));
        assertFalse(s.inside("Camera"));
        assertFalse(s.inside("camera/2026/IMG_1.jpg"));     // case matters
        assertFalse(s.inside(""));
        assertFalse(s.inside(null));
    }

    @Test
    public void insideComparesInNfc() {
        AskScope s = new AskScope(true, Normalizer.normalize("앨범", Normalizer.Form.NFC));
        assertTrue(s.inside(Normalizer.normalize("앨범/사진.jpg", Normalizer.Form.NFD)));
        assertTrue(s.inside(Normalizer.normalize("앨범/사진.jpg", Normalizer.Form.NFC)));
    }

    @Test
    public void systemPathsAreNeverInsideEvenForTheWholeDrive() {
        AskScope all = new AskScope(false, "");
        assertTrue(all.inside("anything/at/all.jpg"));
        assertFalse(all.inside(".aindrive/agents/agt_x.json"));
        assertFalse(all.inside(".AINDRIVE/config.json"));
        assertTrue(all.inside("docs/.aindrive/notes.md"));
    }

    @Test
    public void rootSpellingsCoverNfcAndNfd() {
        assertTrue(new AskScope(true, "").rootSpellings().isEmpty());
        assertEquals(List.of("Camera"), new AskScope(true, "Camera").rootSpellings());
        String nfc = Normalizer.normalize("앨범", Normalizer.Form.NFC);
        List<String> sp = new AskScope(true, nfc).rootSpellings();
        assertEquals(2, sp.size());
        assertTrue(sp.contains(nfc));
        assertTrue(sp.contains(Normalizer.normalize(nfc, Normalizer.Form.NFD)));
    }

    @Test
    public void collectStaysInsideTheRoot() {
        assertEquals("food photos 2026-09", AskScope.ACT_ALL.collectInto("food photos 2026-09"));
        assertEquals("Camera/2026/food photos 2026-09", new AskScope(false, "Camera/2026").collectInto("food photos 2026-09"));
    }

    @Test
    public void confineKeepsAResultThatIsAlreadyInside() throws Exception {
        AskScope s = new AskScope(true, "Camera");
        JSONObject r = new JSONObject().put("answer", "Found 2 photos taken in Tokyo.")
                .put("sources", new JSONArray().put(src("Camera/a.jpg")).put(src("Camera/b.jpg")))
                .put("action", new JSONObject().put("type", "count").put("count", 2));
        s.confine(r);
        assertEquals("Found 2 photos taken in Tokyo.", r.getString("answer"));
        assertEquals(2, r.getJSONArray("sources").length());
        assertEquals(2, r.getJSONObject("action").getInt("count"));
    }

    @Test
    public void confineDropsOutsideSourcesAndNeutralisesTheAnswer() throws Exception {
        AskScope s = new AskScope(true, "Camera");
        JSONObject r = new JSONObject().put("answer", "Found 3 photos: Private/secret.jpg …")
                .put("sources", new JSONArray().put(src("Camera/a.jpg")).put(src("Private/secret.jpg")).put(src(".aindrive/agents/agt_x.json")))
                .put("action", new JSONObject().put("type", "count").put("count", 3));
        s.confine(r);
        JSONArray kept = r.getJSONArray("sources");
        assertEquals(1, kept.length());
        assertEquals("Camera/a.jpg", kept.getJSONObject(0).getString("path"));
        assertEquals("Found 1 file in this folder.", r.getString("answer"));
        assertFalse(r.getString("answer").contains("secret"));
        assertEquals(1, r.getJSONObject("action").getInt("count"));
    }

    @Test
    public void confineFiltersActionFilesAndKeepsSkippedActions() throws Exception {
        AskScope s = new AskScope(false, "Camera");
        JSONObject r = new JSONObject().put("answer", "Nothing.").put("sources", new JSONArray())
                .put("action", new JSONObject().put("type", "delete").put("pending", true)
                        .put("files", new JSONArray().put("Camera/a.jpg").put("Other/b.jpg")));
        s.confine(r);
        assertEquals("Nothing.", r.getString("answer"));   // no source dropped: the answer stands
        assertEquals(new JSONArray().put("Camera/a.jpg").toString(), r.getJSONObject("action").getJSONArray("files").toString());

        JSONObject skipped = new JSONObject().put("answer", "a").put("sources", new JSONArray().put(src("Elsewhere/x.jpg")))
                .put("action", AskScope.skipped("collect", AskScope.READ_ONLY));
        new AskScope(true, "Camera").confine(skipped);
        assertEquals("Nothing in this folder matched.", skipped.getString("answer"));
        assertEquals(AskScope.READ_ONLY, skipped.getJSONObject("action").getString("reason"));
    }

    @Test
    public void confineAnswersInKoreanForAKoreanQuestion() throws Exception {
        JSONObject r = new JSONObject().put("answer", "…").put("context", new JSONObject().put("korean", true))
                .put("sources", new JSONArray().put(src("A/1.jpg")).put(src("B/2.jpg")));
        new AskScope(true, "A").confine(r);
        assertEquals("이 폴더에서 1개를 찾았어요.", r.getString("answer"));
    }

    @Test
    public void confineAddsMissingSources() throws Exception {
        JSONObject r = new AskScope(true, "A").confine(new JSONObject().put("answer", "hi"));
        assertEquals(0, r.getJSONArray("sources").length());
        assertEquals("hi", r.getString("answer"));
    }

    // ------------------------------------------------------------ read-only gating

    @Test
    public void readOnlyBlocksEveryActButCounting() throws Exception {
        AskScope read = new AskScope(true, "");
        SearchQuery collect = new SearchQuery(); collect.collect = true;
        SearchQuery move = new SearchQuery(); move.collect = true; move.move = true;
        SearchQuery delete = new SearchQuery(); delete.delete = true;
        SearchQuery calls = new SearchQuery(); calls.calls = true;
        SearchQuery count = new SearchQuery(); count.count = true;
        SearchQuery share = new SearchQuery(); share.share = true;

        assertAction(read.blocked(collect), "collect");
        assertAction(read.blocked(move), "move");
        assertAction(read.blocked(delete), "delete");
        JSONObject report = read.blocked(calls);
        assertAction(report, "collect");
        assertEquals("calls", report.getString("report"));
        assertNull(read.blocked(count));
        assertNull(read.blocked(share));   // sharing is the shell's job; nothing to block here
        assertNull(read.blocked(new SearchQuery()));

        for (SearchQuery q : new SearchQuery[]{collect, move, delete, calls, count, share}) {
            assertNull(AskScope.ACT_ALL.blocked(q));
            assertNull(new AskScope(false, "Camera").blocked(q));
        }
    }

    /** The 100 task scenarios, parsed for real: read-only blocks exactly the ones that would act. */
    @Test
    public void readOnlyBlocksEveryActingTaskScenario() throws Exception {
        QueryParser parser = new QueryParser(geo);
        byte[] b = getClass().getResourceAsStream("/task-scenarios.json").readAllBytes();
        JSONArray scen = new JSONObject(new String(b, StandardCharsets.UTF_8)).getJSONArray("scenarios");
        AskScope read = new AskScope(true, "");
        List<String> failures = new ArrayList<>();
        int acting = 0;
        for (int i = 0; i < scen.length(); i++) {
            JSONObject s = scen.getJSONObject(i);
            String type = s.getJSONObject("action").isNull("type") ? null : s.getJSONObject("action").getString("type");
            boolean acts = "collect".equals(type) || "move".equals(type) || "delete".equals(type);
            if (acts) acting++;
            SearchQuery q = parser.parse(s.getString("q"), System.currentTimeMillis());
            JSONObject blocked = read.blocked(q);
            if (acts && (blocked == null || !AskScope.READ_ONLY.equals(blocked.optString("reason"))))
                failures.add(s.getString("id") + " would act in read mode: " + s.getString("q"));
            if (acts && blocked != null && !type.equals(blocked.optString("type")))
                failures.add(s.getString("id") + " reports " + blocked.optString("type") + ", not " + type);
            if (!acts && blocked != null) failures.add(s.getString("id") + " blocked but does not act: " + s.getString("q"));
            if (AskScope.ACT_ALL.blocked(q) != null) failures.add(s.getString("id") + " blocked in act mode");
        }
        assertTrue("the scenarios should include acting tasks", acting >= 20);
        if (!failures.isEmpty()) throw new AssertionError(String.join("\n", failures));
    }

    @Test
    public void readOnlyNeverMakesACallReport() throws Exception {
        QueryParser parser = new QueryParser(geo);
        for (String question : new String[]{
                "sort my call history by who I talk to most and summarize it",
                "who likes me the most?",
                "많이 통화한 사람 순으로 정리하고 요약해줘"}) {
            SearchQuery q = parser.parse(question, System.currentTimeMillis());
            assertTrue(question, q.calls);
            JSONObject blocked = new AskScope(true, "").blocked(q);
            assertNotNull(question, blocked);
            assertEquals("calls", blocked.getString("report"));
            assertEquals(AskScope.READ_ONLY, blocked.getString("reason"));
        }
    }

    @Test
    public void onlyLookedIsSaidInTheQuestionsLanguage() {
        assertTrue(AskScope.onlyLooked(false).contains("only looked"));
        assertTrue(AskScope.onlyLooked(true).contains("찾아보기만"));
    }

    private static void assertAction(JSONObject a, String type) throws Exception {
        assertNotNull(type, a);
        assertEquals(type, a.getString("type"));
        assertTrue(a.getBoolean("skipped"));
        assertEquals(AskScope.READ_ONLY, a.getString("reason"));
        assertFalse("a read-only action lists no files", a.has("files"));
    }

    private static JSONObject src(String path) throws Exception {
        return new JSONObject().put("path", path).put("snippet", "").put("matchedBy", "name");
    }
}
