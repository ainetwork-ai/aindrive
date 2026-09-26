package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.index.MemIndex;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The device-speed gate, and AskRunner's use of it with a fake model: a slow device answers with
 * the rules inside the budget, is marked too slow, and never loads the model again; a fast one
 * gets the model's reading.
 */
public class UnderstandGateTest {
    static GeoLookup geo;

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { geo = GeoLookup.loadGzip(in); }
    }

    static UnderstandGate.Store mem(Map<String, String> m) {
        return new UnderstandGate.Store() {
            @Override public String get(String k) { return m.get(k); }
            @Override public void put(String k, String v) { m.put(k, v); }
        };
    }

    @Test public void gateRemembersASlowDevicePerModelFile() {
        Map<String, String> m = new HashMap<>();
        UnderstandGate g = new UnderstandGate(mem(m), "gemma:1:1");
        assertTrue(g.allowed());
        assertEquals(-1, g.lastMs());
        g.record(1500, 4000);
        assertTrue(g.allowed());
        assertEquals(1500, g.lastMs());
        g.record(9000, 4000);
        assertFalse(g.allowed());
        // The same preferences, a new model file: measured afresh.
        UnderstandGate g2 = new UnderstandGate(mem(m), "gemma:2:2");
        assertTrue(g2.allowed());
        assertEquals(-1, g2.lastMs());
        // …and the old one stays closed.
        assertFalse(new UnderstandGate(mem(m), "gemma:1:1").allowed());
    }

    static final String FILES = "{\"route\":\"files\",\"kind\":\"photo\",\"place\":null,\"when\":null,\"content\":[\"wedding\"],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}";

    /** The switch is off in the app (owner's call: too slow on the phones we have); these tests exercise the path behind it. */
    @org.junit.Before public void on() { AskRunner.MODEL_UNDERSTANDING = true; }
    @org.junit.After public void off() { AskRunner.MODEL_UNDERSTANDING = false; }

    @Test public void switchedOffTheModelIsNeverLoaded() throws Exception {
        AskRunner.MODEL_UNDERSTANDING = false;
        AtomicInteger loads = new AtomicInteger();
        AskRunner r = runner(new HashMap<>(), 20, loads, 2000);
        assertEquals("chat", r.route("anything from Sam's wedding?", null).getString("query"));
        assertEquals(0, loads.get());
    }

    static AskRunner runner(Map<String, String> prefs, long modelDelayMs, AtomicInteger loads, long budgetMs) {
        MemIndex ix = new MemIndex();
        Understander.Model slow = (system, ex, user, schema) -> { try { Thread.sleep(modelDelayMs); } catch (InterruptedException ignored) { } return FILES; };
        return new AskRunner(ix, geo, () -> null, null, null, () -> null, () -> null, () -> { }, () -> false)
                .withUnderstanding(() -> { loads.incrementAndGet(); return slow; }, new UnderstandGate(mem(prefs), "m:1"), budgetMs);
    }

    @Test public void slowDeviceAnswersWithTheRulesInsideTheBudgetThenStopsLoading() throws Exception {
        Map<String, String> prefs = new HashMap<>();
        AtomicInteger loads = new AtomicInteger();
        AskRunner r = runner(prefs, 1200, loads, 300);
        String q = "anything from Sam's wedding?";   // the rules are unsure (social fall-through, a question)
        long t0 = System.currentTimeMillis();
        JSONObject a = r.route(q, null);
        long waited = System.currentTimeMillis() - t0;
        assertNotNull(a);
        assertEquals("chat", a.getString("query"));   // the rules' reading, not the model's
        assertTrue("waited " + waited, waited < 1000);
        assertEquals(1, loads.get());
        Thread.sleep(1500);   // the background call finishes and records itself
        assertFalse(new UnderstandGate(mem(prefs), "m:1").allowed());
        assertEquals(1200, Long.parseLong(prefs.get(UnderstandGate.KEY_LAST_MS)), 300);
        r.route(q, null);
        assertEquals("still one load: the gate is closed", 1, loads.get());
    }

    @Test public void fastDeviceGetsTheModelsReadingAndStaysAllowed() throws Exception {
        Map<String, String> prefs = new HashMap<>();
        AtomicInteger loads = new AtomicInteger();
        AskRunner r = runner(prefs, 20, loads, 2000);
        JSONObject a = r.route("anything from Sam's wedding?", null);
        assertEquals("a file search goes to the index: route() has no reply for it", null, a);
        assertTrue(new UnderstandGate(mem(prefs), "m:1").allowed());
        assertTrue(new UnderstandGate(mem(prefs), "m:1").lastMs() >= 0);
    }

    @Test public void sureTurnsNeverTouchTheModel() throws Exception {
        AtomicInteger loads = new AtomicInteger();
        AskRunner r = runner(new HashMap<>(), 20, loads, 2000);
        r.route("hi", null);
        r.route("book a table for 4", null);
        assertEquals(0, loads.get());
    }
}
