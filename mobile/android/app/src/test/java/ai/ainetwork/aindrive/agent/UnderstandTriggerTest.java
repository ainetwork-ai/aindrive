package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;

/**
 * One test per row of the trigger table in the LLM-understanding spec: the model is asked
 * only after the thin branches of Router.route. Turns come from the real rules (gazetteer
 * loaded), so a row that stops matching its branch fails here, not on the phone.
 */
public class UnderstandTriggerTest {
    static final long NOW = AskScenariosTest.at("2026-09-24");
    static QueryParser parser;

    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream(new File("src/main/assets/geo/cities.tsv.gz"))) { parser = new QueryParser(GeoLookup.loadGzip(in)); }
    }

    static Router.Turn turn(String q, JSONObject ctx) { return Router.understand(parser, q, NOW, ctx); }

    static boolean unsure(String q, JSONObject ctx) {
        Router.Turn t = turn(q, ctx);
        return UnderstandTrigger.unsure(t, t.query != null ? t.query : t.parsed);
    }

    static JSONObject afterParisPhotos() throws Exception {
        return new JSONObject().put("kind", "photo").put("city", "Paris").put("country", "FR").put("keywords", new org.json.JSONArray());
    }

    @Test public void chatFromPatternsIsNever() {
        for (String q : new String[]{"hi", "thanks, that's all", "good morning", "hey there"}) {
            Router.Turn t = turn(q, null);
            assertEquals(q, Router.Route.CHAT, t.route);
            assertFalse(q, UnderstandTrigger.unsure(t, t.parsed));
        }
    }

    @Test public void socialChatIsNever() {
        Router.Turn t = turn("I love hiking with my dog", null);
        assertEquals(Router.Route.CHAT, t.route);
        assertEquals(Router.Why.SOCIAL, t.why);
        assertFalse(t.hint);
        assertFalse(t.question);
        assertFalse(UnderstandTrigger.unsure(t, t.parsed));
    }

    @Test public void callsIsNever() {
        Router.Turn t = turn("who do I call the most?", null);
        assertEquals(Router.Route.CALLS, t.route);
        assertFalse(UnderstandTrigger.unsure(t, t.query));
    }

    @Test public void namedKindWithFilterIsStrong() {
        Router.Turn t = turn("photos from Paris last summer", null);
        assertEquals(Router.Route.FILES, t.route);
        assertEquals(Router.Why.NAMED, t.why);
        assertEquals(0, t.query.ignoredWords);
        assertFalse(UnderstandTrigger.unsure(t, t.query));
    }

    /** "what's in this folder?" (#146): the rules are sure (a file word, nothing thrown away) — the model is not asked. */
    @Test public void whatsInThisFolderIsStrong() {
        Router.Turn t = turn("what's in this folder?", null);
        assertEquals(Router.Route.FILES, t.route);
        assertEquals("FindFiles", t.intent);
        assertFalse(UnderstandTrigger.unsure(t, t.query));
    }

    @Test public void followUpWithNothingThrownAwayIsStrong() throws Exception {
        Router.Turn t = turn("and share them", afterParisPhotos());
        assertEquals(Router.Route.FILES, t.route);
        assertEquals(Router.Why.FOLLOW_UP, t.why);
        assertEquals(0, t.query.ignoredWords);
        assertFalse(UnderstandTrigger.unsure(t, t.query));
    }

    @Test public void followUpWithAWordThrownAwayIsUnsure() throws Exception {
        Router.Turn t = turn("only the ones from last week I promised", afterParisPhotos());
        assertEquals(Router.Route.FILES, t.route);
        assertEquals(Router.Why.FOLLOW_UP, t.why);
        assertTrue("ignored " + t.query.ignoredWords, t.query.ignoredWords > 0);
        assertTrue(UnderstandTrigger.unsure(t, t.query));
    }

    @Test public void bareSearchBoxIsStrong() {
        for (String q : new String[]{"Paris", "last winter in Tokyo", "dog"}) {
            Router.Turn t = turn(q, null);
            assertEquals(q, Router.Route.FILES, t.route);
            assertEquals(q, Router.Why.SEARCH_BOX, t.why);
            assertFalse(q, UnderstandTrigger.unsure(t, t.query));
        }
    }

    @Test public void outWithNoFileHintIsStrong() {
        for (String q : new String[]{"book a table for 4", "what's the weather like?", "call me a cab"}) {
            Router.Turn t = turn(q, null);
            assertEquals(q, Router.Route.OUT, t.route);
            assertFalse(q, t.hint);
            assertFalse(q, UnderstandTrigger.unsure(t, t.parsed));
        }
    }

    @Test public void outWithAPlaceIsUnsure() {
        Router.Turn t = turn("book a table for 4 in Jeju", null);
        assertEquals(Router.Route.OUT, t.route);
        assertTrue(t.hint);
        assertTrue(UnderstandTrigger.unsure(t, t.parsed));
    }

    @Test public void outAfterAFileSearchIsUnsure() throws Exception {
        Router.Turn t = turn("I need to book a table for four at a nice restaurant tonight please", afterParisPhotos());
        assertEquals(Router.Route.OUT, t.route);
        assertFalse(t.hint);
        assertTrue(t.afterFiles);
        assertTrue(UnderstandTrigger.unsure(t, t.parsed));
    }

    /** The social fall-through is the OUT row's twin: a weak kind, place or date word seen, or a question, and the model is asked. */
    @Test public void socialFallThroughWithAHintOrAQuestionIsUnsure() {
        for (String q : new String[]{"the slides at the park", "show me the stuff from last spring", "show me the stuff from the Jeju trip last spring", "이번 여름에 부산에서 찍은 거 보여줘"}) {
            Router.Turn t = turn(q, null);
            assertEquals(q, Router.Route.CHAT, t.route);
            assertEquals(q, Router.Why.SOCIAL, t.why);
            assertTrue(q, t.hint);
            assertTrue(q, UnderstandTrigger.unsure(t, t.parsed));
        }
        Router.Turn t = turn("anything from Sam's wedding?", null);
        assertEquals(Router.Why.SOCIAL, t.why);
        assertFalse(t.hint);
        assertTrue(t.question);
        assertTrue(UnderstandTrigger.unsure(t, t.parsed));
    }

    @Test public void filesWithTwoWordsThrownAwayIsUnsure() {
        Router.Turn t = turn("show me the photos I promised to forward to the accountant", null);
        assertEquals(Router.Route.FILES, t.route);
        assertTrue("ignored " + t.query.ignoredWords, t.query.ignoredWords >= 2);
        assertTrue(UnderstandTrigger.unsure(t, t.query));
    }

    @Test public void filesWithOneWordThrownAwayOnANamedKindIsStrong() {
        Router.Turn t = turn("the photos I promised", null);
        assertEquals(Router.Route.FILES, t.route);
        assertEquals(Router.Why.NAMED, t.why);
        assertEquals(1, t.query.ignoredWords);
        assertFalse(UnderstandTrigger.unsure(t, t.query));
    }
}
