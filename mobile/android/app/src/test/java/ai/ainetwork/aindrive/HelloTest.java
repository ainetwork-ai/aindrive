package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Phone protocol v2: the agent-hello and the agent-ask reply shape (docs/AINUI.md §6, mobile/README.md). */
public class HelloTest {
    @Test
    public void helloAdvertisesPlatformVersionMethodsAndAskV2() throws Exception {
        JSONObject h = Hello.build("SM-S938N", "1.0+1");
        assertEquals("agent-hello", h.getString("type"));
        assertEquals("SM-S938N", h.getString("hostname"));
        assertEquals("android", h.getString("platform"));
        assertEquals("1.0+1", h.getString("appVersion"));
        assertEquals(new JSONArray().put("ask.v2").toString(), h.getJSONArray("caps").toString());
        JSONArray m = h.getJSONArray("methods");
        List<String> methods = new ArrayList<>();
        for (int i = 0; i < m.length(); i++) methods.add(m.getString(i));
        for (String want : new String[]{"list", "stat", "read", "write", "mkdir", "rename", "delete",
                "upload-chunk", "download-chunk", "yjs-write", "yjs-read", "yjs-stats", "agent-ask", "handoff-read"}) {
            assertTrue(want, methods.contains(want));
        }
        List<String> sorted = new ArrayList<>(methods);
        java.util.Collections.sort(sorted);
        assertEquals(sorted, methods);
    }

    @Test
    public void askReplyPassesTheActionThroughWithoutThePhonesStorageUri() throws Exception {
        JSONObject r = new JSONObject().put("answer", "Collected 3 photos.").put("sources", new JSONArray())
                .put("relaxed", false).put("context", new JSONObject())
                .put("action", new JSONObject().put("type", "collect").put("folder", "Camera/food photos").put("copied", 3)
                        .put("folderUri", "content://com.android.externalstorage.documents/tree/primary%3ADCIM/document/x"));
        JSONObject out = RpcHandler.askResult(r);
        assertEquals("agent-ask", out.getString("method"));
        assertEquals("Collected 3 photos.", out.getString("answer"));
        assertEquals("collect", out.getJSONObject("action").getString("type"));
        assertEquals(3, out.getJSONObject("action").getInt("copied"));
        assertFalse(out.getJSONObject("action").has("folderUri"));
        assertTrue(r.getJSONObject("action").has("folderUri"));   // the in-app result is left as it was
        assertFalse(out.has("context"));
        assertFalse(out.has("relaxed"));
    }

    @Test
    public void askReplyWithoutAnActionHasNone() throws Exception {
        JSONObject out = RpcHandler.askResult(new JSONObject().put("answer", "Found 2 photos.").put("sources", new JSONArray()));
        assertFalse(out.has("action"));
    }
}
