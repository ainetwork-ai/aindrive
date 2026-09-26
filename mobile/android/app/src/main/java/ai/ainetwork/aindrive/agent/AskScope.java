package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;

/**
 * What one `agent-ask` may touch: its mode (read or act) and its root folder.
 * Phone protocol v2, the host side of the contract the web's `ask` skill uses:
 *
 *  - `mode: "read"` — the agent only looks. No file operation (collect, move,
 *    delete, write), no call report, no call log. A request that would act
 *    reports `action: {type, skipped: true, reason: "read_only"}` and the
 *    answer says it only looked.
 *  - `mode: "act"`, or no `mode` — today's behaviour (the owner's `/ask`).
 *  - `root` — a folder inside the drive; every source, count and answer is
 *    computed over files at or below it. "" or absent = the whole drive.
 *
 * Pure (org.json + java.text only) so the rules are unit-tested on the JVM.
 */
public final class AskScope {
    /** The in-app chat's own asks: act, whole drive — exactly the behaviour before v2. */
    public static final AskScope ACT_ALL = new AskScope(false, "");

    static final int MAX_ROOT_BYTES = 4096;
    public static final String READ_ONLY = "read_only";
    /** A call report reads the whole phone's call log: it can't be made from inside one folder. */
    public static final String OUTSIDE_ROOT = "outside_root";

    public final boolean readOnly;
    /** Normalized: NFC, no leading/trailing "/", no "." segments; "" = the whole drive. */
    public final String root;

    public AskScope(boolean readOnly, String root) {
        this.readOnly = readOnly;
        this.root = root;
    }

    /**
     * From `agent-ask` params. `mode` must be "read" or "act" when present (anything else is
     * refused, never guessed); `root` is normalized the way the web's normalizePath does and a
     * system path (.aindrive/, any letter case) is refused. `context` is accepted and ignored.
     */
    public static AskScope fromParams(JSONObject params) throws IOException {
        boolean readOnly;
        Object mode = params.opt("mode");
        if (mode == null || mode == JSONObject.NULL) readOnly = false;              // v1 server: today's behaviour
        else if ("read".equals(mode)) readOnly = true;
        else if ("act".equals(mode)) readOnly = false;
        else throw new IOException("bad_mode");
        Object root = params.opt("root");
        if (root == null || root == JSONObject.NULL) return new AskScope(readOnly, "");
        if (!(root instanceof String)) throw new IOException("bad_root");
        return new AskScope(readOnly, normalizeRoot((String) root));
    }

    /** Mirrors web/lib/path.js normalizePath + isSystemPath: NFC, no NUL, no "..", never under .aindrive/. */
    static String normalizeRoot(String raw) throws IOException {
        if (raw.indexOf('\0') >= 0) throw new IOException("bad_root");
        String nfc = Normalizer.normalize(raw, Normalizer.Form.NFC);
        if (nfc.getBytes(StandardCharsets.UTF_8).length > MAX_ROOT_BYTES) throw new IOException("bad_root");
        List<String> segs = new ArrayList<>();
        for (String s : nfc.split("/")) {
            if (s.isEmpty() || s.equals(".")) continue;
            if (s.equals("..")) throw new IOException("bad_root");
            segs.add(s);
        }
        if (!segs.isEmpty() && segs.get(0).equalsIgnoreCase(".aindrive")) throw new IOException("bad_root");
        return String.join("/", segs);
    }

    /** True when `path` is the root itself or below it (compared in NFC: a Mac-made name may be NFD on the phone). */
    public boolean inside(@Nullable String path) {
        if (path == null) return false;
        String p = Normalizer.normalize(stripSlashes(path), Normalizer.Form.NFC);
        if (isSystem(p)) return false;
        if (root.isEmpty()) return true;
        return p.equals(root) || p.startsWith(root + "/");
    }

    /**
     * The spellings of the root the index may hold (NFC as the server names it, NFD as a Mac may
     * have written it). Empty for the whole drive. Used as an exact, case-sensitive prefix filter.
     */
    public List<String> rootSpellings() { return root.isEmpty() ? new ArrayList<>() : spellings(root); }

    /** NFC and NFD forms of a drive path, without duplicates. */
    public static List<String> spellings(String path) {
        List<String> out = new ArrayList<>();
        out.add(Normalizer.normalize(path, Normalizer.Form.NFC));
        String nfd = Normalizer.normalize(path, Normalizer.Form.NFD);
        if (!out.contains(nfd)) out.add(nfd);
        if (!out.contains(path)) out.add(path);
        return out;
    }

    /** Where "collect" puts its folder: inside the root, so an act never writes outside what was asked about. */
    public String collectInto(String folder) { return root.isEmpty() ? folder : root + "/" + folder; }

    /**
     * The action a read-only ask reports instead of doing it, or null when `q` doesn't act.
     * Counting is not acting: `count` is answered in either mode.
     */
    public @Nullable JSONObject blocked(SearchQuery q) throws Exception {
        if (!readOnly) return null;
        if (q.calls) return skipped("collect", READ_ONLY).put("report", "calls");
        if (q.delete) return skipped("delete", READ_ONLY);
        if (q.collect) return skipped(q.move ? "move" : "collect", READ_ONLY);
        return null;
    }

    public static JSONObject skipped(String type, String reason) throws Exception {
        return new JSONObject().put("type", type).put("skipped", true).put("reason", reason);
    }

    /** Appended to the answer of a read-only ask that asked for an action. */
    public static String onlyLooked(boolean korean) {
        return korean ? " 이번에는 찾아보기만 했어요. 파일은 바꾸지 않았어요."
                : " I only looked — this request can't change any files.";
    }

    /** The answer to a call report asked from inside one folder. */
    public static String reportNeedsWholePhone(boolean korean) {
        return korean ? "통화 요약은 폰 전체의 통화 기록을 봐야 해서, 폴더 하나 안에서는 만들 수 없어요."
                : "A call report looks at the whole phone's call history, so it can't be made from inside one folder.";
    }

    /**
     * Last line of defence before a result leaves the phone: drop every source outside the root
     * (or under .aindrive/), and every such path from an action's `files`. The search already
     * filters by root, so normally nothing is dropped; if something is, the free-text answer may
     * describe dropped files and is replaced by a neutral count of what was kept, and a count
     * action is corrected to match.
     */
    public JSONObject confine(JSONObject result) throws Exception {
        JSONArray all = result.optJSONArray("sources");
        if (all == null) { all = new JSONArray(); result.put("sources", all); }
        JSONArray kept = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject s = all.optJSONObject(i);
            if (s != null && inside(s.optString("path", null))) kept.put(s);
        }
        JSONObject action = result.optJSONObject("action");
        JSONArray files = action == null ? null : action.optJSONArray("files");
        if (files != null) {
            JSONArray keptFiles = new JSONArray();
            for (int i = 0; i < files.length(); i++) if (inside(files.optString(i, null))) keptFiles.put(files.get(i));
            action.put("files", keptFiles);
        }
        if (kept.length() == all.length()) return result;
        JSONObject ctx = result.optJSONObject("context");
        boolean ko = ctx != null && ctx.optBoolean("korean");
        result.put("sources", kept);
        result.put("answer", kept.length() == 0
                ? (ko ? "이 폴더에는 맞는 파일이 없어요." : "Nothing in this folder matched.")
                : (ko ? "이 폴더에서 " + kept.length() + "개를 찾았어요."
                      : "Found " + kept.length() + (kept.length() == 1 ? " file" : " files") + " in this folder."));
        if (action != null && "count".equals(action.optString("type"))) action.put("count", kept.length());
        return result;
    }

    private static boolean isSystem(String p) {
        int slash = p.indexOf('/');
        return (slash < 0 ? p : p.substring(0, slash)).equalsIgnoreCase(".aindrive");
    }

    private static String stripSlashes(String p) {
        int a = 0, b = p.length();
        while (a < b && p.charAt(a) == '/') a++;
        while (b > a && p.charAt(b - 1) == '/') b--;
        return p.substring(a, b);
    }
}
