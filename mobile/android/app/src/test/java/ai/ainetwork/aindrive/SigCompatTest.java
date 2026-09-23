package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Locks this agent's frame signing to Node's.
 *
 * The expected values below were produced by web/lib/sig.js — the canonical
 * implementation — with the secret "s3cr3t-drive-key". If a change here makes
 * one of these fail, the phone would be signing frames the server rejects as
 * forged, and every drive operation would silently stop working. Regenerate
 * the vectors from Node rather than editing them to match new output.
 *
 * Note the nested `params` / `result` objects collapsing to `{}`: that is the
 * documented consequence of JSON.stringify's key-allowlist argument, not a bug.
 *
 * This is a plain JVM test, so it exercises Sig.canonicalize plus a local HMAC
 * rather than Sig.sign (which needs android.util.Base64). The canonical string
 * is the part that is easy to get subtly wrong; HMAC-SHA256 is not.
 */
public class SigCompatTest {
    private static final String SECRET = "s3cr3t-drive-key";

    private static String sign(JSONObject payload) throws Exception {
        String canonical = Sig.canonicalize(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    public void requestFrameMatchesNode() throws Exception {
        JSONObject p = new JSONObject()
                .put("v", 1)
                .put("reqId", "req_abc123")
                .put("driveId", "drv_xyz")
                .put("issuedAt", 1758000000000L)
                .put("params", new JSONObject().put("method", "list").put("path", "docs/a"));
        assertEquals(
                "{\"driveId\":\"drv_xyz\",\"issuedAt\":1758000000000,\"params\":{},\"reqId\":\"req_abc123\",\"v\":1}",
                Sig.canonicalize(p));
        assertEquals("LN31xM-UJbePhnyb4dDADxnhuQ-qT-Uy7-i5UFmWSRA", sign(p));
    }

    /**
     * The allowlist recurses: a result object keeps the keys it shares with the
     * top level (`ok`), so mutating RPCs (write/rename/upload-chunk …) do not
     * canonicalize to "result":{} — the bug that made every upload's response
     * fail server-side verification.
     */
    @Test
    public void nestedResultKeepsAllowlistedKeys() throws Exception {
        JSONObject p = new JSONObject()
                .put("reqId", "req_up1")
                .put("ok", true)
                .put("result", new JSONObject()
                        .put("method", "upload-chunk").put("ok", true).put("receivedBytes", 1024));
        assertEquals("{\"ok\":true,\"reqId\":\"req_up1\",\"result\":{\"ok\":true}}", Sig.canonicalize(p));
        assertEquals("dAfkeXY87aYeIqZgab41QFtj36Cdh1jRjBLHbXh5c1U", sign(p));
    }

    @Test
    public void okResponseMatchesNode() throws Exception {
        JSONObject p = new JSONObject()
                .put("reqId", "req_abc123")
                .put("ok", true)
                .put("result", new JSONObject().put("method", "list"));
        assertEquals("{\"ok\":true,\"reqId\":\"req_abc123\",\"result\":{}}", Sig.canonicalize(p));
        assertEquals("lAgwh_105wcHt7TO-TjrzZAUljI_xH-q-NyJIX8qWWQ", sign(p));
    }

    @Test
    public void errorResponseMatchesNode() throws Exception {
        JSONObject p = new JSONObject()
                .put("reqId", "req_abc123")
                .put("ok", false)
                .put("error", "no such path: <path>");
        assertEquals("A-F0-J12yYIUdsWdhGNguGNpgwEbAak1Dpwr7l2EhaY", sign(p));
    }

    @Test
    public void escapesAndNonAsciiMatchNode() throws Exception {
        JSONObject p = new JSONObject()
                .put("reqId", "r\"1\n")
                .put("driveId", "드라이브")
                .put("v", 1);
        assertEquals("{\"driveId\":\"드라이브\",\"reqId\":\"r\\\"1\\n\",\"v\":1}", Sig.canonicalize(p));
        assertEquals("Z_vwbrklZPLAOnSkucvZVMkZ6qRvUQlvHLqbAA686sU", sign(p));
    }
}
