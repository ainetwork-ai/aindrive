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
            "에서의", "에서는", "에서", "으로", "로", "까지", "부터", "에는", "에", "의", "은", "는", "을", "를", "과", "와", "도", "랑", "이랑", "하고", "들만", "만",
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
            "먹은", "먹었던", "마신", "본", "봤던", "샀던", "갔다온", "다녀온",
            // English
            "find", "show", "search", "get", "open", "list", "me", "the", "a", "an", "of", "from", "in", "at", "on", "my", "our", "all", "any", "some", "with", "for", "that", "which",
            "taken", "took", "please", "i", "we", "were", "was", "named", "called", "about", "best", "good",
            "downloaded", "saved", "received", "sent", "shared", "as", "them", "these", "those",
            "mentioned", "mentions", "mentioning", "talked", "talking", "talks", "discussed", "discussing", "discussion", "said", "says", "where", "when", "who", "someone", "they", "he", "she",
            // request scaffolding: "can you find…", "I'm looking for…", "what about…", "OK, then show…"
            "can", "could", "would", "will", "you", "your", "i'm", "im", "m", "i've", "i'd", "am", "is", "are", "be", "been", "do", "does", "did", "have", "has", "had",
            "want", "need", "like", "looking", "look", "see", "pull", "up", "bring", "give", "display", "view", "check", "where's", "whats", "what's",
            "what", "how", "about", "and", "or", "but", "so", "then", "ok", "okay", "alright", "actually", "never", "mind", "hey", "oh", "well", "also", "too", "again",
            "only", "just", "same", "instead", "narrow", "down", "it", "its", "to", "into", "there", "here", "this", "one", "ones", "every", "each", "other", "else", "own", "their",
            "somewhere", "stuff", "things", "thing", "shot", "shoot", "captured", "recorded", "stored", "kept", "made", "created", "have", "got", "phone", "gallery", "camera", "roll",
            "where", "which", "whose", "that", "show", "shows", "showing", "contain", "contains", "containing", "featuring", "includes", "including", "picture", "photo", "any",
            "back", "past", "around", "during", "since", "before", "after", "between", "recording", "file", "files", "mine", "us", "we", "our", "ours", "discuss", "talk"
    ));
    private static final Set<String> TRIP_WORDS = new HashSet<>(Arrays.asList("trip", "travel", "travelled", "traveled", "vacation", "holiday", "holidays", "trips"));
    /** Kind words, per category. "사진" alone means photos; "파일" means any kind. */
    private static final Map<String, String> KIND_WORDS = new HashMap<>();
    static {
        kinds(FileIndex.PHOTO, "사진", "사진들", "이미지", "포토", "photo", "photos", "picture", "pictures", "pic", "pics", "image", "images", "jpg", "jpeg", "heic", "snaps", "snapshots", "shots");
        kinds(FileIndex.SCREENSHOT, "스크린샷", "스샷", "캡처", "캡쳐", "화면캡처", "screenshot", "screenshots", "screencap", "screencaps", "capture", "captures");
        kinds(FileIndex.VIDEO, "영상", "동영상", "비디오", "영상들", "video", "videos", "movie", "movies", "clip", "clips", "mp4", "mov");
        kinds(FileIndex.AUDIO, "음악", "녹음", "녹음파일", "오디오", "노래", "audio", "music", "song", "songs", "recording", "recordings", "voice", "mp3", "m4a");
        kinds(FileIndex.PDF, "pdf", "pdfs", "pdf들", "피디에프");
        kinds(FileIndex.DOCUMENT, "문서", "문서들", "워드", "한글", "텍스트", "메모", "document", "documents", "doc", "docs", "word", "text", "txt", "hwp", "docx", "notes", "note", "markdown", "md");
        kinds(FileIndex.SPREADSHEET, "엑셀", "스프레드시트", "시트", "excel", "spreadsheet", "spreadsheets", "sheet", "sheets", "xlsx", "xls", "csv");
        kinds(FileIndex.PRESENTATION, "발표자료", "피피티", "프레젠테이션", "슬라이드", "ppt", "pptx", "presentation", "presentations", "slides", "slide", "deck", "keynote", "powerpoint", "powerpoints", "decks");
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
    /** Verbs that turn a question into a task. Matched as prefixes of a token ("모아서", "모아", "만들어줘"). */
    private static final String[] COLLECT_WORDS = {"모아", "모아서", "모아줘", "모으", "묶어", "정리", "폴더", "앨범", "collect", "gather", "folder", "album", "organize", "organise", "copy", "복사", "save", "group", "bundle", "throw"};
    private static final String[] MOVE_WORDS = {"옮겨", "옮기", "이동", "move"};
    private static final String[] SHARE_WORDS = {"공유", "링크", "share", "link"};
    private static final String[] DELETE_WORDS = {"삭제", "지워", "지우", "없애", "delete", "remove", "trash", "rid", "wipe", "erase"};
    private static final String[] COUNT_WORDS = {"몇", "개수", "갯수", "count", "number", "how many"};
    private static final String[] OLDEST_WORDS = {"오래된", "옛날", "가장오래된", "oldest", "earliest"};
    private static final String[] TASK_FILLER = {"만들어", "만들고", "만들어서", "만들어줘", "만든", "새", "넣어", "넣고", "해줘", "해서", "하고", "줘", "그리고", "다음", "개야", "개나", "개", "있어", "있니", "있나", "있는지", "알려줘", "알려", "골라", "골라줘", "뽑아", "뽑아줘", "보여줘",
            "then", "and", "make", "create", "put", "into", "new", "them", "it", "me", "there", "are", "is", "do", "i", "have", "tell", "pick", "top", "only", "did", "take", "took", "taken", "just", "to", "get", "of", "my", "ate", "eat", "eaten", "had"};
    private static final Pattern KO_COUNT = Pattern.compile("^(\\d{1,3})(개|장|건|개만|장만|건만)$");
    private static final Pattern EN_COUNT = Pattern.compile("^(\\d{1,3})$");
    /** Bare counters left behind by "몇 장", "몇 개". */
    private static final Set<String> COUNT_UNITS = new HashSet<>(Arrays.asList("장", "개", "건", "번", "곡", "편"));
    private static final Set<String> RECENT_N_WORDS = new HashSet<>(Arrays.asList("가장", "제일", "최근", "최신", "가장최근", "latest", "most", "recent", "newest", "biggest", "largest"));
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

    /** "통화 내역 / call history / who I call most": a report over the call log, not a file search. */
    private static final Pattern CALLS_TASK = Pattern.compile(
            "통화\\s*(내역|기록|녹음|목록|요약|많이)|통화한|통화했|(call|phone)\\s*(history|logs?|records?|recordings?)|\\b(show|list|check|summari[sz]e|rank|sort|analy[sz]e|report (on|of)|review|give me)\\b.{0,24}\\b(my )?(phone |missed |recent )?calls\\b|\\bwho (called|calls) me\\b|who\\s+(do\\s+|did\\s+)?i\\s+(call|talk|phone|speak)"
            + "|\\b(talk|talked|speak|spoke|chat)\\s+(to|with)?\\s*(\\w+\\s+)?(the most|most)\\s+on the phone|\\bwho\\b.*\\bon the phone\\b.*\\bmost|\\b(rank|sort)\\s+my\\s+contacts\\b|\\bpeople i (call|phone|talk to)\\b|who (have|had) i been (calling|phoning|talking to)|\\bcalling the most\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern SHARE_ASK = Pattern.compile("공유|링크|\\bshare|\\blink", Pattern.CASE_INSENSITIVE);

    /** "who likes me the most?", "누가 나를 제일 좋아해?": an affection ranking over calls, not a file search. */
    private static final Pattern LIKES_TASK = Pattern.compile(
            "(^|[.!?]\\s*|\\b(tell me|show me|find out|guess|know)\\s+)who\\s+(likes|loves|cares\\s+about|misses|adores)\\s+me|who('s| is)\\s+(closest|fond)|"
            + "(나를|날|저를|절)\\s*(제일|가장|젤)?\\s*(좋아|사랑|아끼|챙기|그리워)|나\\s*(좋아하는|사랑하는)\\s*사람|누가\\s*(나|날)\\s*(제일|가장)?\\s*(좋아|사랑)",
            Pattern.CASE_INSENSITIVE);

    public static boolean isLikesTask(String question) { return question != null && LIKES_TASK.matcher(question).find(); }

    public static boolean isCallsTask(String question) { return question != null && (CALLS_TASK.matcher(question).find() || isLikesTask(question)); }

    /**
     * Follow-up cues: the question refers to the previous turn's results
     * ("and share them", "only the ones from Paris", "그중 파리 사진만").
     */
    private static final Pattern FOLLOWUP = Pattern.compile(
            "\\b(those|them|these|the ones|of those|of them|among them|the same|that one|this one|the rest|also|too|instead|same but|narrow|now|switch to|change (it )?to|limit it)\\b|^(and|now|then|only|just|but|what about|how about|what if|switch|limit)\\b"
            + "|그중|그 중|그것|그거|그걸|이것들|그것들|얘네|걔네|나머지|거기서|거기에서|그리고|또|만$|중에서|중에", Pattern.CASE_INSENSITIVE);

    public static boolean isFollowUp(String question) { return question != null && FOLLOWUP.matcher(question.trim()).find(); }

    public SearchQuery parse(String question, long nowMs) { return parse(question, nowMs, null); }

    /**
     * `prev` is the previous turn's filters (SearchQuery.fromJson of the
     * context the shell keeps). A question that only says what to DO — or that
     * points back at "those" — is applied to them: missing filters are
     * inherited, given ones override, keywords accumulate.
     */
    public SearchQuery parse(String question, long nowMs, @Nullable SearchQuery prev) {
        SearchQuery q = parseOne(question, nowMs);
        if (prev == null || q.calls) return q;
        boolean refers = isFollowUp(question);
        // "just Seattle", "2023 instead": only a place or a date, nothing else — a refinement of the last question.
        boolean refines = q.kind == null && contentWords(q.keywords).isEmpty() && (q.city != null || q.country != null || q.dateFrom != null);
        if (!q.isTaskOnly() && !refers && !refines) return q;
        if (q.kind == null) q.kind = prev.kind;
        if (q.city == null && q.country == null) { q.city = prev.city; q.country = prev.country; }
        if (q.dateFrom == null && q.dateTo == null) { q.dateFrom = prev.dateFrom; q.dateTo = prev.dateTo; }
        if (q.minSize == null) q.minSize = prev.minSize;
        if (q.limit == 0) q.limit = prev.limit;
        q.oldestFirst |= prev.oldestFirst;
        q.bySize |= prev.bySize;
        for (String k : prev.keywords) if (!q.keywords.contains(k)) q.keywords.add(0, k);
        q.followUp = true;
        return q;
    }

    /**
     * Multi-word kinds and self-corrections, rewritten before tokenising:
     * "screen captures" → "screenshots", "voice memos" → "recordings",
     * "move... no, collect X" → "collect X".
     */
    private static final String[][] PHRASES = {
            {"screen ?captures?|screen ?grabs?|screen ?caps?", "screenshots"},
            {"voice ?memos?|voice recordings?|audio (files?|recordings?)|sound recordings?", "recordings"},
            {"video ?clips?|movies i (shot|took|made|filmed|recorded)|films i (shot|took)|home videos", "videos"},
            {"pdf files?|pdf documents?", "pdfs"},
            {"word (files?|documents?|docs)|text files?", "documents"},
            {"excel (files?|sheets?|spreadsheets?)|google sheets", "spreadsheets"},
            {"slide ?decks?|powerpoint (files?|decks?|presentations?)|keynote files?", "presentations"},
            {"zip (files?|archives?)|compressed files?", "archives"},
            {"(camera )?photographs?", "photos"},
            {"video ?games?|videogames?", "videogames"},
            {"(?<=\\b(the|my|any|all|some) )audio(?! (quality|system|book|books))", "recordings"},
    };
    private static final Pattern[] PHRASE_PATTERNS = new Pattern[PHRASES.length];
    static { for (int i = 0; i < PHRASES.length; i++) PHRASE_PATTERNS[i] = Pattern.compile("\\b(" + PHRASES[i][0] + ")\\b", Pattern.CASE_INSENSITIVE); }
    private static final Pattern SELF_CORRECTION = Pattern.compile("^.*?(\\.\\.\\.|…|—| - )\\s*(no|sorry|i mean|actually|wait)[,.!]?\\s+", Pattern.CASE_INSENSITIVE);

    private static final Pattern THE_US = Pattern.compile("\\b(the )?(US|U\\.S\\.?|U\\.S\\.A\\.?|States)\\b");
    private static final Pattern CALL_ABOUT = Pattern.compile("\\b(the |a |that )?(phone )?call (where|when|in which|about)\\b", Pattern.CASE_INSENSITIVE);

    static String normalise(String question) {
        String s = SELF_CORRECTION.matcher(question).replaceFirst("");
        s = THE_US.matcher(s).replaceAll("USA");
        // "the call where we discussed pricing" is a recording to find, not the call-log report.
        s = CALL_ABOUT.matcher(s).replaceAll("the recording $3");
        for (int i = 0; i < PHRASES.length; i++) s = PHRASE_PATTERNS[i].matcher(s).replaceAll(PHRASES[i][1]);
        return s;
    }

    private static final String NUM = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few)";
    private static final Pattern AGO = Pattern.compile("\\b" + NUM + "\\s+(day|days|week|weeks|month|months|year|years)\\s+ago\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PAST_N = Pattern.compile("\\b(?:in |from |over |during )?(?:the )?(?:past|last)\\s+(?:" + NUM + "\\s+)?(days?|weeks?|months?)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern WEEKEND = Pattern.compile("\\b(last|this|past)\\s+weekend\\b|\\bover the weekend\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern EARLIER_THIS_YEAR = Pattern.compile("\\b(earlier|so far) this year\\b|\\b(from|since) the (start|beginning) of (the|this) year\\b", Pattern.CASE_INSENSITIVE);

    private static int number(String w) {
        switch (w.toLowerCase(Locale.ROOT)) {
            case "a": case "an": case "one": return 1;
            case "two": case "a couple of": return 2;
            case "three": case "a few": return 3;
            case "four": return 4; case "five": return 5; case "six": return 6; case "seven": return 7;
            case "eight": return 8; case "nine": return 9; case "ten": return 10;
            default: return Integer.parseInt(w);
        }
    }

    /** Relative-date phrases the token loop can't see ("3 days ago", "the past week"): [from, to), and the phrase is removed from `sb`. */
    private static @Nullable long[] phraseWindow(StringBuilder sb, Calendar now) {
        Matcher m;
        long[] w = null;
        if ((m = AGO.matcher(sb)).find()) {
            int n = number(m.group(1));
            String unit = m.group(2).toLowerCase(Locale.ROOT);
            if (unit.startsWith("day")) w = days(now, -n, -n + 1);
            else if (unit.startsWith("week")) w = week(now, -n);
            else if (unit.startsWith("month")) { Calendar c = (Calendar) now.clone(); c.add(Calendar.MONTH, -n); w = new long[]{startOfMonth(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1), 0}; w[1] = startOfMonth(c.get(Calendar.YEAR) + (c.get(Calendar.MONTH) == 11 ? 1 : 0), c.get(Calendar.MONTH) == 11 ? 1 : c.get(Calendar.MONTH) + 2); }
            else { int y = now.get(Calendar.YEAR) - n; w = new long[]{startOfMonth(y, 1), startOfMonth(y + 1, 1)}; }
        } else if ((m = PAST_N.matcher(sb)).find()) {
            int n = m.group(1) == null ? 1 : number(m.group(1));
            String unit = m.group(2).toLowerCase(Locale.ROOT);
            int d = unit.startsWith("day") ? n : unit.startsWith("week") ? 7 * n : 30 * n;
            // "the past week" = the last 7 days up to today; but "last week" alone is the calendar week (token loop).
            if (m.group(1) == null && !m.group(0).toLowerCase(Locale.ROOT).contains("past") && !m.group(0).toLowerCase(Locale.ROOT).contains("the")) return null;
            w = days(now, -d, 1);
        } else if ((m = WEEKEND.matcher(sb)).find()) {
            long[] thisWeek = week(now, 0);
            boolean past = !m.group(0).toLowerCase(Locale.ROOT).startsWith("this") || now.get(Calendar.DAY_OF_WEEK) == Calendar.MONDAY;
            long mon = past ? thisWeek[0] : thisWeek[1];
            w = new long[]{mon - 2L * 86400000, mon};
        } else if ((m = EARLIER_THIS_YEAR.matcher(sb)).find()) {
            int y = now.get(Calendar.YEAR);
            w = new long[]{startOfMonth(y, 1), startOfMonth(y + 1, 1)};
        }
        if (w != null) sb.replace(m.start(), m.end(), " ");
        return w;
    }

    private SearchQuery parseOne(String question, long nowMs) {
        question = normalise(question);
        SearchQuery q = new SearchQuery();
        q.korean = question.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        if (isCallsTask(question)) {
            q.calls = true;
            q.likes = isLikesTask(question);
            q.share = SHARE_ASK.matcher(question).find();
            return q;
        }
        Calendar now = Calendar.getInstance(TimeZone.getDefault());
        now.setTimeInMillis(nowMs);
        int year = now.get(Calendar.YEAR);
        StringBuilder text = new StringBuilder(question);
        long[] window = phraseWindow(text, now);   // explicit [from, to) from day/week/recent words
        List<String> tokens = tokenize(text.toString());

        Integer y = null, m = null;          // absolute year / month
        String season = null;
        boolean[] used = new boolean[tokens.size()];
        boolean[] kindTok = new boolean[tokens.size()];

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
                used[i] = true; kindTok[i] = true; continue;
            }
            // "음식사진", "회의영상": a content word glued to a kind word.
            for (String kw : new String[]{"사진", "영상", "동영상", "문서", "녹음", "스크린샷"}) {
                if (lower.length() > kw.length() + 1 && lower.endsWith(kw)) {
                    String k2 = KIND_WORDS.get(kw);
                    if (q.kind == null || "*".equals(q.kind)) q.kind = k2;
                    tokens.set(i, t.substring(0, t.length() - kw.length()));   // leave the content part for step 4
                    kind = "";
                    break;
                }
            }
            if (kind != null) { t = tokens.get(i); lower = t.toLowerCase(Locale.ROOT); }
            if (SIZE_WORDS.contains(lower)) { q.minSize = LARGE_BYTES; q.bySize = true; used[i] = true; continue; }
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
                // "the latest 10 PDFs" is a count in date order, not "from the last 30 days".
                if (!hasCount(tokens)) window = days(now, -RECENT_DAYS, 1);
                used[i] = true;
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
                if (mi > 0) {
                    m = mi; used[i] = true;
                    // "last April" = the most recent April that's over: this year's if it has passed, else last year's.
                    if (i > 0 && !used[i - 1] && tokens.get(i - 1).equalsIgnoreCase("last")) {
                        used[i - 1] = true;
                        y = mi < now.get(Calendar.MONTH) + 1 ? year : year - 1;
                    }
                }
            }
        }
        if ("*".equals(q.kind)) q.kind = null;
        if (window != null) { q.dateFrom = window[0]; q.dateTo = window[1]; }
        else {
            if (season != null && y == null) y = year;      // "여름" alone = this year's summer
            // "5월" alone = this year's May — unless May is still ahead: "photos from December" in September means last December.
            if (m != null && y == null) y = m > now.get(Calendar.MONTH) + 1 ? year - 1 : year;
            if (y != null) applyDate(q, y, m, season);
        }

        // 3. Task words: "모아서 폴더로 만들어서 공유해줘" is an instruction, not content.
        //    Counts ("3개", "5 largest") cap the list; "몇 개" asks for the number only.
        // First pass: is this a task at all? (so fillers before the verb — "put … in a folder" — count too)
        boolean task = false;
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) continue;
            String lower = stripParticles(tokens.get(i)).toLowerCase(Locale.ROOT), raw = tokens.get(i).toLowerCase(Locale.ROOT);
            for (String[] set : new String[][]{MOVE_WORDS, DELETE_WORDS, COLLECT_WORDS, SHARE_WORDS, COUNT_WORDS})
                if (startsWithAny(raw, set) || startsWithAny(lower, set)) task = true;
            if (KO_COUNT.matcher(raw).matches() || EN_COUNT.matcher(raw).matches() || raw.equals("how") && next(tokens, i).equals("many")) task = true;
        }
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) continue;
            String lower = stripParticles(tokens.get(i)).toLowerCase(Locale.ROOT);
            String raw = tokens.get(i).toLowerCase(Locale.ROOT);
            Matcher cm;
            if (startsWithAny(raw, MOVE_WORDS) || startsWithAny(lower, MOVE_WORDS)) { q.move = true; used[i] = true; }
            else if (startsWithAny(raw, DELETE_WORDS) || startsWithAny(lower, DELETE_WORDS)) { q.delete = true; used[i] = true; }
            else if (startsWithAny(raw, COLLECT_WORDS) || startsWithAny(lower, COLLECT_WORDS)) { q.collect = true; used[i] = true; }
            else if (startsWithAny(raw, SHARE_WORDS) || startsWithAny(lower, SHARE_WORDS)) { q.share = true; q.collect = true; used[i] = true; }
            else if (startsWithAny(raw, COUNT_WORDS) || startsWithAny(lower, COUNT_WORDS) || raw.equals("how") && next(tokens, i).equals("many")) { q.count = true; used[i] = true; if (raw.equals("how")) used[i + 1] = true; }
            else if (startsWithAny(raw, OLDEST_WORDS) || startsWithAny(lower, OLDEST_WORDS)) { q.oldestFirst = true; used[i] = true; }
            else if ((cm = KO_COUNT.matcher(raw)).matches() || (cm = EN_COUNT.matcher(raw)).matches()) { q.limit = Integer.parseInt(cm.group(1)); used[i] = true; }
            else if (RECENT_N_WORDS.contains(lower) || COUNT_UNITS.contains(raw)) { used[i] = true; }
            else if (startsWithAny(raw, TASK_FILLER) || startsWithAny(lower, TASK_FILLER)) { if (task || i > 0) used[i] = true; }
        }
        if (q.move) q.collect = true;   // a move is a collect that also removes the originals
        if (q.bySize && q.limit > 0) q.minSize = null;   // "biggest 5" is a ranking, not a floor

        // 4. Whatever is left is a keyword for the file name (and, later, CLIP).
        //    "Japan vacation pictures": the trip is the occasion, not what the photo shows — but a
        //    recording or document ABOUT the vacation is about it.
        boolean media = q.kind == null || FileIndex.PHOTO.equals(q.kind) || FileIndex.VIDEO.equals(q.kind) || FileIndex.SCREENSHOT.equals(q.kind);
        // English: a word is WHAT the file is about only where grammar says so — a thing a photo can show,
        // a modifier right before the kind ("invoice sheets"), or after a topic marker ("about the budget",
        // "of a horse", "with my receipt"). Anything else ("dig up", "bundle", "switch to") is how it was asked.
        boolean bare = q.kind == null && q.city == null && q.country == null && q.dateFrom == null && window == null && y == null && m == null
                && !q.collect && !q.share && !q.delete && !q.count && q.limit == 0;
        boolean grammar = !q.korean && !bare;
        boolean prevKept = false;
        for (int i = 0; i < tokens.size(); i++) {
            if (used[i]) { prevKept = false; continue; }
            String t = stripParticles(tokens.get(i));
            String lower = t.toLowerCase(Locale.ROOT);
            if (t.isEmpty() || STOP.contains(lower) || STOP.contains(tokens.get(i).toLowerCase(Locale.ROOT))) { prevKept = prevKept && DETERMINERS.contains(lower); continue; }
            if (media && TRIP_WORDS.contains(lower)) { prevKept = false; continue; }
            if (grammar && !(ContentWords.isVisual(lower) || beforeKind(tokens, kindTok, i) || afterMarker(tokens, i) || prevKept)) { prevKept = false; q.ignoredWords++; continue; }
            q.keywords.add(t);
            prevKept = true;
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

    /**
     * Korean verbs inflect at the END ("모아", "모아서", "모아줘"), so a prefix
     * match is right; English words do not, and "dog" must not match "do".
     */
    private static boolean startsWithAny(String t, String[] prefixes) {
        boolean hangul = t.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        for (String p : prefixes) {
            boolean pk = p.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
            if (hangul && pk ? t.startsWith(p) : t.equals(p)) return true;
        }
        return false;
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
            // "sunrise snaps" is not Sunrise, Florida: a lowercase word for something a photo shows is that thing.
            if (n == 1 && !Character.isUpperCase(raw.charAt(0)) && ContentWords.isVisual(t)) return true;
        }
        return false;
    }

    /** The file-kind words a question uses ("photos", "사진을" → "사진", "음식사진" → "사진"), lowercased. */
    public static List<String> kindWords(String question) {
        List<String> out = new ArrayList<>();
        for (String raw : tokenize(normalise(question))) {
            String lower = raw.toLowerCase(Locale.ROOT), stripped = stripParticles(raw).toLowerCase(Locale.ROOT);
            if (KIND_WORDS.containsKey(stripped)) { out.add(stripped); continue; }
            if (KIND_WORDS.containsKey(lower)) { out.add(lower); continue; }
            for (String kw : new String[]{"사진", "영상", "동영상", "문서", "녹음", "스크린샷"})
                if (stripped.length() > kw.length() && stripped.endsWith(kw)) { out.add(kw); break; }
        }
        return out;
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

    private static final Set<String> DETERMINERS = new HashSet<>(Arrays.asList("a", "an", "the", "my", "our", "his", "her", "their", "some", "any", "s", "this", "that", "those", "these"));
    private static final Set<String> MARKERS = new HashSet<>(Arrays.asList(
            "about", "of", "with", "mentions", "mentioning", "mentioned", "regarding", "re", "for", "on", "featuring", "showing", "show", "shows",
            "there", "called", "named", "titled", "discussed", "discussing", "discuss", "talked", "talking", "talk", "said", "says", "containing", "contains", "include", "includes", "including"));

    /** "invoice sheets", "certificate notes": the word right before a kind word (determiners aside) names what the files are. */
    private static boolean beforeKind(List<String> tokens, boolean[] kindTok, int i) {
        return i + 1 < tokens.size() && kindTok[i + 1];
    }

    /** "about the budget", "of a horse", "with my receipt", "where there's a boat". */
    private static boolean afterMarker(List<String> tokens, int i) {
        for (int j = i - 1; j >= 0; j--) {
            String w = tokens.get(j).toLowerCase(Locale.ROOT);
            if (DETERMINERS.contains(w)) continue;
            return MARKERS.contains(w);
        }
        return false;
    }

    private static boolean hasCount(List<String> tokens) {
        for (String t : tokens) if (EN_COUNT.matcher(t).matches() || KO_COUNT.matcher(t).matches()) return true;
        return false;
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
