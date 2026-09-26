package ai.ainetwork.aindrive;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The first frame on every drive socket (phone protocol v2, host → server):
 * who this host is and what it can do, so the server can refuse a question
 * the device can't answer instead of timing out on it.
 *
 * `hostname` is unchanged from v1 (the server keeps it as the drive's
 * last_hostname). `methods` is every RPC method {@link RpcHandler} answers;
 * `caps` lists optional features — "ask.v2" means `agent-ask` honours
 * mode/root/context and returns `action` (agent/AskScope). Old servers ignore
 * the new fields.
 */
final class Hello {
    private Hello() {}

    static final String PLATFORM = "android";
    /** agent-ask v2: mode read|act, root prefix filter, context accepted, action passed through. */
    static final String CAP_ASK_V2 = "ask.v2";

    static JSONObject build(String hostname, String appVersion) throws Exception {
        return new JSONObject()
                .put("type", "agent-hello")
                .put("hostname", hostname)
                .put("platform", PLATFORM)
                .put("appVersion", appVersion)
                .put("methods", new JSONArray(RpcHandler.methods()))
                .put("caps", new JSONArray().put(CAP_ASK_V2));
    }
}
