package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Rule-based question → {@link SearchQuery}. This is the P1 stand-in for the
 * LLM planner: it understands file kinds ("screenshots", "PDF", "영상"), places
 * (via the gazetteer), dates (absolute and relative, Korean and English), size
 * ("large files") and leaves the rest as keywords for the file name.
 *
 * Korean particles are stripped from the END of tokens ("파리에서" → "파리")
 * and the longest place name wins, so "New York" beats "York".
 */
public final class QueryParser {
    /**
     * Particles stripped from the end of a token before it is used as a
     * keyword or date word. The subject markers 이/가 are deliberately absent:
     * they are rare in search questions and 고양이/나비/거미 must stay whole.
     */
    private static final String[] KO_PARTICLES = {
            "에서의", "에서는", "에서", "으로", "로", "까지", "부터", "에는", "에", "의", "은", "는", "을", "를", "과", "와", "도", "랑", "이랑", "하고",
    };
    /**
     * For PLACE matching only the locative/possessive particles are stripped:
     * "고양이" (cat) must not become 고양 (Goyang) just because 이 can be a
     * subject marker. Nobody writes "고양이 사진" meaning the city.
     */
    private static final String[] KO_PLACE_PARTICLES = {
            "에서의", "에서는", "에서", "으로", "로", "까지", "부터", "에는", "에", "의", "은", "는", "도", "랑", "이랑", "하고", "과", "와",
    };
    private static final Set<String> STOP = new HashSet<>(Arrays.asList(
            // Korean
            "찍은", "찍었던", "찍힌", "촬영한", "갔던", "갔을때", "갔을", "여행", "여행갔던", "때", "받은", "만든", "저장한", "저장된", "다운받은", "다운로드한",
            "찾아줘", "찾아", "찾아봐", "찾기", "검색", "보여줘", "보여", "줘", "좀", "다", "모두", "전부", "있어", "있나", "있니", "뭐", "어디", "어떤",
            "내", "나의", "우리", "그", "저", "것", "거", "들", "중", "중에", "중에서", "관련", "관련된", "모든", "전체", "다른", "제일", "가장", "좋은", "이름",
            // "X 얘기한 녹음" — the verbs around a topic word are not the topic
            "얘기한", "얘기", "이야기", "이야기한", "언급된", "언급한", "언급", "나온", "나왔던", "말한", "말했던", "관한", "대한", "다룬", "논의한", "토론한", "설명한", "들어간", "들어있는", "포함된", "나오는",
            // English
            "find", "show", "search", "get", "open", "list", "me", "the", "a", "an", "of", "from", "in", "at", "on", "my", "our", "all", "any", "some", "with", "for", "that", "which",
            "taken", "took", "trip", "travel", "travelled", "traveled", "vacation", "holiday", "please", "i", "we", "were", "was", "named", "called", "about", "best", "good",
            "downloaded", "saved", "received", "sent", "shared",
            "mentioned", "mentions", "mentioning", "talked", "talking", "talks", "discussed", "discussing", "discussion", "said", "says", "where", "when", "who", "someone", "they", "he", "she"
    ));
    /** Kind words, per category. "사진" alone means photos; "파일" means any kind. */
    private static final Map<String, String> KIND_WORDS = new HashMap<>();
    static {
        kinds(FileIndex.PHOTO, "사진", "사진들", "이미지", "포토", "photo", "photos", "picture", "pictures", "pic", "pics", "image", "images", "jpg", "jpeg", "heic");
        kinds(FileIndex.SCREENSHOT, "스크린샷", "스샷", "캡처", "캡쳐", "화면캡처", "screenshot", "screenshots", "screencap", "screencaps", "capture", "captures");
        kinds(FileIndex.VIDEO, "영상", "동영상", "비디오", "영상들", "video", "videos", "movie", "movies", "clip", "clips", "mp4", "mov");
        kinds(FileIndex.AUDIO, "음악", "녹음", "녹음파일", "오디오", "노래", "audio", "music", "song", "songs", "recording", "recordings", "voice", "mp3", "m4a");
        kinds(FileIndex.PDF, "pdf", "pdfs", "pdf들", "피디에프");
        kinds(FileIndex.DOCUMENT, "문서", "문서들", "워드", "한글", "텍스트", "메모", "document", "documents", "doc", "docs", "word", "text", "txt", "hwp", "docx", "notes", "note", "markdown", "md");
        kinds(FileIndex.SPREADSHEET, "엑셀", "스프레드시트", "시트", "excel", "spreadsheet", "spreadsheets", "sheet", "sheets", "xlsx", "xls", "csv");
        kinds(FileIndex.PRESENTATION, "발표자료", "피피티", "프레젠테이션", "슬라이드", "ppt", "pptx", "presentation", "presentations", "slides", "slide", "deck", "keynote");
        kinds(FileIndex.ARCHIVE, "압축", "압축파일", "zip", "archive", "archives", "rar");
        kinds("*", "파일", "파일들", "file", "files", "자료", "것들");
    }
    private static void kinds(String kind, String... words) { for (String w : words) KIND_WORDS.put(w, kind); }

    /** Words the date pass owns. Never tried as places even when the gazetteer has such a city (지난 = Jinan, spring = Spring TX). */
    private static final Set<String> DATE_WORDS = new HashSet<>(Arrays.asList(
            "작년", "올해", "재작년", "지난", "지난달", "이번달", "이번", "지난주", "이번주", "오늘", "어제", "그제", "그저께", "최근", "최근에", "요즘", "봄", "여름", "가을", "겨울",
            "last", "this", "next", "year", "month", "week", "today", "yesterday", "recent", "recently", "latest", "newest",
            "spring", "summer", "autumn", "fall", "winter",
            "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
            "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec"));
    /** English city names that are also everyday words: only a capitalised token means the city. */
    private static final Set<String> NEEDS_CAPITAL = new HashSet<>(Arrays.asList(
            "nice", "spring", "reading", "bath", "orange", "mobile", "buffalo", "phoenix", "jordan", "victoria", "of", "most", "split", "bar", "male", "media"));
    /**
     * "meeting recording about X": words that describe a recording rather than
     * what was said in it. They still match file NAMES (녹음_회의.m4a), but are
     * left out of the transcript and photo matching.
     */
    public static final Set<String> RECORDING_WORDS = new HashSet<>(Arrays.asList(
            "meeting", "meetings", "회의", "미팅", "interview", "인터뷰", "call", "통화", "conversation", "대화", "talk", "강의", "lecture", "voice", "memo", "메모"));

    public static List<String> contentWords(List<String> keywords) {
        List<String> out = new ArrayList<>();
        for (String k : keywords) if (!RECORDING_WORDS.contains(k.toLowerCase(Locale.ROOT))) out.add(k);
        return out;
    }
    private static final Set<String> SIZE_WORDS = new HashSet<>(Arrays.asList("큰", "대용량", "용량큰", "무거운", "large", "big", "huge", "biggest", "largest"));
    private static final Pattern YEAR = Pattern.compile("^(19|20)\\d{2}$");
    private static final Pattern YEAR_MONTH = Pattern.compile("^((?:19|20)\\d{2})[-./]?(0?[1-9]|1[0-2])$");
    private static final Pattern KO_YEAR = Pattern.compile("^((?:19|20)\\d{2})년$");
    private static final Pattern KO_MONTH = Pattern.compile("^(0?[1-9]|1[0-2])월$");
    private static final String[] EN_MONTHS = {"january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december"};
    /** "large" = at least this many bytes. */
    public static final long LARGE_BYTES = 1024 * 1024;
    /** "recent" = the last N days. */
    public static final int RECENT_DAYS = 30;

    private final GeoLookup geo;

    public QueryParser(GeoLookup geo) { this.geo = geo; }

    public SearchQuery parse(String question, long nowMs) {
        SearchQuery q = new SearchQuery();
        q.korean = question.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        List<String> tokens = tokenize(question);
        Calendar now = Calendar.getInstance(TimeZone.getDefault());
        now.setTimeInMillis(nowMs);
        int year = now.get(Calendar.YEAR);

        Integer y = null, m = null;          // absolute year / month
        String season = null;
        long[] window = null;                // explicit [from, to) from day/week/recent words
        boolean[] used = new boolean[tokens.size()];

        // 1. Places: try 3-, 2-, then 1-token spans so multi-word names win.
        for (int span = 3; span >= 1; span--) {
            for (int i = 0; i + span <= tokens.size(); i++) {
                if (anyUsed(used, i, span)) continue;
                if (reservedSpan(tokens, i, span)) continue;
                String raw = String.join(" ", tokens.subList(i, i + span));
                GeoLookup.Place p = placeOf(raw);
                if (p == null) continue;
                if (p.city != null && q.city == null) { q.city = p.city; q.country = p.country; }
                else if (p.city == null && q.country == null) q.country = p.country;
                // A second place ("파리랑 런던") has no slot yet; swallow it rather
                // than let it leak into the keywords.
                Arrays.fill(used, i, i + span, true);
            }
        }

        // 2. Kind, size, dates.
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) continue;
            String t = stripParticles(tokens.get(i));
            String lower = t.toLowerCase(Locale.ROOT);
            String kind = KIND_WORDS.get(lower);
            if (kind == null) kind = KIND_WORDS.get(tokens.get(i).toLowerCase(Locale.ROOT));
            if (kind != null) {
                // "PDF 파일": the specific word wins over the generic one.
                if (q.kind == null || "*".equals(q.kind)) q.kind = kind;
                used[i] = true; continue;
            }
            if (SIZE_WORDS.contains(lower)) { q.minSize = LARGE_BYTES; used[i] = true; continue; }
            Matcher mm;
            if ((mm = YEAR_MONTH.matcher(t)).matches()) { y = Integer.parseInt(mm.group(1)); m = Integer.parseInt(mm.group(2)); used[i] = true; }
            else if (YEAR.matcher(t).matches()) { y = Integer.parseInt(t); used[i] = true; }
            else if ((mm = KO_YEAR.matcher(t)).matches()) { y = Integer.parseInt(mm.group(1)); used[i] = true; }
            else if ((mm = KO_MONTH.matcher(t)).matches()) { m = Integer.parseInt(mm.group(1)); used[i] = true; }
            else if (lower.equals("작년") || lower.equals("last") && next(tokens, i).equals("year")) { y = year - 1; used[i] = true; if (lower.equals("last")) used[i + 1] = true; }
            else if (lower.equals("재작년")) { y = year - 2; used[i] = true; }
            else if (lower.equals("올해") || lower.equals("this") && next(tokens, i).equals("year")) { y = year; used[i] = true; if (lower.equals("this")) used[i + 1] = true; }
            else if (lower.equals("지난달") || lower.equals("last") && next(tokens, i).equals("month")) {
                Calendar c = (Calendar) now.clone(); c.add(Calendar.MONTH, -1);
                y = c.get(Calendar.YEAR); m = c.get(Calendar.MONTH) + 1; used[i] = true; if (lower.equals("last")) used[i + 1] = true;
            }
            else if (lower.equals("이번달") || lower.equals("this") && next(tokens, i).equals("month")) { y = year; m = now.get(Calendar.MONTH) + 1; used[i] = true; if (lower.equals("this")) used[i + 1] = true; }
            else if (lower.equals("오늘") || lower.equals("today")) { window = days(now, 0, 1); used[i] = true; }
            else if (lower.equals("어제") || lower.equals("yesterday")) { window = days(now, -1, 0); used[i] = true; }
            else if (lower.equals("그제") || lower.equals("그저께")) { window = days(now, -2, -1); used[i] = true; }
            else if (lower.equals("이번주") || lower.equals("this") && next(tokens, i).equals("week")) { window = week(now, 0); used[i] = true; if (lower.equals("this")) used[i + 1] = true; }
            else if (lower.equals("지난주") || lower.equals("last") && next(tokens, i).equals("week")) { window = week(now, -1); used[i] = true; if (lower.equals("last")) used[i + 1] = true; }
            else if (lower.equals("최근") || lower.equals("최근에") || lower.equals("요즘") || lower.equals("recent") || lower.equals("recently") || lower.equals("latest") || lower.equals("newest")) {
                window = days(now, -RECENT_DAYS, 1); used[i] = true;
            }
            else if (isSeason(lower) != null) {
                season = isSeason(lower); used[i] = true;
                // "last summer" / "지난 여름" = that season of the previous year.
                if (i > 0 && !used[i - 1]) {
                    String prev = tokens.get(i - 1).toLowerCase(Locale.ROOT);
                    if (prev.equals("last") || prev.equals("지난")) { y = year - 1; used[i - 1] = true; }
                }
            }
            else {
                int mi = monthIndex(lower);
                if (mi > 0) { m = mi; used[i] = true; }
            }
        }
        if ("*".equals(q.kind)) q.kind = null;
        if (window != null) { q.dateFrom = window[0]; q.dateTo = window[1]; }
        else {
            if (season != null && y == null) y = year;      // "여름" alone = this year's summer
            if (m != null && y == null) y = year;            // "5월" alone = this year's May
            if (y != null) applyDate(q, y, m, season);
        }

        // 3. Whatever is left is a keyword for the file name (and, later, CLIP).
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) continue;
            String t = stripParticles(tokens.get(i));
            if (t.isEmpty() || STOP.contains(t.toLowerCase(Locale.ROOT)) || STOP.contains(tokens.get(i).toLowerCase(Locale.ROOT))) continue;
            q.keywords.add(t);
        }
        return q;
    }

    // ------------------------------------------------------------ helpers

    private @Nullable GeoLookup.Place placeOf(String raw) {
        GeoLookup.Place p = geo.byPlaceName(raw);
        if (p != null) return p;
        String stripped = stripPlaceParticles(raw);
        return stripped.equals(raw) ? null : geo.byPlaceName(stripped);
    }

    static String stripPlaceParticles(String tok) {
        for (String p : KO_PLACE_PARTICLES) {
            if (tok.length() > p.length() + 1 && tok.endsWith(p)) return tok.substring(0, tok.length() - p.length());
        }
        return tok;
    }

    static String stripParticles(String tok) {
        for (String p : KO_PARTICLES) {
            if (tok.length() > p.length() + 1 && tok.endsWith(p)) return tok.substring(0, tok.length() - p.length());
        }
        return tok;
    }

    /** A span is off-limits as a place when it holds a date/kind/size word or an uncapitalised ambiguous name. */
    private static boolean reservedSpan(List<String> tokens, int from, int n) {
        for (int i = from; i < from + n; i++) {
            String raw = tokens.get(i);
            String t = stripParticles(raw).toLowerCase(Locale.ROOT);
            if (DATE_WORDS.contains(t) || KIND_WORDS.containsKey(t) || SIZE_WORDS.contains(t)) return true;
            if (n == 1 && NEEDS_CAPITAL.contains(t) && !Character.isUpperCase(raw.charAt(0))) return true;
        }
        return false;
    }

    private static List<String> tokenize(String s) {
        List<String> out = new ArrayList<>();
        s = s.replaceAll("(?i)'s\\b", "");   // "this year's" → "this year"
        for (String t : s.trim().split("[\\s,;!?~()\\[\\]\"']+")) {
            t = t.replaceAll("^[.]+|[.]+$", "");
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    private static boolean anyUsed(boolean[] used, int from, int n) {
        for (int i = from; i < from + n; i++) if (used[i]) return true;
        return false;
    }

    private static String next(List<String> tokens, int i) {
        return i + 1 < tokens.size() ? tokens.get(i + 1).toLowerCase(Locale.ROOT) : "";
    }

    private static @Nullable String isSeason(String t) {
        switch (t) {
            case "봄": case "spring": return "spring";
            case "여름": case "summer": return "summer";
            case "가을": case "autumn": case "fall": return "autumn";
            case "겨울": case "winter": return "winter";
            default: return null;
        }
    }

    private static int monthIndex(String t) {
        // Full name or the usual 3-letter abbreviation ("sep", "sept" is left alone).
        for (int i = 0; i < EN_MONTHS.length; i++) {
            if (t.equals(EN_MONTHS[i]) || t.equals(EN_MONTHS[i].substring(0, 3))) return i + 1;
        }
        return 0;
    }

    private static void applyDate(SearchQuery q, int y, @Nullable Integer m, @Nullable String season) {
        int fromMonth = 1, toMonth = 12, toYear = y;   // inclusive month range
        if (m != null) { fromMonth = m; toMonth = m; }
        else if (season != null) {
            switch (season) {
                case "spring": fromMonth = 3; toMonth = 5; break;
                case "summer": fromMonth = 6; toMonth = 8; break;
                case "autumn": fromMonth = 9; toMonth = 11; break;
                case "winter": fromMonth = 12; toMonth = 2; toYear = y + 1; break;   // Dec y → Feb y+1
            }
        }
        q.dateFrom = startOfMonth(y, fromMonth);
        q.dateTo = toMonth == 12 ? startOfMonth(toYear + 1, 1) : startOfMonth(toYear, toMonth + 1);
    }

    private static long startOfMonth(int y, int m) {
        Calendar c = Calendar.getInstance(TimeZone.getDefault());
        c.clear();
        c.set(y, m - 1, 1, 0, 0, 0);
        return c.getTimeInMillis();
    }

    /** [start of today+fromDays, start of today+toDays). */
    private static long[] days(Calendar now, int fromDays, int toDays) {
        Calendar c = (Calendar) now.clone();
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        Calendar a = (Calendar) c.clone(); a.add(Calendar.DAY_OF_YEAR, fromDays);
        Calendar b = (Calendar) c.clone(); b.add(Calendar.DAY_OF_YEAR, toDays);
        return new long[]{a.getTimeInMillis(), b.getTimeInMillis()};
    }

    /** Monday-based week; offset 0 = this week, -1 = last week. */
    private static long[] week(Calendar now, int offsetWeeks) {
        Calendar c = (Calendar) now.clone();
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
        int dow = (c.get(Calendar.DAY_OF_WEEK) + 5) % 7;   // Mon=0 … Sun=6
        c.add(Calendar.DAY_OF_YEAR, -dow + 7 * offsetWeeks);
        long from = c.getTimeInMillis();
        c.add(Calendar.DAY_OF_YEAR, 7);
        return new long[]{from, c.getTimeInMillis()};
    }
}
