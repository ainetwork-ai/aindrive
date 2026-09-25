package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Decides what a chat turn IS before anything touches the index: small talk,
 * a request this agent can't serve, a call-log report, or a file question.
 *
 * The agent only knows the files on this phone. People also type "book me a
 * table for 4", "4 people", "tomorrow at 7pm" — and a file agent that runs
 * those as searches answers with random files ("hi" once listed 50 of them).
 * So a turn is a file question only when it is ABOUT files:
 *  - it names files ("photos", "recordings", "PDF", "사진", "녹음", "folder"),
 *    or an ambiguous kind word with an owner ("my music", "my notes");
 *  - or it asks about calls (the call-log report);
 *  - or it follows a file question ("only the ones from Paris", "and share them");
 *  - or it opens a conversation as a search-box query ("Paris", "last winter
 *    in Tokyo", "dog") — a few words, nothing else.
 * Anything else is out of scope, and a conversation that went out of scope
 * stays there: "San Jose" answering "which city?" is not a photo search.
 *
 * Checked against every user turn of the Schema-Guided Dialogue corpus
 * (22,825 dialogues about restaurants, flights, banks…: none may reach the
 * index) and the in-domain scenario suites (all must).
 */
public final class Router {
    private Router() { }

    public enum Route { CHAT, OUT, CALLS, FILES }

    public static final class Decision {
        public final Route route;
        public final @Nullable String reply;
        public final @Nullable SearchQuery query;
        Decision(Route r, @Nullable String reply, @Nullable SearchQuery q) { route = r; this.reply = reply; query = q; }
    }

    /** Kind words that are also everyday words: "live music", "a text", "a movie tonight", "the slides at the park". */
    static final Set<String> WEAK_KINDS = new HashSet<>(Arrays.asList(
            "movie", "movies", "music", "song", "songs", "clip", "clips", "voice", "word", "text", "notes", "note",
            "sheet", "sheets", "slide", "slides", "deck", "capture", "captures", "archive", "archives", "doc", "docs",
            "keynote", "presentation", "presentations", "audio", "memo", "picture", "md", "markdown", "excel", "zip", "pic", "rar",
            "음악", "노래", "한글", "텍스트", "메모", "시트", "슬라이드", "자료", "것들", "워드", "오디오", "이미지"));

    /** An owner right before it, or a place on the phone, makes a weak kind word mean files: "my music", "songs on my phone" — not "my favourite songs are pop". */
    private static final Pattern OWNED = Pattern.compile(
            "\\b(my|our)\\s+(music|songs?|movies?|clips?|notes?|memos?|voice memos?|audio|slides?|sheets?|docs?|archives?|texts?|presentations?)\\b(?!\\s+(at|is|was|will|starts?|practice|lessons?|class(es)?|teachers?|festival|concert|band|recital)\\b)"
            + "|\\b(on|in|from)\\s+(this|my)\\s+(phone|drive|folder|device|gallery|camera roll)\\b|\\b(saved|downloaded)\\b"
            + "|(내|나의|제|저장된|저장한|다운받은)\\s*(음악|노래|메모|텍스트|슬라이드|자료|오디오)|폰에\\s*있는", Pattern.CASE_INSENSITIVE);

    /** Words of a request sentence, not of a search-box query: "Find me a good restaurant", "I want to eat". */
    private static final Pattern SENTENCE = Pattern.compile(
            "\\b(i|i'm|i'd|me|you|we|us|they|it|is|are|am|be|do|does|did|can|could|would|will|should|want|wanna|need|like|looking|find|get|book|reserve|buy|pay|send|play|watch|listen|go|make|tell|give|help|what|what's|where|when|how|who|which|why|yes|yeah|yep|no|nope|please|sure|right|correct|that|this|there|some|any|else|other|another|the|to|search|show|leaving|leave)\\b"
            + "|[?]|해줘|할래|싶어|주세요|어때|뭐야|언제|누구|왜|예약|알려", Pattern.CASE_INSENSITIVE);

    /** "Drive", "gallery" are also street and shop names ("1450 Creekside Drive", "Reframe Hair Gallery"): only with an owner. */
    private static final Pattern FILE_WORDS = Pattern.compile(
            "\\bfolders?\\b|\\b(my|this|our)\\s+(drive|gallery)\\b|\\bcamera roll\\b|\\bthumbnails?\\b|폴더|드라이브|갤러리|앨범", Pattern.CASE_INSENSITIVE);

    /** Playing media is a player's job, not a file search: "play the song on my kitchen speaker", "what time is my movie playing". */
    private static final Pattern PLAYBACK = Pattern.compile("\\b(play|plays|playing|played|listen|listening|watch|watching|stream|streaming|speakers?|enjoy|mood|jams)\\b", Pattern.CASE_INSENSITIVE);

    /** Signs that a kind word asks for the person's own files. */
    private static final Pattern FILE_INTENT = Pattern.compile(
            "\\b(my|mine|our)\\b|\\b(show|find|search|collect|gather|share|delete|remove|move|copy|open|list|organi[sz]e|count)\\b|\\b(taken|took|saved|downloaded|recorded)\\b|\\bfrom (last|this|(19|20)\\d\\d)\\b"
            + "|내\\s|나의|찍은|보여|찾아|모아|공유|지워|삭제|옮겨|정리", Pattern.CASE_INSENSITIVE);

    /** Talking about pictures is not asking for them: "I saw pictures of that park", "the photos look so good". */
    private static final Pattern NARRATION = Pattern.compile(
            "\\b(i|we)\\s+(saw|have seen|'ve seen|looked at)\\b|\\b(photos?|pictures?)\\s+(look|looks|looked)\\b|\\bpictures? of (their|the hotel|the facilities)", Pattern.CASE_INSENSITIVE);

    private static final Pattern CLOSING = Pattern.compile(
            "^(no[,.!]?\\s*)?(thanks?|thank you|thank you so much|thanks a lot|many thanks|ty|that'?s (all|it|everything)|that is (all|it)|that would be (all|it)|that will be (all|it)|"
            + "nothing (else|more)|no,? that'?s (all|it)|i'?m (good|done|all set)|bye|goodbye|see you|ok(ay)?|great|cool|perfect|awesome|sounds good|got it|i appreciate (it|that)|appreciate it)"
            + "([,.!]+\\s*(that'?s all|that is all|bye|goodbye|thanks?( a lot)?|thank you( so much| very much)?|have a (good|nice|great) (day|one|night)|i appreciate (it|that)))*[.!]*$",
            Pattern.CASE_INSENSITIVE);

    /**
     * @param prev   the file question this one may follow (null when none)
     * @param wasOut the previous turn of this conversation was out of scope
     */
    public static Decision route(QueryParser parser, String question, long nowMs, @Nullable SearchQuery prev, boolean wasOut) {
        String t = question == null ? "" : question.trim();
        if (t.isEmpty()) return new Decision(Route.CHAT, AskRunner.greeting(false), null);
        String chat = AskRunner.smallTalk(t);
        if (chat != null) return new Decision(Route.CHAT, chat, null);
        boolean ko = t.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        if (CLOSING.matcher(t).matches()) return new Decision(Route.CHAT, ko ? "천만에요!" : "You're welcome!", null);

        SearchQuery q = parser.parse(t, nowMs, prev);
        if (q.calls) return new Decision(Route.CALLS, null, q);

        boolean named = false, weak = false;
        for (String k : QueryParser.kindWords(t)) {
            if (WEAK_KINDS.contains(k)) weak = true; else named = true;
        }
        if (named && NARRATION.matcher(t).find()) named = false;
        // Inside a conversation about something else, "I'd like to see some pictures" means pictures of THAT.
        if (named && wasOut && !FILE_INTENT.matcher(t).find()) named = false;
        if (named || FILE_WORDS.matcher(t).find() || weak && OWNED.matcher(t).find() && !PLAYBACK.matcher(t).find()) return new Decision(Route.FILES, null, q);
        if (prev != null && (q.followUp || q.isTaskOnly() || few(q, 2))) return new Decision(Route.FILES, null, q);
        // A search-box query opening the conversation: "Paris", "last winter in Tokyo", "dog".
        if (!wasOut && prev == null && few(q, 1) && !weak && words(t) <= 5 && !SENTENCE.matcher(t).find()
                && (q.keywords.isEmpty() ? q.city != null || q.country != null || q.dateFrom != null : ContentWords.isVisual(q.keywords.get(0))))
            return new Decision(Route.FILES, null, q);
        return new Decision(Route.OUT, outOfScope(ko, wasOut, weak), null);
    }

    /** At most n leftover words: the rest was place/date/kind. */
    private static boolean few(SearchQuery q, int n) { return q.keywords.size() <= n; }

    private static int words(String t) { return t.split("\\s+").length; }

    static String outOfScope(boolean ko, boolean again, boolean weak) {
        String hint = weak ? (ko ? " 폰에 있는 파일을 말하는 거라면 “내 노래 파일”처럼 말해 주세요." : " If you mean files on this phone, say “my songs” or “my videos from last summer”.") : "";
        if (again) return (ko ? "그건 여기서 할 수 없어요 — 이 폰의 파일과 통화 기록만 다뤄요." : "I can't help with that here — I only work with the files and call history on this phone.") + hint;
        return (ko
                ? "그건 제가 할 수 없는 일이에요. 저는 이 폰의 파일을 찾고 정리해요 — 사진, 영상, 녹음, 문서, 통화 기록. 예: “파리에서 찍은 사진”, “이번달 음식 사진 모아서 공유해줘”, “누구랑 제일 많이 통화해?”"
                : "That's not something I can do. I find and organise the files on this phone — photos, videos, recordings, documents and your call history. Try “photos taken in Paris”, “collect this month's food photos and share them”, or “who do I call the most?”.") + hint;
    }
}
