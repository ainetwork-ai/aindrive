package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.index.MemIndex;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * AskRunner.ask end to end in `mode: "read"` (phone protocol v2), through the file-search
 * branch with a real parser, gazetteer and a populated index: every question that would act
 * comes back with a skipped action and "I only looked", and nothing — no copy, move or write,
 * no index write, no call-log read — is touched. An act-mode control shows the fakes would
 * have caught it.
 */
public class AskRunnerReadModeTest {
    static GeoLookup geo;
    static final long WHEN = 1_700_000_000_000L;

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { geo = GeoLookup.loadGzip(in); }
    }

    /** Records everything the agent tries to do to the folder. */
    static final class Ops implements AskRunner.FileOps {
        final List<String> touched = new ArrayList<>();
        @Override public void copy(String docId, String destRel) { touched.add("copy " + destRel); }
        @Override public void move(String fromRel, String destRel) { touched.add("move " + fromRel); }
        @Override public String uriOf(String rel) { touched.add("uriOf " + rel); return null; }
        @Override public void write(String rel, byte[] data) { touched.add("write " + rel); }
        @Override public android.os.ParcelFileDescriptor openFd(String docId) { touched.add("openFd " + docId); return null; }
    }

    final Ops ops = new Ops();
    final List<String> callLogReads = new ArrayList<>();

    private AskRunner runner(FileIndex index) {
        return new AskRunner(index, geo, () -> null, ops,
                () -> { callLogReads.add("calls"); return new ArrayList<>(); },
                () -> null, () -> null, () -> { }, () -> false);
    }

    /** Tokyo, Paris and Nice photos, some under Camera/ and some outside it. */
    static MemIndex drive() {
        MemIndex ix = new MemIndex();
        for (int i = 1; i <= 3; i++) ix.add("Camera/tokyo_" + i + ".jpg", FileIndex.PHOTO, "Tokyo", "JP", WHEN + i);
        for (int i = 1; i <= 2; i++) ix.add("Private/tokyo_" + i + ".jpg", FileIndex.PHOTO, "Tokyo", "JP", WHEN + 10 + i);
        for (int i = 1; i <= 2; i++) ix.add("Camera/paris_" + i + ".jpg", FileIndex.PHOTO, "Paris", "FR", WHEN + 20 + i);
        for (int i = 1; i <= 2; i++) ix.add("Trips/nice_" + i + ".jpg", FileIndex.PHOTO, "Nice", "FR", WHEN + 30 + i);
        return ix;
    }

    private void assertLookedOnly(JSONObject r, String type, MemIndex ix, String q) throws Exception {
        JSONObject a = r.optJSONObject("action");
        assertTrue(q + ": no action in " + r, a != null);
        assertEquals(q, type, a.getString("type"));
        assertTrue(q, a.getBoolean("skipped"));
        assertEquals(q, AskScope.READ_ONLY, a.getString("reason"));
        assertFalse(q + ": a read-only reply lists no files", a.has("files") || a.has("pending") || a.has("folder"));
        boolean ko = r.optJSONObject("context") != null && r.getJSONObject("context").optBoolean("korean");
        assertTrue(q + ": " + r.getString("answer"), r.getString("answer").endsWith(AskScope.onlyLooked(ko)));
        assertEquals(q + " touched the folder", new ArrayList<String>(), ops.touched);
        assertEquals(q + " wrote the index", new ArrayList<String>(), ix.writes);
        assertEquals(q + " read the call log", new ArrayList<String>(), callLogReads);
    }

    private static void assertInside(JSONObject r, String root) throws Exception {
        JSONArray s = r.getJSONArray("sources");
        for (int i = 0; i < s.length(); i++) {
            String p = s.getJSONObject(i).getString("path");
            assertTrue(p + " is outside " + root, root.isEmpty() || p.equals(root) || p.startsWith(root + "/"));
        }
    }

    @Test
    public void readModeNeverActsOnFiles() throws Exception {
        String[][] cases = {
                {"gather my Tokyo photos", "collect"},
                {"collect the Paris photos into a folder and share it", "collect"},
                {"move the Nice photos into a folder", "move"},
                {"delete my Paris photos", "delete"},
                {"도쿄 사진 모아줘", "collect"},
                {"파리 사진 삭제해줘", "delete"},
        };
        for (String root : new String[]{"", "Camera"}) {
            for (String[] c : cases) {
                MemIndex ix = drive();
                JSONObject r = runner(ix).ask(c[0], null, new AskScope(true, root));
                assertLookedOnly(r, c[1], ix, c[0] + " (root '" + root + "')");
                assertInside(r, root);
            }
        }
    }

    @Test
    public void readModeStillFindsWhatWasAskedAbout() throws Exception {
        MemIndex ix = drive();
        JSONObject r = runner(ix).ask("gather my Tokyo photos", null, new AskScope(true, ""));
        assertEquals(5, r.getJSONArray("sources").length());
        r = runner(ix).ask("gather my Tokyo photos", null, new AskScope(true, "Camera"));
        assertEquals(3, r.getJSONArray("sources").length());
        assertInside(r, "Camera");
    }

    @Test
    public void countingIsAnsweredInReadModeOverTheRootOnly() throws Exception {
        MemIndex ix = drive();
        JSONObject r = runner(ix).ask("how many Tokyo photos", null, new AskScope(true, "Camera"));
        JSONObject a = r.getJSONObject("action");
        assertEquals("count", a.getString("type"));
        assertEquals(3, a.getInt("count"));
        assertFalse(a.has("skipped"));
        assertInside(r, "Camera");
        assertTrue(ops.touched.isEmpty() && ix.writes.isEmpty() && callLogReads.isEmpty());
    }

    @Test
    public void aCallReportInReadModeNeverOpensTheCallLog() throws Exception {
        MemIndex ix = drive();
        JSONObject r = runner(ix).ask("sort my call history by who I talk to most and summarize it", null, new AskScope(true, ""));
        JSONObject a = r.getJSONObject("action");
        assertEquals("calls", a.getString("report"));
        assertEquals(AskScope.READ_ONLY, a.getString("reason"));
        assertTrue(ops.touched.isEmpty() && ix.writes.isEmpty() && callLogReads.isEmpty());
    }

    @Test
    public void anEmptyIndexStillReportsTheSkippedAction() throws Exception {
        MemIndex ix = new MemIndex();
        JSONObject r = runner(ix).ask("gather my Tokyo photos", null, new AskScope(true, "Camera"));
        assertTrue(r.getString("answer"), r.getString("answer").startsWith("The index is empty"));
        assertEquals(0, r.getJSONArray("sources").length());
        assertLookedOnly(r, "collect", ix, "empty index");

        JSONObject ko = runner(ix).ask("파리 사진 삭제해줘", null, new AskScope(true, ""));
        assertLookedOnly(ko, "delete", ix, "empty index, Korean");
        // Not read-only: no action to report, the answer is as before.
        JSONObject act = runner(ix).ask("gather my Tokyo photos", null, AskScope.ACT_ALL);
        assertFalse(act.has("action"));
    }

    /** Small talk: in read mode the on-device LLM is never loaded (anyone the server lets ask can send it). */
    @Test
    public void readModeSmallTalkNeverLoadsTheLlm() throws Exception {
        for (String q : new String[]{"I just got back from a long walk, it was lovely", "I love cooking pasta for my friends"}) {
            List<String> loads = new ArrayList<>();
            List<String> released = new ArrayList<>();
            AskRunner r = new AskRunner(drive(), geo, () -> null, ops, () -> { callLogReads.add("calls"); return new ArrayList<>(); },
                    () -> null, () -> { loads.add(q); return null; }, () -> released.add(q), () -> false);
            JSONObject read = r.ask(q, null, new AskScope(true, ""));
            assertEquals(q, "chat", read.getString("query"));
            assertFalse(q + ": " + read, read.getString("answer").isEmpty());
            assertEquals(q, 0, read.getJSONArray("sources").length());
            assertTrue(q + " loaded the LLM in read mode", loads.isEmpty() && released.isEmpty());
            // Control: the same turn in act mode is small talk the LLM would answer.
            JSONObject act = r.ask(q, null, new AskScope(false, ""));
            assertEquals(q, "chat", act.getString("query"));
            assertEquals(q + " is not small talk", 1, loads.size());
        }
        assertTrue(ops.touched.isEmpty() && callLogReads.isEmpty());
    }

    private static String recording(String who, long daysAgo) {
        return "Call recording " + who + "_" + new SimpleDateFormat("yyMMdd_HHmmss", Locale.US).format(new Date(System.currentTimeMillis() - daysAgo * 86_400_000L)) + ".m4a";
    }

    /**
     * A call report asked over the socket (act, whole drive) counts the phone's call-recordings
     * folders but lists as sources only recordings in the asked drive: the server reads every
     * source path as a path in that drive. The in-app chat still lists them all.
     */
    @Test
    public void aRemoteCallReportListsOnlyThisDrivesRecordings() throws Exception {
        MemIndex ix = drive();
        String ownAmy = "Calls/" + recording("Amy Jang", 40);
        ix.add(ownAmy, FileIndex.AUDIO, null, null, WHEN);
        MemIndex calls = new MemIndex();                               // the call-recordings folder: another folder
        String newerAmy = recording("Amy Jang", 3), bob = recording("Bob Stone", 5);
        calls.add(newerAmy, FileIndex.AUDIO, null, null, WHEN);
        calls.add(bob, FileIndex.AUDIO, null, null, WHEN);

        JSONObject remote = runner(ix).withCallIndexes(() -> Arrays.asList(calls)).ask(
                "sort my call history by who I talk to most and summarize it", null, new AskScope(false, ""));
        assertEquals("calls", remote.getString("query"));
        List<String> paths = new ArrayList<>();
        JSONArray s = remote.getJSONArray("sources");
        for (int i = 0; i < s.length(); i++) paths.add(s.getJSONObject(i).getString("path"));
        assertEquals(Arrays.asList(ownAmy), paths);
        assertTrue(remote.getString("answer"), remote.getString("answer").contains("Bob Stone"));   // still counted

        JSONObject local = runner(ix).withCallIndexes(() -> Arrays.asList(calls)).ask(
                "sort my call history by who I talk to most and summarize it", null);
        List<String> all = new ArrayList<>();
        s = local.getJSONArray("sources");
        for (int i = 0; i < s.length(); i++) all.add(s.getJSONObject(i).getString("path"));
        assertTrue(all.toString(), all.contains(newerAmy) && all.contains(bob) && !all.contains(ownAmy));
    }

    @Test
    public void actModeDoesActSoTheFakesWouldHaveCaughtIt() throws Exception {
        MemIndex ix = drive();
        JSONObject r = runner(ix).ask("gather my Tokyo photos", null, new AskScope(false, "Camera"));
        JSONObject a = r.getJSONObject("action");
        assertEquals("collect", a.getString("type"));
        assertFalse(a.optBoolean("skipped"));
        assertEquals(3, a.getInt("copied"));
        assertTrue(ops.touched.toString(), ops.touched.size() >= 3);
        for (String t : ops.touched) if (t.startsWith("copy ")) assertTrue(t, t.startsWith("copy Camera/"));   // collected inside the root
    }
}
