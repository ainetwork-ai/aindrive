package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import ai.ainetwork.aindrive.agent.AskRunner;
import ai.ainetwork.aindrive.agent.AskScope;
import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.index.MemIndex;

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
import java.util.Base64;
import java.util.List;

/**
 * `agent-ask` v2 through RpcHandler.handle — the params the server sends, the reply it gets
 * back: read mode reports what it skipped and touches nothing, and every source is inside the
 * root in the server's spelling (NFC) even when the file on the phone is named in NFD.
 */
public class RpcHandlerAskTest {
    static GeoLookup geo;
    static final String NFC = Normalizer.normalize("사진", Normalizer.Form.NFC);
    static final String NFD = Normalizer.normalize(NFC, Normalizer.Form.NFD);

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { geo = GeoLookup.loadGzip(in); }
    }

    final List<String> touched = new ArrayList<>();

    private RpcHandler handler(MemIndex ix) {
        AskRunner.FileOps ops = new AskRunner.FileOps() {
            @Override public void copy(String docId, String destRel) { touched.add("copy"); }
            @Override public void move(String fromRel, String destRel) { touched.add("move"); }
            @Override public void write(String rel, byte[] data) { touched.add("write"); }
        };
        AskRunner runner = new AskRunner(ix, geo, () -> null, ops, () -> { touched.add("callLog"); return new ArrayList<>(); },
                () -> null, () -> null, () -> { }, () -> false);
        // No SafFs: agent-ask answers from the index only.
        return new RpcHandler(new android.content.ContextWrapper(null), null, "drv_test", () -> runner);
    }

    private static JSONObject ask(String query, String mode, String root) throws Exception {
        JSONObject p = new JSONObject().put("method", "agent-ask").put("agentId", "agt_device").put("query", query);
        if (mode != null) p.put("mode", mode);
        if (root != null) p.put("root", root);
        return p;
    }

    @Test
    public void nfdFilesComeBackInsideAnNfcRootInTheServersSpelling() throws Exception {
        MemIndex ix = new MemIndex();
        for (int i = 1; i <= 3; i++) ix.add(NFD + "/tokyo_" + i + ".jpg", FileIndex.PHOTO, "Tokyo", "JP", 1_700_000_000_000L + i);
        ix.add("Other/tokyo_9.jpg", FileIndex.PHOTO, "Tokyo", "JP", 1_700_000_000_100L);
        JSONObject r = handler(ix).handle(ask("gather my Tokyo photos", "read", NFC));

        JSONArray sources = r.getJSONArray("sources");
        assertEquals(3, sources.length());
        for (int i = 0; i < sources.length(); i++) {
            String p = sources.getJSONObject(i).getString("path");
            assertTrue(p, p.startsWith(NFC + "/"));   // literally, as contract §2 says
            assertEquals(Normalizer.normalize(p, Normalizer.Form.NFC), p);
        }
        JSONObject a = r.getJSONObject("action");
        assertEquals("collect", a.getString("type"));
        assertEquals(AskScope.READ_ONLY, a.getString("reason"));
        assertFalse(a.has("folderUri"));
        assertTrue(touched.isEmpty());
        assertTrue(ix.writes.isEmpty());
    }

    @Test
    public void readModeAcrossTheQuestionsThatWouldAct() throws Exception {
        String[] questions = {"gather my Tokyo photos", "move the Tokyo photos into a folder", "delete my Tokyo photos",
                "도쿄 사진 모아줘", "sort my call history by who I talk to most and summarize it"};
        for (String root : new String[]{null, "", "Camera"}) {
            for (String q : questions) {
                MemIndex ix = new MemIndex();
                ix.add("Camera/tokyo_1.jpg", FileIndex.PHOTO, "Tokyo", "JP", 1_700_000_000_000L);
                ix.add("Private/tokyo_2.jpg", FileIndex.PHOTO, "Tokyo", "JP", 1_700_000_000_001L);
                JSONObject r = handler(ix).handle(ask(q, "read", root));
                JSONObject a = r.getJSONObject("action");
                assertTrue(q + " / " + root + ": " + a, a.getBoolean("skipped"));
                assertEquals(q + " / " + root, AskScope.READ_ONLY, a.getString("reason"));
                JSONArray s = r.getJSONArray("sources");
                for (int i = 0; i < s.length(); i++)
                    if ("Camera".equals(root)) assertTrue(s.getJSONObject(i).getString("path").startsWith("Camera/"));
                assertEquals(q + " / " + root, new ArrayList<String>(), touched);
                assertEquals(q + " / " + root, new ArrayList<String>(), ix.writes);
            }
        }
    }

    @Test
    public void aSystemRootIsRefusedBeforeTheIndexIsRead() throws Exception {
        MemIndex ix = new MemIndex() {
            @Override public int count() { throw new AssertionError("index read"); }
        };
        for (String root : new String[]{".aindrive", ".AINDRIVE/agents", "../x", "a/../../b"}) {
            try { handler(ix).handle(ask("gather my Tokyo photos", "read", root)); fail("accepted " + root); }
            catch (IOException e) { assertEquals("bad_root", e.getMessage()); }
        }
        try { handler(ix).handle(ask("gather my Tokyo photos", "write", "")); fail("accepted mode write"); }
        catch (IOException e) { assertEquals("bad_mode", e.getMessage()); }
    }

    private static String hex64(char c) {
        char[] a = new char[64];
        java.util.Arrays.fill(a, c);
        return new String(a);
    }

    @Test
    public void everyYjsSnapshotThatIsKeptCanBeReadBack() {
        // The yjs-read reply for the largest snapshot yjs-write accepts fits one frame.
        byte[] blob = new byte[RpcHandler.MAX_YJS_BYTES];
        String reply = "{\"reqId\":\"" + hex64('r') + "\",\"ok\":true,\"result\":{\"method\":\"yjs-read\",\"data\":\""
                + Base64.getEncoder().encodeToString(blob) + "\",\"bytes\":" + blob.length + "},\"type\":\"response\",\"sig\":\"" + hex64('f') + "\"}";
        assertTrue(SendGate.utf8Length(reply) <= SendGate.MAX_MESSAGE_BYTES);
        assertEquals(reply.getBytes(StandardCharsets.UTF_8).length, SendGate.utf8Length(reply));
        assertTrue("≈ 9 MiB", RpcHandler.MAX_YJS_BYTES > 8.9 * 1024 * 1024);
    }
}
