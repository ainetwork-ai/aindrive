package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The parser half of the 100 task scenarios (scripts/make-task-scenarios.py),
 * against the real gazetteer: every task must be recognised as the right
 * kind of task with its filters and no stray content words. The device run
 * (scripts/run-task-scenarios.py) then checks what the agent actually did.
 */
public class TaskScenariosTest {
    static GeoLookup geo;

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { geo = GeoLookup.loadGzip(in); }
    }

    @Test
    public void allTasksParse() throws Exception {
        QueryParser parser = new QueryParser(geo);
        byte[] b = getClass().getResourceAsStream("/task-scenarios.json").readAllBytes();
        JSONArray scen = new JSONObject(new String(b, StandardCharsets.UTF_8)).getJSONArray("scenarios");
        List<String> failures = new ArrayList<>();
        for (int i = 0; i < scen.length(); i++) {
            JSONObject s = scen.getJSONObject(i);
            JSONObject want = s.getJSONObject("action");
            SearchQuery q = parser.parse(s.getString("q"), System.currentTimeMillis());
            String type = want.isNull("type") ? null : want.getString("type");
            List<String> p = new ArrayList<>();
            if ("collect".equals(type) && !q.collect) p.add("not collect");
            if ("move".equals(type) && !(q.move && q.collect)) p.add("not move");
            if ("delete".equals(type) && !q.delete) p.add("not delete");
            if ("count".equals(type) && !q.count) p.add("not count");
            if (want.optBoolean("share") && !q.share) p.add("not share");
            if (s.has("listLength") && q.limit != s.getInt("listLength")) p.add("limit " + q.limit + " ≠ " + s.getInt("listLength"));
            if (s.has("order")) {
                String o = s.getString("order");
                if (o.equals("size") && !q.bySize) p.add("not bySize");
                if (o.equals("oldest") && !q.oldestFirst) p.add("not oldest");
            }
            // Exact-filter tasks (place/kind/date only) must leave no content words behind.
            boolean exact = s.has("folderFiles") || s.has("pendingFiles") || ("count".equals(type) && !s.has("countAtLeast")) || s.has("listLength");
            if (exact && !q.keywords.isEmpty()) p.add("stray keywords " + q.keywords);
            if (!p.isEmpty()) failures.add(s.getString("id") + "  " + s.getString("q") + " → " + String.join(", ", p) + "  [" + q + "]");
        }
        assertEquals(100, scen.length());
        if (!failures.isEmpty()) throw new AssertionError(failures.size() + " task scenarios mis-parsed:\n  " + String.join("\n  ", failures));
    }
}
