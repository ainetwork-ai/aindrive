package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Locale;

/**
 * The Understander with a FAKE model: canned JSON in, the rules' SearchQuery out. Checks the
 * post-processing and the guards, never the model.
 */
public class UnderstanderTest {
    static final long NOW = AskScenariosTest.at("2026-09-24") + 12L * 3600 * 1000;
    static GeoLookup geo;
    static QueryParser parser;

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { geo = GeoLookup.loadGzip(in); }
        parser = new QueryParser(geo);
    }

    static Understander canned(String json) { return new Understander(geo, (system, examples, user, schema) -> json); }

    static Router.Turn rules(String q, JSONObject ctx) { return Router.understand(parser, q, NOW, ctx); }

    static String ymd(Long ms) { return ms == null ? "-" : new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(ms); }

    @Test public void validJsonBecomesAFileSearch() {
        String q = "anything from Sam's wedding?";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":\"photo\",\"place\":null,\"when\":null,\"content\":[\"wedding\"],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null));
        assertNotNull(t);
        assertEquals(Router.Route.FILES, t.route);
        assertEquals("FindFiles", t.intent);
        assertEquals(Router.Why.MODEL, t.why);
        assertEquals(FileIndex.PHOTO, t.query.kind);
        assertEquals(Arrays.asList("wedding"), t.query.keywords);
        assertNull(t.query.city);
        assertNotNull(t.nextContext);
    }

    @Test public void codeResolvesPlaceAndDate() {
        String q = "show me the stuff from the Jeju trip last spring";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":null,\"place\":\"Jeju\",\"when\":\"last spring\",\"content\":[],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null));
        assertNotNull(t);
        assertEquals("Jeju City", t.query.city);   // the gazetteer's name, as the rules would give it
        assertEquals("KR", t.query.country);
        assertEquals("2025-03-01", ymd(t.query.dateFrom));
        assertEquals("2025-06-01", ymd(t.query.dateTo));
    }

    @Test public void koreanDateAndPlace() {
        String q = "이번 여름에 부산에서 찍은 거 보여줘";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":\"photo\",\"place\":\"부산\",\"when\":\"이번 여름\",\"content\":[],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null));
        assertNotNull(t);
        assertEquals("Busan", t.query.city);
        assertEquals("2026-06-01", ymd(t.query.dateFrom));
        assertEquals("2026-09-01", ymd(t.query.dateTo));
        assertTrue(t.query.korean);
    }

    @Test public void countAndLimitAndLargest() {
        String q = "how many recordings with the bank";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":\"audio\",\"place\":null,\"when\":null,\"content\":[\"bank\"],\"task\":\"count\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null));
        assertNotNull(t);
        assertEquals("CountFiles", t.intent);
        assertEquals(FileIndex.AUDIO, t.query.kind);
        assertEquals(Arrays.asList("bank"), t.query.keywords);
        String q2 = "the 3 biggest clips";
        Router.Turn t2 = canned("{\"route\":\"files\",\"kind\":\"video\",\"place\":null,\"when\":null,\"content\":[],\"task\":\"find\",\"limit\":3,\"oldest\":false,\"largest\":true}")
                .understand(q2, NOW, null, rules(q2, null));
        assertNotNull(t2);
        assertEquals(3, t2.query.limit);
        assertTrue(t2.query.bySize);
        assertNull(t2.query.minSize);
    }

    @Test public void invalidJsonKeepsTheRules() {
        String q = "anything from Sam's wedding?";
        assertNull(canned("I think you want wedding photos").understand(q, NOW, null, rules(q, null)));
        assertNull(canned("{\"route\":\"files\",\"kind\":").understand(q, NOW, null, rules(q, null)));
        assertNull(canned(null).understand(q, NOW, null, rules(q, null)));
        // Prose around the object is fine: the first {…} block is taken.
        assertNotNull(canned("Sure! ```json\n{\"route\":\"files\",\"kind\":\"photo\",\"content\":[\"wedding\"]}\n```").understand(q, NOW, null, rules(q, null)));
    }

    @Test public void filesWithNothingToSearchKeepsTheRules() {
        String q = "hmm what about the other ones";
        assertNull(canned("{\"route\":\"files\",\"kind\":null,\"place\":null,\"when\":null,\"content\":[],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null)));
    }

    @Test public void deleteClaimedByTheModelIsDowngraded() {
        String q = "clean up the ones from Sam's wedding";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":\"photo\",\"place\":null,\"when\":null,\"content\":[\"wedding\"],\"task\":\"delete\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null));
        assertNotNull(t);
        assertEquals("FindFiles", t.intent);
        assertFalse(t.query.delete);
        assertFalse(t.query.move);
        assertFalse(t.query.share);
    }

    /** #146: a folder was made from "what's in this folder?". A model saying collect for it is not a verb the rules saw. */
    @Test public void collectClaimedWithoutTheVerbIsDowngraded() {
        String q = "what's in this folder?";
        Router.Turn r = rules(q, null);
        assertEquals("FindFiles", r.intent);
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":null,\"place\":null,\"when\":null,\"content\":[\"folder\"],\"task\":\"collect\",\"limit\":5,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, r);
        assertNotNull(t);
        assertEquals("FindFiles", t.intent);
        assertFalse(t.query.collect);
        assertTrue(t.query.keywords.isEmpty());   // "folder" is a kind/stop word, not content
    }

    @Test public void collectIsKeptWhenTheRulesSawTheVerb() {
        String q = "gather up the wedding pics into one place";
        Router.Turn r = rules(q, null);
        assertTrue(r.query != null && r.query.collect);
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":\"photo\",\"place\":null,\"when\":null,\"content\":[\"wedding\"],\"task\":\"collect\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, r);
        assertNotNull(t);
        assertEquals("CollectFiles", t.intent);
    }

    @Test public void placeNotInTheMessageIsIgnored() {
        String q = "the stuff from the trip";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":\"photo\",\"place\":\"Tokyo\",\"when\":null,\"content\":[\"trip\",\"temple\"],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, null, rules(q, null));
        assertNotNull(t);
        assertNull(t.query.city);
        assertNull(t.query.country);
        assertTrue("invented content dropped: " + t.query.keywords, t.query.keywords.isEmpty());   // "trip" is an occasion word, "temple" was never said
    }

    @Test public void chatAndOutUseTheRoutersReplies() {
        String q = "anything from Sam's wedding?";
        Router.Turn r = rules(q, null);
        Router.Turn chat = canned("{\"route\":\"chat\"}").understand(q, NOW, null, r);
        assertNotNull(chat);
        assertEquals(Router.Route.CHAT, chat.route);
        assertTrue(chat.social);
        assertEquals(SocialReply.reply(q, false, false), chat.reply);
        assertEquals("social", chat.nextContext.optString("scope"));
        Router.Turn out = canned("{\"route\":\"out\"}").understand(q, NOW, null, r);
        assertNotNull(out);
        assertEquals(Router.Route.OUT, out.route);
        assertEquals("OutOfScope", out.intent);
        assertEquals(r.route == Router.Route.OUT ? r.reply : Router.outOfScope(false, false, false), out.reply);
        assertEquals("out", out.nextContext.optString("scope"));
    }

    @Test public void followUpInheritsThePreviousSearch() throws Exception {
        JSONObject ctx = new JSONObject().put("kind", "photo").put("city", "Paris").put("country", "FR").put("keywords", new org.json.JSONArray());
        String q = "just the ones with the kids in them";
        Router.Turn t = canned("{\"route\":\"files\",\"kind\":null,\"place\":null,\"when\":null,\"content\":[\"kids\"],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}")
                .understand(q, NOW, ctx, rules(q, ctx));
        assertNotNull(t);
        assertEquals(FileIndex.PHOTO, t.query.kind);
        assertEquals("Paris", t.query.city);
        assertEquals(Arrays.asList("kids"), t.query.keywords);
        assertTrue(t.query.followUp);
        assertTrue(Understander.userPrompt(q, SearchQuery.fromJson(ctx)).startsWith("Previous search: {"));
        assertTrue(Understander.userPrompt(q, null).startsWith("Previous search: none"));
    }

    @Test public void overBudgetKeepsTheRules() {
        String q = "anything from Sam's wedding?";
        boolean[] cancelled = {false};
        Understander slow = new Understander(geo, new Understander.Model() {
            @Override public String complete(String s, java.util.List<String[]> ex, String u, String schema) {
                try { Thread.sleep(1500); } catch (InterruptedException ignored) { }
                return "{\"route\":\"files\",\"kind\":\"photo\",\"content\":[\"wedding\"]}";
            }
            @Override public void cancel() { cancelled[0] = true; }
        }, 150);
        long t0 = System.currentTimeMillis();
        assertNull(slow.understand(q, NOW, null, rules(q, null)));
        assertTrue(cancelled[0]);
        assertTrue(System.currentTimeMillis() - t0 < 3000);
    }

    /** The examples are the Mac's (desktop/src/agent/llm.js FEW_SHOT): seven, each a valid answer, user side in prompt form. */
    @Test public void fewShotExamplesAreWellFormed() {
        assertEquals(7, Understander.FEW_SHOT.size());
        for (String[] e : Understander.FEW_SHOT) {
            assertTrue(e[0].startsWith("Previous search: none\nMessage: "));
            assertNotNull(Understander.firstObject(e[1]));
            assertTrue(Arrays.asList("chat", "out", "files").contains(Understander.firstObject(e[1]).optString("route")));
        }
    }

    @Test public void dateWindowFragments() {
        assertEquals("2025-03-01", ymd(QueryParser.dateWindow("last spring", NOW)[0]));
        assertEquals("2026-06-01", ymd(QueryParser.dateWindow("이번 여름", NOW)[0]));
        assertEquals("2024-03-01", ymd(QueryParser.dateWindow("March 2024", NOW)[0]));
        assertEquals("2024-04-01", ymd(QueryParser.dateWindow("March 2024", NOW)[1]));
        assertNull(QueryParser.dateWindow("Jeju", NOW));
        assertNull(QueryParser.dateWindow(null, NOW));
    }
}
