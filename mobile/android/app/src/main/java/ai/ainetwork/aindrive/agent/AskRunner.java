package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.index.PhotoIndex;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The on-device agent, P1: parse → filter the photo index → answer.
 *
 * Returns the same `{ answer, sources: [{ path, snippet }] }` the desktop
 * agent-ask returns, so the web UI needs no change. When the strict filter
 * finds nothing, filters are relaxed one at a time (city → date → country) and
 * the answer says so, rather than returning an empty list.
 */
public final class AskRunner {
    public static final int LIMIT = 50;

    private final PhotoIndex index;
    private final GeoLookup geo;
    private final QueryParser parser;

    public AskRunner(PhotoIndex index, GeoLookup geo) {
        this.index = index;
        this.geo = geo;
        this.parser = new QueryParser(geo);
    }

    public JSONObject ask(String question) throws Exception {
        if (question == null || question.trim().isEmpty()) throw new IllegalArgumentException("empty_query");
        SearchQuery q = parser.parse(question, System.currentTimeMillis());
        int indexed = index.count();
        JSONObject out = new JSONObject().put("query", q.toString());

        if (indexed == 0) {
            return out.put("answer", q.korean
                    ? "아직 사진 인덱스가 비어 있어요. 앱에서 'Index photos'를 눌러 주세요."
                    : "The photo index is empty — tap 'Index photos' in the app first.")
                    .put("sources", new JSONArray());
        }

        // Relax the least-intended constraint first: a person asking for
        // "spring photos from Paris" cares about Paris more than about spring.
        List<String> relaxed = new ArrayList<>();
        List<PhotoIndex.Row> rows = index.query(toFilter(q), LIMIT);
        if (rows.isEmpty() && q.dateFrom != null) { q.dateFrom = null; q.dateTo = null; relaxed.add("date"); rows = index.query(toFilter(q), LIMIT); }
        if (rows.isEmpty() && q.city != null) { q.city = null; relaxed.add("city"); rows = index.query(toFilter(q), LIMIT); }
        if (rows.isEmpty() && q.country != null) { q.country = null; relaxed.add("country"); rows = index.query(toFilter(q), LIMIT); }

        JSONArray sources = new JSONArray();
        for (PhotoIndex.Row r : rows) {
            sources.put(new JSONObject().put("path", r.path).put("snippet", snippet(r)));
        }
        out.put("answer", answerFor(q, rows, relaxed, question));
        out.put("sources", sources);
        return out;
    }

    private static PhotoIndex.Filter toFilter(SearchQuery q) {
        PhotoIndex.Filter f = new PhotoIndex.Filter();
        f.country = q.country; f.city = q.city; f.dateFrom = q.dateFrom; f.dateTo = q.dateTo;
        return f;
    }

    private String snippet(PhotoIndex.Row r) {
        StringBuilder s = new StringBuilder();
        if (r.takenAt != null) s.append(new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(r.takenAt));
        if (r.city != null) s.append(s.length() > 0 ? " · " : "").append(r.city);
        if (r.country != null) s.append(r.city != null ? ", " : (s.length() > 0 ? " · " : "")).append(r.country);
        return s.toString();
    }

    private String answerFor(SearchQuery q, List<PhotoIndex.Row> rows, List<String> relaxed, String question) {
        boolean ko = q.korean;
        if (rows.isEmpty()) {
            return ko ? "조건에 맞는 사진을 찾지 못했어요." : "No photos matched your question.";
        }
        Set<String> cities = new LinkedHashSet<>();
        Set<String> countries = new LinkedHashSet<>();
        Long min = null, max = null;
        for (PhotoIndex.Row r : rows) {
            if (r.city != null) cities.add(ko && geo.cityKo(r.city) != null ? geo.cityKo(r.city) : r.city);
            if (r.country != null) countries.add(geo.countryName(r.country, ko));
            if (r.takenAt != null) { min = min == null ? r.takenAt : Math.min(min, r.takenAt); max = max == null ? r.takenAt : Math.max(max, r.takenAt); }
        }
        String where = describeWhere(cities, countries, ko);
        String when = describeWhen(min, max, ko);
        String n = rows.size() >= LIMIT ? (ko ? LIMIT + "장 이상" : LIMIT + "+") : String.valueOf(rows.size());

        StringBuilder a = new StringBuilder();
        if (!relaxed.isEmpty()) {
            List<String> parts = new ArrayList<>();
            for (String r : relaxed) parts.add(ko ? relaxedKo(r) : relaxedEn(r));
            a.append(ko ? "정확히 일치하는 사진은 없어서 " : "Nothing matched exactly, so ")
             .append(String.join(ko ? "·" : " and ", parts)).append(ko ? " 조건을 빼고 " : " — ");
        }
        if (ko) {
            a.append(where.isEmpty() ? "" : where + " ").append(when.isEmpty() ? "" : when + " ")
             .append("찍은 사진 ").append(n).append("장을 찾았어요.");
        } else {
            a.append("Found ").append(n).append(" photo").append(rows.size() == 1 ? "" : "s")
             .append(where.isEmpty() ? "" : " taken in " + where).append(when.isEmpty() ? "" : " (" + when + ")").append(".");
        }
        return a.toString();
    }

    private static String describeWhere(Set<String> cities, Set<String> countries, boolean ko) {
        List<String> parts = new ArrayList<>();
        int i = 0;
        for (String c : cities) { if (i++ < 3) parts.add(c); }
        if (cities.size() > 3) parts.add(ko ? "외 " + (cities.size() - 3) + "곳" : "+" + (cities.size() - 3) + " more");
        String city = String.join(ko ? "·" : ", ", parts);
        String country = countries.size() == 1 ? countries.iterator().next() : "";
        if (city.isEmpty()) return country.isEmpty() ? "" : (ko ? country + "에서" : country);
        if (country.isEmpty()) return ko ? city + "에서" : city;
        return ko ? country + " " + city + "에서" : city + ", " + country;
    }

    private static String describeWhen(@Nullable Long min, @Nullable Long max, boolean ko) {
        if (min == null || max == null) return "";
        SimpleDateFormat f = new SimpleDateFormat(ko ? "yyyy년 M월" : "MMM yyyy", ko ? Locale.KOREAN : Locale.US);
        String a = f.format(min), b = f.format(max);
        return a.equals(b) ? (ko ? a + "에" : a) : (ko ? a + "부터 " + b + " 사이에" : a + " – " + b);
    }

    private static String relaxedKo(String r) {
        switch (r) {
            case "city": return "도시";
            case "date": return "날짜";
            default: return "국가";
        }
    }

    private static String relaxedEn(String r) {
        switch (r) {
            case "city": return "ignoring the city";
            case "date": return "ignoring the date";
            default: return "ignoring the country";
        }
    }
}
