package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * The 100 scenarios in src/test/resources/ask-scenarios.tsv, run against the
 * REAL bundled gazetteer so a regenerated cities.tsv.gz is covered too.
 *
 * Runs as one test that reports every mismatch at once (a table of failures
 * beats 100 red dots); the count of rows is asserted so a truncated file
 * cannot pass silently.
 */
public class AskScenariosTest {
    static final int EXPECTED_ROWS = 100;
    static final long NOW = at("2026-09-24");
    static GeoLookup geo;

    @BeforeClass
    public static void loadGazetteer() throws Exception {
        // Gradle runs unit tests with the module dir as cwd.
        File asset = new File("src/main/assets/geo/cities.tsv.gz");
        assertTrue("gazetteer asset missing: " + asset.getAbsolutePath(), asset.exists());
        try (FileInputStream in = new FileInputStream(asset)) { geo = GeoLookup.loadGzip(in); }
    }

    @Test
    public void allScenarios() throws Exception {
        QueryParser parser = new QueryParser(geo);
        List<String> failures = new ArrayList<>();
        int rows = 0;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                getClass().getResourceAsStream("/ask-scenarios.tsv"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] c = line.split("\t", -1);
                assertEquals("bad row: " + line, 7, c.length);
                rows++;
                SearchQuery q = parser.parse(c[1], NOW);
                String got = row(q.city, q.country, q.dateFrom, q.dateTo, q.textQuery);
                String want = row(nul(c[2]), nul(c[3]), nul(c[4]) == null ? null : at(c[4]),
                        nul(c[5]) == null ? null : at(c[5]), nul(c[6]));
                if (!got.equals(want)) failures.add(c[0] + "  " + c[1] + "\n      want " + want + "\n      got  " + got);
            }
        }
        assertEquals("scenario count", EXPECTED_ROWS, rows);
        if (!failures.isEmpty()) {
            throw new AssertionError(failures.size() + " of " + rows + " scenarios failed:\n  " + String.join("\n  ", failures));
        }
    }

    private static String row(String city, String country, Long from, Long to, String text) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        f.setTimeZone(TimeZone.getDefault());
        return "city=" + city + " country=" + country
                + " from=" + (from == null ? null : f.format(from))
                + " to=" + (to == null ? null : f.format(to))
                + " text=" + text;
    }

    private static String nul(String s) { return s.equals("-") ? null : s; }

    static long at(String ymd) {
        String[] p = ymd.split("-");
        Calendar c = Calendar.getInstance(TimeZone.getDefault());
        c.clear();
        c.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]), 0, 0, 0);
        return c.getTimeInMillis();
    }
}
