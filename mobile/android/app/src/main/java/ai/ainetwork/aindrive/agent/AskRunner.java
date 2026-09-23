package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.clip.ClipEmbedder;
import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * The on-device agent: parse → filter the file index → recognise → answer.
 *
 * Hard constraints (kind, place, date, size) come from the index. Content
 * words are matched three ways, in this order of trust:
 *   1. the file NAME contains the word;
 *   2. the TRANSCRIPT of a recording contains the word (speech recognition);
 *   3. the PHOTO looks like the word (CLIP: "a photo of a dog" vs each image).
 * Rows are ranked name > transcript > photo score, then newest first.
 *
 * Returns the same `{ answer, sources: [{ path, snippet }] }` the desktop
 * agent-ask returns, so the web UI needs no change. When nothing matches,
 * constraints are relaxed one at a time and the answer says which.
 */
public final class AskRunner {
    public static final int LIMIT = 50;
    /** CLIP cosine at/above which a photo "is" the query (calibrated on real photos: matches ≈ .19–.31, others ≈ .10–.15). */
    public static final float CLIP_MIN = 0.17f;
    /** Also drop anything more than this below the best photo — the tail of near-misses. */
    public static final float CLIP_MARGIN = 0.08f;

    private final FileIndex index;
    private final GeoLookup geo;
    private final QueryParser parser;
    private final Supplier<ClipEmbedder> clip;

    public AskRunner(FileIndex index, GeoLookup geo, Supplier<ClipEmbedder> clip) {
        this.index = index;
        this.geo = geo;
        this.parser = new QueryParser(geo);
        this.clip = clip;
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

        List<String> relaxed = new ArrayList<>();
        Map<String, Hit> hits = search(q);
        if (hits.isEmpty() && !q.keywords.isEmpty()) { q.keywords.clear(); relaxed.add("keyword"); hits = search(q); }
        if (hits.isEmpty() && q.dateFrom != null) { q.dateFrom = null; q.dateTo = null; relaxed.add("date"); hits = search(q); }
        if (hits.isEmpty() && q.city != null) { q.city = null; relaxed.add("city"); hits = search(q); }
        if (hits.isEmpty() && q.country != null) { q.country = null; relaxed.add("country"); hits = search(q); }
        if (hits.isEmpty() && q.kind != null) { q.kind = null; relaxed.add("kind"); hits = search(q); }

        List<Hit> ranked = new ArrayList<>(hits.values());
        ranked.sort((a, b) -> {
            if (a.tier != b.tier) return Integer.compare(a.tier, b.tier);
            if (a.tier != 0 && a.score != b.score) return Float.compare(b.score, a.score);
            long ta = a.row.whenMs == null ? 0 : a.row.whenMs, tb = b.row.whenMs == null ? 0 : b.row.whenMs;
            return Long.compare(tb, ta);
        });
        if (ranked.size() > LIMIT) ranked = ranked.subList(0, LIMIT);

        JSONArray sources = new JSONArray();
        boolean anyContent = false, anySpeech = false;
        for (Hit h : ranked) {
            sources.put(new JSONObject().put("path", h.row.path).put("snippet", snippet(h)).put("matchedBy", h.how));
            anyContent |= h.tier == 2;
            anySpeech |= h.tier == 1;
        }
        out.put("answer", answerFor(q, ranked, relaxed, anyContent, anySpeech));
        out.put("sources", sources);
        return out;
    }

    private static final class Hit {
        final FileIndex.Row row; final int tier; final float score; final String how; final @Nullable String excerpt;
        Hit(FileIndex.Row r, int tier, float score, String how, @Nullable String excerpt) { row = r; this.tier = tier; this.score = score; this.how = how; this.excerpt = excerpt; }
    }

    /** All rows matching the hard filters, each with the strongest way its content matched. */
    private Map<String, Hit> search(SearchQuery q) throws Exception {
        Map<String, Hit> out = new LinkedHashMap<>();
        FileIndex.Filter base = new FileIndex.Filter();
        base.kind = q.kind; base.country = q.country; base.city = q.city;
        base.dateFrom = q.dateFrom; base.dateTo = q.dateTo; base.minSize = q.minSize;

        if (q.keywords.isEmpty()) {
            for (FileIndex.Row r : index.query(base, LIMIT)) out.put(r.docId, new Hit(r, 0, 0, "filter", null));
            return out;
        }

        // 1. name
        FileIndex.Filter byName = copy(base);
        byName.keywords = new ArrayList<>(q.keywords);
        for (FileIndex.Row r : index.query(byName, LIMIT)) out.put(r.docId, new Hit(r, 0, 0, "name", null));

        // 2. transcript (recordings and videos only — the index stores transcripts for those)
        List<String> content = QueryParser.contentWords(q.keywords);
        if (content.isEmpty()) return out;
        FileIndex.Filter bySpeech = copy(base);
        bySpeech.keywords = new ArrayList<>(content);
        bySpeech.keywordsInTranscript = true;
        // Any keyword heard is a candidate; but when some recording matched
        // several words ("meeting" + "patience"), the ones that matched only
        // the generic word are noise, so keep the best tier only.
        List<Hit> speechHits = new ArrayList<>();
        int bestWords = 0;
        for (FileIndex.Row r : index.query(bySpeech, LIMIT)) {
            if (out.containsKey(r.docId) || r.transcript == null) continue;
            String lower = r.transcript.toLowerCase(Locale.ROOT);
            int hitWords = 0;
            for (String k : content) if (lower.contains(k.toLowerCase(Locale.ROOT))) hitWords++;
            bestWords = Math.max(bestWords, hitWords);
            speechHits.add(new Hit(r, 1, hitWords, "speech", excerpt(r.transcript, content)));
        }
        for (Hit h : speechHits) if (bestWords < 2 || h.score >= bestWords) out.put(h.row.docId, h);

        // 3. what the photo looks like
        ClipEmbedder emb = clip.get();
        boolean photoish = q.kind == null || FileIndex.PHOTO.equals(q.kind) || FileIndex.SCREENSHOT.equals(q.kind);
        if (emb != null && photoish) {
            FileIndex.Filter withVec = copy(base);
            withVec.withVec = true;
            if (withVec.kind == null) withVec.kind = FileIndex.PHOTO;
            List<FileIndex.Row> photos = index.query(withVec, 0);
            if (!photos.isEmpty()) {
                StringBuilder en = new StringBuilder();
                for (String k : content) en.append(en.length() > 0 ? " " : "").append(ContentWords.toEnglish(k));
                float[] t = emb.embedText("a photo of " + en);
                List<Object[]> scored = new ArrayList<>();
                float best = 0;
                for (FileIndex.Row r : photos) {
                    float[] v = r.vector();
                    if (v == null) continue;
                    float s = ClipEmbedder.dot(v, t);
                    best = Math.max(best, s);
                    scored.add(new Object[]{r, s});
                }
                float cut = Math.max(CLIP_MIN, best - CLIP_MARGIN);
                for (Object[] o : scored) {
                    FileIndex.Row r = (FileIndex.Row) o[0]; float s = (Float) o[1];
                    if (s >= cut && !out.containsKey(r.docId)) out.put(r.docId, new Hit(r, 2, s, "photo", null));
                }
            }
        }
        return out;
    }

    private static FileIndex.Filter copy(FileIndex.Filter f) {
        FileIndex.Filter c = new FileIndex.Filter();
        c.kind = f.kind; c.country = f.country; c.city = f.city; c.dateFrom = f.dateFrom; c.dateTo = f.dateTo; c.minSize = f.minSize;
        return c;
    }

    /** A short window of the transcript around the first keyword, for the result row. */
    static String excerpt(String transcript, List<String> keywords) {
        String lower = transcript.toLowerCase(Locale.ROOT);
        int at = -1;
        for (String k : keywords) { at = lower.indexOf(k.toLowerCase(Locale.ROOT)); if (at >= 0) break; }
        if (at < 0) at = 0;
        int from = Math.max(0, at - 40), to = Math.min(transcript.length(), at + 60);
        return (from > 0 ? "…" : "") + transcript.substring(from, to).trim() + (to < transcript.length() ? "…" : "");
    }

    private String snippet(Hit h) {
        FileIndex.Row r = h.row;
        StringBuilder s = new StringBuilder();
        if (r.whenMs != null) s.append(new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(r.whenMs));
        if (r.city != null) s.append(s.length() > 0 ? " · " : "").append(r.city);
        if (r.country != null) s.append(r.city != null ? ", " : (s.length() > 0 ? " · " : "")).append(r.country);
        if (r.city == null && r.country == null) s.append(s.length() > 0 ? " · " : "").append(r.kind).append(" · ").append(humanSize(r.size));
        if (h.excerpt != null) s.append(" · “").append(h.excerpt).append("”");
        else if (h.tier == 2) s.append(String.format(Locale.US, " · looks like it (%.0f%%)", Math.min(99, h.score * 300)));
        return s.toString();
    }

    private String answerFor(SearchQuery q, List<Hit> rows, List<String> relaxed, boolean anyContent, boolean anySpeech) {
        boolean ko = q.korean;
        if (rows.isEmpty()) {
            return ko ? "조건에 맞는 파일을 찾지 못했어요." : "No files matched your question.";
        }
        Set<String> cities = new LinkedHashSet<>();
        Set<String> countries = new LinkedHashSet<>();
        Set<String> kinds = new LinkedHashSet<>();
        Long min = null, max = null;
        for (Hit h : rows) {
            FileIndex.Row r = h.row;
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
            if (anyContent && anySpeech) a.append(" 사진 내용과 녹음 내용을 인식해서 찾았어요.");
            else if (anyContent) a.append(" 사진 내용을 인식해서 찾았어요.");
            else if (anySpeech) a.append(" 녹음 내용에서 찾았어요.");
        } else {
            a.append("Found ").append(n).append(" ").append(noun)
             .append(where.isEmpty() ? "" : " taken in " + where).append(when.isEmpty() ? "" : " (" + when + ")").append(".");
            if (anyContent && anySpeech) a.append(" Matched by what the photos show and what the recordings say.");
            else if (anyContent) a.append(" Matched by what the photos show.");
            else if (anySpeech) a.append(" Matched by what the recordings say.");
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
            case FileIndex.AUDIO: return ko ? "녹음" : (n == 1 ? "recording" : "recordings");
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
            case "keyword": return "내용";
            case "city": return "도시";
            case "date": return "날짜";
            case "kind": return "종류";
            default: return "국가";
        }
    }

    private static String relaxedEn(String r) {
        switch (r) {
            case "keyword": return "ignoring the content words";
            case "city": return "ignoring the city";
            case "date": return "ignoring the date";
            case "kind": return "ignoring the file type";
            default: return "ignoring the country";
        }
    }
}
