package ai.ainetwork.aindrive.agent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import ai.ainetwork.aindrive.index.GeoLookup;

import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.TimeZone;

/**
 * The parser is the P1 stand-in for the LLM planner, so its output IS the
 * agent's understanding of the question. A tiny gazetteer keeps the test
 * self-contained; the real one is the bundled GeoNames table.
 */
public class QueryParserTest {
    static GeoLookup geo;
    static QueryParser parser;
    static final long NOW = at(2026, 9, 23);

    @BeforeClass
    public static void load() throws Exception {
        String tsv = "# name\tcountry\tlat\tlon\tpop\tko\n"
                + "Paris\tFR\t48.85341\t2.3488\t2138551\t파리\n"
                + "Seoul\tKR\t37.566\t126.9784\t10349312\t서울\n"
                + "Jeju City\tKR\t33.50972\t126.52194\t408000\t제주시\n"
                + "New York City\tUS\t40.71427\t-74.00597\t8804190\t뉴욕\n"
                + "Nice\tFR\t43.70313\t7.26608\t342669\t니스\n"
                + "Paris\tUS\t33.66094\t-95.55551\t24782\t\n"
                + "Boulogne-Billancourt\tFR\t48.83333\t2.25\t120071\t불로뉴비양쿠르\n";
        geo = GeoLookup.load(new ByteArrayInputStream(tsv.getBytes(StandardCharsets.UTF_8)));
        parser = new QueryParser(geo);
    }

    @Test
    public void koreanCityWithParticle() {
        SearchQuery q = parser.parse("파리에서 찍은 사진 찾아줘", NOW);
        assertEquals("Paris", q.city);
        assertEquals("FR", q.country);
        assertNull(q.dateFrom);
        assertNull(q.textQuery);
        assertTrue(q.korean);
    }

    @Test
    public void koreanCountry() {
        SearchQuery q = parser.parse("프랑스 여행 갔던 사진", NOW);
        assertEquals("FR", q.country);
        assertNull(q.city);
        assertNull(q.textQuery);
    }

    @Test
    public void lastSummerWithCityAndContent() {
        SearchQuery q = parser.parse("작년 여름 제주시 바다 사진", NOW);
        assertEquals("KR", q.country);
        assertEquals("Jeju City", q.city);
        assertEquals(Long.valueOf(at(2025, 6, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2025, 9, 1)), q.dateTo);
        assertEquals("바다", q.textQuery);
    }

    @Test
    public void yearAndMonthKorean() {
        SearchQuery q = parser.parse("2024년 5월 파리 야경", NOW);
        assertEquals("Paris", q.city);
        assertEquals(Long.valueOf(at(2024, 5, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2024, 6, 1)), q.dateTo);
        assertEquals("야경", q.textQuery);
    }

    @Test
    public void englishMultiWordCityAndMonth() {
        SearchQuery q = parser.parse("show me photos from New York in May 2024", NOW);
        assertEquals("New York City", q.city);
        assertEquals("US", q.country);
        assertEquals(Long.valueOf(at(2024, 5, 1)), q.dateFrom);
        assertNull(q.textQuery);
    }

    @Test
    public void englishCountryAliasAndLastYear() {
        SearchQuery q = parser.parse("pictures I took in the UK last year", NOW);
        assertEquals("GB", q.country);
        assertEquals(Long.valueOf(at(2025, 1, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2026, 1, 1)), q.dateTo);
    }

    @Test
    public void lastSummerEnglish() {
        SearchQuery q = parser.parse("photos from Jeju last summer", NOW);
        assertEquals("Jeju City", q.city);
        assertEquals(Long.valueOf(at(2025, 6, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2025, 9, 1)), q.dateTo);
        assertNull(q.textQuery);
    }

    @Test
    public void winterSpansYearBoundary() {
        SearchQuery q = parser.parse("2023년 겨울 사진", NOW);
        assertEquals(Long.valueOf(at(2023, 12, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2024, 3, 1)), q.dateTo);
    }

    @Test
    public void noPlaceNoDateIsContentOnly() {
        SearchQuery q = parser.parse("강아지 사진 보여줘", NOW);
        assertNull(q.country);
        assertNull(q.dateFrom);
        assertEquals("강아지", q.textQuery);
    }

    @Test
    public void biggestCityWinsNameCollision() {
        // Paris, TX (24k) must not shadow Paris, FR.
        GeoLookup.Place p = geo.byPlaceName("paris");
        assertNotNull(p);
        assertEquals("FR", p.country);
    }

    @Test
    public void gpsNearestCity() {
        GeoLookup.City c = geo.nearest(48.8584, 2.2945);   // Eiffel Tower
        assertNotNull(c);
        assertEquals("Paris", c.name);
        assertNull(geo.nearest(0, -30));                   // mid-Atlantic
    }

    static long at(int y, int m, int d) {
        Calendar c = Calendar.getInstance(TimeZone.getDefault());
        c.clear();
        c.set(y, m - 1, d, 0, 0, 0);
        return c.getTimeInMillis();
    }
}
