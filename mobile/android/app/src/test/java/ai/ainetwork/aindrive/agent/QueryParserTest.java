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
                + "Seoul\tKR\t37.566\t126.9784\t10349312\t서울특별시\n"
                + "Jeju City\tKR\t33.50972\t126.52194\t408000\t제주시\n"
                + "New York City\tUS\t40.71427\t-74.00597\t8804190\t뉴욕 시\n"
                + "Nice\tFR\t43.70313\t7.26608\t342669\t니스\n"
                + "Paris\tUS\t33.66094\t-95.55551\t24782\t\n"
                + "Boulogne-Billancourt\tFR\t48.83333\t2.25\t120071\t불로뉴비양쿠르\n"
                + "Goyang-si\tKR\t37.65639\t126.835\t1073069\t고양시\n"
                + "London\tGB\t51.50853\t-0.12574\t8961989\t런던\n";
        geo = GeoLookup.load(new ByteArrayInputStream(tsv.getBytes(StandardCharsets.UTF_8)));
        parser = new QueryParser(geo);
    }

    @Test
    public void koreanCityWithParticle() {
        SearchQuery q = parser.parse("파리에서 찍은 사진 찾아줘", NOW);
        assertEquals("Paris", q.city);
        assertEquals("FR", q.country);
        assertNull(q.dateFrom);
        assertNull(q.textQuery());
        assertTrue(q.korean);
    }

    @Test
    public void koreanCountry() {
        SearchQuery q = parser.parse("프랑스 여행 갔던 사진", NOW);
        assertEquals("FR", q.country);
        assertNull(q.city);
        assertNull(q.textQuery());
    }

    @Test
    public void lastSummerWithCityAndContent() {
        SearchQuery q = parser.parse("작년 여름 제주시 바다 사진", NOW);
        assertEquals("KR", q.country);
        assertEquals("Jeju City", q.city);
        assertEquals(Long.valueOf(at(2025, 6, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2025, 9, 1)), q.dateTo);
        assertEquals("바다", q.textQuery());
    }

    @Test
    public void yearAndMonthKorean() {
        SearchQuery q = parser.parse("2024년 5월 파리 야경", NOW);
        assertEquals("Paris", q.city);
        assertEquals(Long.valueOf(at(2024, 5, 1)), q.dateFrom);
        assertEquals(Long.valueOf(at(2024, 6, 1)), q.dateTo);
        assertEquals("야경", q.textQuery());
    }

    @Test
    public void englishMultiWordCityAndMonth() {
        SearchQuery q = parser.parse("show me photos from New York in May 2024", NOW);
        assertEquals("New York City", q.city);
        assertEquals("US", q.country);
        assertEquals(Long.valueOf(at(2024, 5, 1)), q.dateFrom);
        assertNull(q.textQuery());
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
        assertNull(q.textQuery());
    }

    @Test
    public void koreanAdminSuffixIsOptional() {
        assertEquals("Seoul", parser.parse("서울 사진", NOW).city);
        assertEquals("Seoul", parser.parse("서울특별시에서 찍은 사진", NOW).city);
        assertEquals("Jeju City", parser.parse("제주 사진", NOW).city);
        assertEquals("New York City", parser.parse("뉴욕 사진", NOW).city);
    }

    @Test
    public void subjectMarkerIsNotStrippedForPlaces() {
        // 고양이 = cat; 고양 = Goyang (KR, 1M people). Only locative particles unlock a place.
        SearchQuery q = parser.parse("고양이 사진 보여줘", NOW);
        assertNull(q.city);
        assertEquals("고양이", q.textQuery());
        assertEquals("Goyang-si", parser.parse("고양에서 찍은 사진", NOW).city);
    }

    @Test
    public void kindsAndRecency() {
        SearchQuery q = parser.parse("recent PDFs", NOW);
        assertEquals("pdf", q.kind);
        assertEquals(Long.valueOf(at(2026, 8, 24)), q.dateFrom);   // NOW is 2026-09-23
        assertNull(q.textQuery());
        q = parser.parse("지난주 스크린샷", NOW);           // 2026-09-23 is a Wednesday → last week = Sep 14–20
        assertEquals("screenshot", q.kind);
        assertEquals(Long.valueOf(at(2026, 9, 14)), q.dateFrom);
        assertEquals(Long.valueOf(at(2026, 9, 21)), q.dateTo);
        q = parser.parse("계약서 pdf 파일", NOW);
        assertEquals("pdf", q.kind);
        assertEquals("계약서", q.textQuery());
        q = parser.parse("큰 영상 파일", NOW);
        assertEquals("video", q.kind);
        assertEquals(Long.valueOf(QueryParser.LARGE_BYTES), q.minSize);
    }

    @Test
    public void taskWordsBecomeActions() {
        SearchQuery q = parser.parse("이번달에 먹은 음식사진만 모아서 폴더로 만들어서 공유해줘", NOW);
        assertEquals("photo", q.kind);
        assertEquals("음식", q.textQuery());
        assertEquals(Long.valueOf(at(2026, 9, 1)), q.dateFrom);
        assertTrue(q.collect);
        assertTrue(q.share);
        q = parser.parse("collect my dog photos into a folder", NOW);
        assertEquals("photo", q.kind);
        assertEquals("dog", q.textQuery());
        assertTrue(q.collect);
        q = parser.parse("강아지 사진", NOW);
        assertTrue(!q.collect && !q.share);
    }

    @Test
    public void moreTaskGrammar() {
        SearchQuery q = parser.parse("파리 사진 몇 장 있어?", NOW);
        assertTrue(q.count); assertEquals("Paris", q.city); assertNull(q.textQuery());
        q = parser.parse("how many screenshots do I have", NOW);
        assertTrue(q.count); assertEquals("screenshot", q.kind); assertNull(q.textQuery());
        q = parser.parse("가장 최근 사진 3장만 보여줘", NOW);
        assertEquals(3, q.limit); assertEquals("photo", q.kind); assertNull(q.textQuery());
        q = parser.parse("가장 큰 파일 5개", NOW);
        assertEquals(5, q.limit); assertTrue(q.bySize); assertNull(q.minSize);
        q = parser.parse("가장 오래된 사진 2장", NOW);
        assertTrue(q.oldestFirst); assertEquals(2, q.limit);
        q = parser.parse("강아지 사진 삭제해줘", NOW);
        assertTrue(q.delete); assertEquals("강아지", q.textQuery()); assertTrue(!q.collect);
        q = parser.parse("스크린샷 전부 폴더로 옮겨줘", NOW);
        assertTrue(q.move && q.collect); assertEquals("screenshot", q.kind); assertNull(q.textQuery());
        q = parser.parse("move the pizza photos into a folder", NOW);
        assertTrue(q.move); assertEquals("pizza", q.textQuery());
    }

    @Test
    public void bareFolderAndLeadingFillers() {
        SearchQuery q = parser.parse("서울 사진 모아서 폴더 만들어", NOW);
        assertTrue(q.collect); assertEquals("Seoul", q.city); assertNull(q.textQuery());
        q = parser.parse("한국 사진 폴더로 정리", NOW);
        assertTrue(q.collect); assertEquals("KR", q.country); assertNull(q.textQuery());
        q = parser.parse("put all the Korea photos in a folder", NOW);
        assertTrue(q.collect); assertEquals("KR", q.country); assertNull(q.textQuery());
        q = parser.parse("share my London photos as a folder", NOW);
        assertTrue(q.share && q.collect); assertEquals("London", q.city); assertNull(q.textQuery());
        q = parser.parse("노을 사진 폴더 만들어", NOW);
        assertTrue(q.collect); assertEquals("노을", q.textQuery());
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
        assertEquals("강아지", q.textQuery());
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
