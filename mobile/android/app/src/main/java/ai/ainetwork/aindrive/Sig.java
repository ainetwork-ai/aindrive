package ai.ainetwork.aindrive;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * HMAC sign/verify of RPC frames — byte-for-byte compatible with
 * web/lib/sig.js and cli/src/sig.js. Same drive secret must produce the same
 * signature here as it does in Node, or every frame is dropped as forged.
 *
 * The canonical form is JS `JSON.stringify(payload, Object.keys(payload).sort())`.
 * The 2nd argument is a key ALLOWLIST, and per the ES spec that allowlist
 * applies to every object encountered, including nested ones. Since the
 * allowlist only ever holds top-level key names, any nested object serialises
 * as `{}` — verified against Node before this class was written. So:
 *
 *   {v:1, reqId:"r", driveId:"d", issuedAt:123, params:{method:"list"}}
 *     → {"driveId":"d","issuedAt":123,"params":{},"reqId":"r","v":1}
 *
 * Do NOT "fix" this into a recursive canonicaliser: it would stop matching Node.
 */
final class Sig {
    private Sig() {}

    static String sign(String secret, JSONObject payload) {
        byte[] canonical = canonicalize(payload).getBytes(StandardCharsets.UTF_8);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(canonical);
            return Base64.encodeToString(digest, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (Exception e) {
            throw new IllegalStateException("hmac failed: " + e.getMessage(), e);
        }
    }

    /** Constant-time compare, mirroring timingSafeEqual in the Node copies. */
    static boolean verify(String secret, JSONObject payload, String sig) {
        if (sig == null) return false;
        String expected = sign(secret, payload);
        if (expected.length() != sig.length()) return false;
        int diff = 0;
        for (int i = 0; i < expected.length(); i++) diff |= expected.charAt(i) ^ sig.charAt(i);
        return diff == 0;
    }

    static String canonicalize(JSONObject payload) {
        List<String> keys = new ArrayList<>();
        for (Iterator<String> it = payload.keys(); it.hasNext(); ) keys.add(it.next());
        Collections.sort(keys); // JS sort() on ASCII key names == Java natural order
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (String k : keys) {
            Object v = payload.opt(k);
            if (v == null) continue; // JSON.stringify omits undefined-valued keys
            if (!first) sb.append(',');
            first = false;
            writeString(sb, k);
            sb.append(':');
            writeValue(sb, v);
        }
        return sb.append('}').toString();
    }

    private static void writeValue(StringBuilder sb, Object v) {
        if (v == JSONObject.NULL) { sb.append("null"); return; }
        if (v instanceof String) { writeString(sb, (String) v); return; }
        if (v instanceof Boolean) { sb.append(((Boolean) v) ? "true" : "false"); return; }
        if (v instanceof Number) { sb.append(numberToJs((Number) v)); return; }
        // Nested objects collapse to {} because the key allowlist excludes their keys.
        if (v instanceof JSONObject) { sb.append("{}"); return; }
        if (v instanceof JSONArray) {
            JSONArray arr = (JSONArray) v;
            sb.append('[');
            for (int i = 0; i < arr.length(); i++) {
                if (i > 0) sb.append(',');
                Object e = arr.opt(i);
                if (e == null) sb.append("null"); else writeValue(sb, e);
            }
            sb.append(']');
            return;
        }
        sb.append("null");
    }

    /** Match JS number formatting: integral doubles print without a ".0" tail. */
    private static String numberToJs(Number n) {
        double d = n.doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == Math.rint(d) && Math.abs(d) < 1e21) return Long.toString((long) d);
        return Double.toString(d);
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }
}
