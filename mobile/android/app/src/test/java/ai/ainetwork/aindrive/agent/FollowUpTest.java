package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

public class FollowUpTest {
    static QueryParser parser;
    static final long NOW = 1790000000000L;

    @BeforeClass public static void geo() throws Exception {
        String tsv = "Paris\tFR\t48.85\t2.35\t2000000\t파리\nTokyo\tJP\t35.68\t139.69\t9000000\t도쿄\n";
        parser = new QueryParser(GeoLookup.load(new ByteArrayInputStream(tsv.getBytes(StandardCharsets.UTF_8))));
    }

    private SearchQuery follow(String first, String then) {
        SearchQuery prev = parser.parse(first, NOW);
        return parser.parse(then, NOW, SearchQuery.fromJson(prev.toJson()));
    }

    @Test public void taskOnlyQuestionInheritsTheFilters() {
        SearchQuery q = follow("photos taken in Paris", "collect them into a folder and share it");
        assertEquals("Paris", q.city); assertEquals("photo", q.kind); assertTrue(q.collect); assertTrue(q.share); assertTrue(q.followUp);
        q = follow("dog photos", "how many are there?");
        assertTrue(q.count); assertEquals("[dog]", q.keywords.toString());
        q = follow("파리 사진", "그거 폴더로 모아서 공유해줘");
        assertEquals("Paris", q.city); assertTrue(q.share);
    }

    @Test public void refinementOverridesButKeepsTheRest() {
        SearchQuery q = follow("photos taken in Paris", "only the ones from this month");
        assertEquals("Paris", q.city); assertEquals("photo", q.kind); assertTrue(q.dateFrom != null);
        q = follow("photos from Paris", "and the ones from Tokyo");
        assertEquals("Tokyo", q.city);
    }

    @Test public void aNewQuestionDoesNotInherit() {
        SearchQuery q = follow("photos taken in Paris", "meeting recordings about the budget");
        assertNull(q.city); assertEquals("audio", q.kind); assertFalse(q.followUp);
    }

    @Test public void contextRoundTrips() {
        SearchQuery q = parser.parse("dog photos from Paris this month", NOW);
        SearchQuery back = SearchQuery.fromJson(q.toJson());
        assertEquals(q.city, back.city); assertEquals(q.kind, back.kind); assertEquals(q.dateFrom, back.dateFrom); assertEquals(q.keywords, back.keywords);
        assertNull(SearchQuery.fromJson(parser.parse("share it", NOW).toJson()));   // nothing to carry
    }
}
