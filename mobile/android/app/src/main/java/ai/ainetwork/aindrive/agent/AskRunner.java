package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The on-device agent, P1: parse → filter the file index → answer.
 *
 * Returns the same `{ answer, sources: [{ path, snippet }] }` the desktop
 * agent-ask returns, so the web UI needs no change. When the strict filter
 * finds nothing, constraints are relaxed one at a time — keywords, then date,
 * city, country, kind — and the answer says which, rather than returning an
 * empty list.
 */
public final class AskRunner {
    public static final int LIMIT = 50;

    private final FileIndex index;
    private final GeoLookup geo;
    private final QueryParser parser;

    public AskRunner(FileIndex index, GeoLookup geo) {
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
                    ? "아직 인덱스가 비어 있어요. 앱에서 'Index files'를 눌러 주세요."
                    : "The index is empty — tap 'Index files' in the app first.")
                    .put("sources", new JSONArray());
        }

        // Relax the least-intended constraint first: a person asking for
        // "spring photos from Paris" cares about Paris more than about spring,
        // and a keyword that matches no file name is the weakest signal of all.
        List<String> relaxed = new ArrayList<>();
        List<FileIndex.Row> rows = index.query(toFilter(q), LIMIT);
        if (rows.isEmpty() && !q.keywords.isEmpty()) { q.keywords.clear(); relaxed.add("keyword"); rows = index.query(toFilter(q), LIMIT); }
        if (rows.isEmpty() && q.dateFrom != null) { q.dateFrom = null; q.dateTo = null; relaxed.add("date"); rows = index.query(toFilter(q), LIMIT); }
        if (rows.isEmpty() && q.city != null) { q.city = null; relaxed.add("city"); rows = index.query(toFilter(q), LIMIT); }
        if (rows.isEmpty() && q.country != null) { q.country = null; relaxed.add("country"); rows = index.query(toFilter(q), LIMIT); }
        if (rows.isEmpty() && q.kind != null) { q.kind = null; relaxed.add("kind"); rows = index.query(toFilter(q), LIMIT); }

        JSONArray sources = new JSONArray();
        for (FileIndex.Row r : rows) {
            sources.put(new JSONObject().put("path", r.path).put("snippet", snippet(r)));
        }
        out.put("answer", answerFor(q, rows, relaxed));
        out.put("sources", sources);
        return out;
    }

    private static FileIndex.Filter toFilter(SearchQuery q) {
        FileIndex.Filter f = new FileIndex.Filter();
        f.kind = q.kind; f.country = q.country; f.city = q.city;
        f.dateFrom = q.dateFrom; f.dateTo = q.dateTo; f.minSize = q.minSize;
        f.keywords = new ArrayList<>(q.keywords);
        return f;
    }

    private String snippet(FileIndex.Row r) {
        StringBuilder s = new StringBuilder();
        if (r.whenMs != null) s.append(new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(r.whenMs));
        if (r.city != null) s.append(s.length() > 0 ? " · " : "").append(r.city);
        if (r.country != null) s.append(r.city != null ? ", " : (s.length() > 0 ? " · " : "")).append(r.country);
        if (r.city == null && r.country == null) s.append(s.length() > 0 ? " · " : "").append(r.kind).append(" · ").append(humanSize(r.size));
        return s.toString();
    }

    private String answerFor(SearchQuery q, List<FileIndex.Row> rows, List<String> relaxed) {
        boolean ko = q.korean;
        if (rows.isEmpty()) {
            return ko ? "조건에 맞는 파일을 찾지 못했어요." : "No files matched your question.";
        }
        Set<String> cities = new LinkedHashSet<>();
        Set<String> countries = new LinkedHashSet<>();
        Set<String> kinds = new LinkedHashSet<>();
        Long min = null, max = null;
        for (FileIndex.Row r : rows) {
            if (r.city != null) cities.add(ko && geo.cityKo(r.city) != null ? geo.cityKo(r.city) : r.city);
            if (r.country != null) countries.add(geo.countryName(r.country, ko));
            kinds.add(r.kind);
            if (r.whenMs != null) { min = min == null ? r.whenMs : Math.min(min, r.whenMs); max = max == null ? r.whenMs : Math.max(max, r.whenMs); }
        }
        String onlyKind = kinds.size() == 1 ? kinds.iterator().next() : null;
        String noun = kindNoun(onlyKind, rows.size(), ko);
        String where = describeWhere(cities, countries, ko);
        String when = describeWhen(min, max, ko);
        String n = rows.size() >= LIMIT ? (ko ? LIMIT + "개 이상" : LIMIT + "+") : String.valueOf(rows.size());

        StringBuilder a = new StringBuilder();
        if (!relaxed.isEmpty()) {
            List<String> parts = new ArrayList<>();
            for (String r : relaxed) parts.add(ko ? relaxedKo(r) : relaxedEn(r));
            a.append(ko ? "정확히 일치하는 파일은 없어서 " : "Nothing matched exactly, so ")
             .append(String.join(ko ? "·" : " and ", parts)).append(ko ? " 조건을 빼고 " : " — ");
        }
        if (ko) {
            boolean photoish = onlyKind != null && isPhotoKind(onlyKind);
            if (!where.isEmpty()) a.append(where).append(" ");
            if (!when.isEmpty()) a.append(when).append(" ");
            if (photoish && (!where.isEmpty() || !when.isEmpty())) a.append("찍은 ");
            a.append(noun).append(" ").append(n).append(countKo(onlyKind)).append("를 찾았어요.");
        } else {
            a.append("Found ").append(n).append(" ").append(noun)
             .append(where.isEmpty() ? "" : " taken in " + where).append(when.isEmpty() ? "" : " (" + when + ")").append(".");
        }
        return a.toString();
    }

    private static boolean isPhotoKind(String k) { return FileIndex.PHOTO.equals(k) || FileIndex.SCREENSHOT.equals(k); }

    private static String countKo(@Nullable String kind) {
        if (kind == null) return "개";
        if (isPhotoKind(kind)) return "장";
        if (FileIndex.VIDEO.equals(kind) || FileIndex.AUDIO.equals(kind)) return "개";
        return "건";
    }

    private static String kindNoun(@Nullable String kind, int n, boolean ko) {
        if (kind == null) return ko ? "파일" : (n == 1 ? "file" : "files");
        switch (kind) {
            case FileIndex.PHOTO: return ko ? "사진" : (n == 1 ? "photo" : "photos");
            case FileIndex.SCREENSHOT: return ko ? "스크린샷" : (n == 1 ? "screenshot" : "screenshots");
            case FileIndex.VIDEO: return ko ? "영상" : (n == 1 ? "video" : "videos");
            case FileIndex.AUDIO: return ko ? "오디오 파일" : (n == 1 ? "audio file" : "audio files");
            case FileIndex.PDF: return ko ? "PDF" : (n == 1 ? "PDF" : "PDFs");
            case FileIndex.DOCUMENT: return ko ? "문서" : (n == 1 ? "document" : "documents");
            case FileIndex.SPREADSHEET: return ko ? "스프레드시트" : (n == 1 ? "spreadsheet" : "spreadsheets");
            case FileIndex.PRESENTATION: return ko ? "발표자료" : (n == 1 ? "presentation" : "presentations");
            case FileIndex.ARCHIVE: return ko ? "압축 파일" : (n == 1 ? "archive" : "archives");
            default: return ko ? "파일" : (n == 1 ? "file" : "files");
        }
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

    static String humanSize(long bytes) {
        if (bytes >= 1L << 30) return String.format(Locale.US, "%.1f GB", bytes / (double) (1L << 30));
        if (bytes >= 1L << 20) return String.format(Locale.US, "%.1f MB", bytes / (double) (1L << 20));
        if (bytes >= 1L << 10) return String.format(Locale.US, "%.0f KB", bytes / (double) (1L << 10));
        return bytes + " B";
    }

    private static String relaxedKo(String r) {
        switch (r) {
            case "keyword": return "이름";
            case "city": return "도시";
            case "date": return "날짜";
            case "kind": return "종류";
            default: return "국가";
        }
    }

    private static String relaxedEn(String r) {
        switch (r) {
            case "keyword": return "ignoring the name";
            case "city": return "ignoring the city";
            case "date": return "ignoring the date";
            case "kind": return "ignoring the file type";
            default: return "ignoring the country";
        }
    }
}
