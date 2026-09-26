package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.clip.ClipEmbedder;
import ai.ainetwork.aindrive.clip.SceneLabels;
import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;
import ai.ainetwork.aindrive.speech.SpeechRecognizer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
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
    // Photo matching is zero-shot classification against everyday scenes (clip/SceneLabels), not a cosine cut-off.

    /** What the agent may DO to the folder, provided by the service (SAF on Android). */
    public interface FileOps {
        /** Copy the document with `docId` to `destRel` (parents created). */
        void copy(String docId, String destRel) throws Exception;
        /** Move the file at `fromRel` to `destRel` (parents created). */
        void move(String fromRel, String destRel) throws Exception;
        /** Content URI of an existing folder — lets the shell serve it as a drive of its own. */
        default @Nullable String uriOf(String rel) throws Exception { return null; }
        /** Write a new file (parents created), e.g. a markdown report. */
        default void write(String rel, byte[] data) throws Exception { throw new UnsupportedOperationException("read-only"); }
        /** Open an indexed document for reading (transcription on demand). */
        default @Nullable android.os.ParcelFileDescriptor openFd(String docId) throws Exception { return null; }
        /** False when there is nowhere to write right now (a source with no shared drive on): tasks are reported, not done. */
        default boolean canWrite() { return true; }
    }

    private final FileIndex index;
    private final GeoLookup geo;
    private final QueryParser parser;
    private final Supplier<ClipEmbedder> clip;
    private final @Nullable FileOps ops;
    private final @Nullable CallReport.CallLog callLog;
    private final Supplier<SpeechRecognizer> speech;
    private final Supplier<ai.ainetwork.aindrive.llm.Summarizer> summarizer;
    private final Runnable releaseSummarizer;
    private final Supplier<Boolean> indexerBusy;
    /** Indexes of every call-recordings folder, so one report covers them all. */
    private Supplier<List<FileIndex>> callIndexes = java.util.Collections::emptyList;

    public AskRunner withCallIndexes(Supplier<List<FileIndex>> s) { callIndexes = s; return this; }

    private @Nullable CallReport.Opener callOpener;

    public AskRunner withCallOpener(@Nullable CallReport.Opener o) { callOpener = o; return this; }

    public AskRunner(FileIndex index, GeoLookup geo, Supplier<ClipEmbedder> clip, @Nullable FileOps ops) {
        this(index, geo, clip, ops, null, () -> null, () -> null, () -> { }, () -> false);
    }

    public AskRunner(FileIndex index, GeoLookup geo, Supplier<ClipEmbedder> clip, @Nullable FileOps ops,
                     @Nullable CallReport.CallLog callLog, Supplier<SpeechRecognizer> speech,
                     Supplier<ai.ainetwork.aindrive.llm.Summarizer> summarizer, Runnable releaseSummarizer, Supplier<Boolean> indexerBusy) {
        this.index = index;
        this.geo = geo;
        this.parser = new QueryParser(geo);
        this.clip = clip;
        this.ops = ops;
        this.callLog = callLog;
        this.speech = speech;
        this.summarizer = summarizer;
        this.releaseSummarizer = releaseSummarizer;
        this.indexerBusy = indexerBusy;
    }

    public JSONObject ask(String question) throws Exception { return ask(question, null); }

    /**
     * The reply for a turn that is not a file or call question (small talk, out of scope — see
     * {@link Router}), or null when it is one. Cheap: no index access, so the shell can ask it once
     * before fanning a question out to every folder and device.
     */
    public @Nullable JSONObject route(String question, @Nullable JSONObject context) throws Exception {
        Router.Turn t = Router.understand(parser, question, System.currentTimeMillis(), context);
        if (t.social) {
            String said = chatReply(question);
            if (said != null) return replyOf(t).put("answer", said);
        }
        return replyOf(t);
    }

    /** Chit-chat answered by the on-device LLM when it's there (null → the template reply). */
    private @Nullable String chatReply(String question) {
        if (summarizer == null) return null;
        ai.ainetwork.aindrive.llm.Summarizer llm = null;
        try {
            llm = summarizer.get();
            if (llm == null) return null;
            String out = llm.generate(
                    "You are the aindrive assistant, a friendly helper that lives on the user's phone. You can find, collect and share the files on "
                    + "this phone (photos, videos, recordings, documents) and summarise its call history — nothing else. Chat warmly and naturally in "
                    + "one or two short sentences, in the user's language. Never pretend to be human or to do things you can't. Only when it fits, "
                    + "suggest one thing you could find for them.",
                    question, "chat");
            return out == null ? null : out.trim();
        } catch (RuntimeException e) {
            return null;
        } finally {
            if (llm != null && releaseSummarizer != null) releaseSummarizer.run();
        }
    }

    private static @Nullable JSONObject replyOf(Router.Turn t) throws Exception {
        if (t.route != Router.Route.CHAT && t.route != Router.Route.OUT) return null;
        return new JSONObject().put("answer", t.reply).put("sources", new JSONArray())
                .put("query", t.route == Router.Route.CHAT ? "chat" : "out")
                .put("context", t.nextContext == null ? JSONObject.NULL : t.nextContext);
    }

    /**
     * `context` is the previous turn's filters (this method's own `context`
     * output, kept by the shell) so a follow-up like "and share them" applies
     * to the same files. The result carries the effective filters back.
     */
    public JSONObject ask(String question, @Nullable JSONObject context) throws Exception {
        return ask(question, context, AskScope.ACT_ALL);
    }

    /**
     * The same, limited by `scope` (phone protocol v2, {@link AskScope}): with a root, every
     * source, count and place/year summary is computed over files at or below it; read-only,
     * nothing is collected, moved or marked for deletion and no call report runs (the call log
     * is never read) — the action comes back skipped with reason "read_only". Read-only small
     * talk gets the template reply: the on-device LLM (~1.6 GB, loaded and freed per reply) is
     * not started for a question anyone the server lets ask can send. Asked over the socket
     * ({@link AskScope#remote}), a call report's sources are this drive's own recordings only.
     */
    public JSONObject ask(String question, @Nullable JSONObject context, AskScope scope) throws Exception {
        if (question == null || question.trim().isEmpty()) throw new IllegalArgumentException("empty_query");
        Router.Turn turn = Router.understand(parser, question, System.currentTimeMillis(), context);
        if (turn.social && !scope.readOnly) {
            String said = chatReply(question);
            if (said != null) return replyOf(turn).put("answer", said);
        }
        JSONObject routed = replyOf(turn);
        if (routed != null) return routed;
        SearchQuery q = turn.query;
        JSONObject blocked = scope.blocked(q);
        if (q.calls && (blocked != null || !scope.root.isEmpty())) {
            // Read-only: the report writes files and reads the call log (a transcript reads the call
            // log and the phone's call-recordings folders). Inside a folder: it is about the whole
            // phone. Either way nothing runs, and the call log is never opened.
            JSONObject action = blocked != null ? blocked : AskScope.skipped("collect", AskScope.OUTSIDE_ROOT).put("report", "calls");
            String answer = blocked != null
                    ? (q.transcribe
                        ? (q.korean ? "통화 받아쓰기는 통화 기록과 통화 녹음을 읽어야 해서 하지 않았어요." : "Transcribing a call reads the call history and the call recordings, so I didn't do it.")
                        : (q.korean ? "통화 요약은 통화 기록을 읽고 파일을 만들어야 해서 만들지 않았어요." : "A call report reads the call history and writes a file, so I didn't make one."))
                      + AskScope.onlyLooked(q.korean)
                    : AskScope.reportNeedsWholePhone(q.korean, q.transcribe);
            return new JSONObject().put("answer", answer).put("sources", new JSONArray()).put("action", action)
                    .put("query", "calls").put("context", context == null ? JSONObject.NULL : context);
        }
        if (q.calls) {
            CallReport report = new CallReport(index, callLog, speech, ops, summarizer, indexerBusy).withIndexes(callIndexes.get()).withOpener(callOpener);
            // The call-recordings folders are other folders on the phone: over the socket their paths would be read as this drive's.
            if (scope.remote) report.onlyOwnSources();
            try { return report.run(q, System.currentTimeMillis()).put("query", "calls").put("context", context == null ? JSONObject.NULL : context); }
            finally { releaseSummarizer.run(); }
        }
        // The whole drive's count, on purpose: "the index is empty" means this drive was never
        // indexed. A root with nothing in it is answered by the search below ("nothing matched").
        int indexed = index.count();
        JSONObject out = new JSONObject().put("query", q.toString()).put("context", q.toJson()).put("followUp", q.followUp);

        if (indexed == 0) {
            out.put("answer", (q.korean
                    ? "아직 인덱스가 비어 있어요. 앱에서 'Index files'를 눌러 주세요."
                    : "The index is empty — tap 'Index files' in the app first.")
                    + (blocked != null ? AskScope.onlyLooked(q.korean) : ""))
                    .put("sources", new JSONArray());
            // Read-only: an asked-for act is reported skipped here too, never silently dropped.
            if (blocked != null) out.put("action", blocked);
            return out;
        }

        List<String> relaxed = new ArrayList<>();
        Map<String, Hit> hits = search(q, scope);
        // A bare word that matches nothing ("hi", a typo) is not a request for every file:
        // relax it only when something else (a kind, place, date, size, task) narrows the search.
        boolean onlyWords = q.kind == null && q.country == null && q.city == null && q.dateFrom == null && q.dateTo == null
                && q.minSize == null && !q.collect && !q.delete && !q.count && q.limit == 0 && !q.bySize && !q.oldestFirst;
        if (hits.isEmpty() && !q.keywords.isEmpty() && onlyWords) {
            String w = String.join(" ", q.keywords);
            return out.put("answer", q.korean
                    ? "“" + w + "”와 관련된 파일을 찾지 못했어요. 사진 속 내용(예: 강아지 사진), 장소·날짜(예: 도쿄에서 찍은 사진), 파일 종류(예: 지난주 스크린샷)로 물어보세요."
                    : "Nothing here matches “" + w + "”. Try what a photo shows (\"dog photos\"), a place or date (\"photos from Tokyo\"), or a kind of file (\"last week's screenshots\").")
                    .put("sources", new JSONArray());
        }
        // What the person asked about is never dropped either: "food photos this month" with no food
        // must say so, not list every photo from this month. Likewise a place or a date: "photos taken
        // in Paris" with no Paris photos says so. Only the kind is loosened ("Paris videos" → Paris
        // photos), and only for a bare place/date question.
        if (hits.isEmpty() && q.kind != null && q.keywords.isEmpty() && (q.city != null || q.country != null || q.dateFrom != null)) {
            String kind = q.kind; q.kind = null; relaxed.add("kind"); hits = search(q, scope);
            if (hits.isEmpty()) { q.kind = kind; relaxed.remove("kind"); }
        }

        List<Hit> ranked = new ArrayList<>(hits.values());
        final boolean bySize = q.bySize, oldest = q.oldestFirst;
        ranked.sort((a, b) -> {
            if (bySize) return Long.compare(b.row.size, a.row.size);
            if (a.tier != b.tier) return Integer.compare(a.tier, b.tier);
            if (a.tier != 0 && a.score != b.score) return Float.compare(b.score, a.score);
            long ta = a.row.whenMs == null ? 0 : a.row.whenMs, tb = b.row.whenMs == null ? 0 : b.row.whenMs;
            return oldest ? Long.compare(ta, tb) : Long.compare(tb, ta);
        });
        int total = ranked.size();
        int cap = q.limit > 0 ? Math.min(q.limit, LIMIT) : LIMIT;
        if (ranked.size() > cap) ranked = ranked.subList(0, cap);

        JSONArray sources = new JSONArray();
        boolean anyContent = false, anySpeech = false;
        for (Hit h : ranked) {
            sources.put(CallReport.describeCall(new JSONObject().put("path", h.row.path).put("snippet", snippet(h)).put("matchedBy", h.how), h.row, h.excerpt, null));
            anyContent |= h.tier == 2;
            anySpeech |= h.tier == 1;
        }
        String answer = answerFor(q, ranked, total, relaxed, anyContent, anySpeech, scope);
        // "Photos from 2026" → 1: say where the rest are, so a small number doesn't look like a miss.
        if (q.dateFrom != null && total > 0 && total <= 3 && relaxed.isEmpty()) answer += otherYears(q, scope);
        if (blocked != null) answer += AskScope.onlyLooked(q.korean);
        if (q.count) {
            answer = (q.korean ? "모두 " + total + "개예요. " : "There are " + total + ". ") + answer;
            out.put("action", new JSONObject().put("type", "count").put("count", total));
        }
        out.put("answer", answer);
        out.put("sources", sources);
        boolean exact = !ranked.isEmpty() && relaxed.isEmpty();
        // Lets the service drop this folder's loose matches when another folder matched exactly.
        out.put("relaxed", !relaxed.isEmpty());
        if (blocked != null) {
            // Read-only: say what it would have done, touch nothing (not even a pending delete list).
            out.put("action", blocked);
        } else if (q.delete) {
            // Never delete on the strength of a parse: list what would go and wait for a tap.
            JSONArray files = new JSONArray();
            for (Hit h : ranked) files.put(h.row.path);
            out.put("action", new JSONObject().put("type", "delete").put("pending", true).put("count", exact ? ranked.size() : 0)
                    .put("files", files).put("skipped", !exact).put("reason", exact ? JSONObject.NULL : (ranked.isEmpty() ? "nothing matched" : "only loose matches")));
        } else if (q.collect && ops != null && ops.canWrite() && exact) {
            out.put("action", collect(q, ranked, scope));
        } else if (q.collect) {
            out.put("action", new JSONObject().put("type", q.move ? "move" : "collect").put("skipped", true)
                    .put("reason", ranked.isEmpty() ? "nothing matched" : !relaxed.isEmpty() ? "only loose matches" : "no file access"));
        }
        return out;
    }

    /**
     * Task: copy the matches into a new top-level folder named after the
     * question, e.g. "음식 사진 2026-09". Sharing the folder needs the web
     * session, which lives in the shell, so that step is reported for it.
     */
    private JSONObject collect(SearchQuery q, List<Hit> hits, AskScope scope) throws Exception {
        // Inside the asked-about folder, so an act never writes outside it (the whole drive: top level, as before).
        String folder = scope.collectInto(folderName(q));
        int copied = 0, failed = 0;
        JSONArray files = new JSONArray();
        for (Hit h : hits) {
            String dest = folder + "/" + h.row.name;
            if (h.row.path.equals(dest)) continue;   // already there
            try {
                if (q.move) ops.move(h.row.path, dest); else ops.copy(h.row.docId, dest);
                copied++; files.put(dest);
            } catch (Exception e) { failed++; }
        }
        JSONObject r = new JSONObject().put("type", q.move ? "move" : "collect").put("folder", folder).put("copied", copied).put("failed", failed)
                .put("share", q.share).put("files", files);
        if (copied > 0) { try { r.putOpt("folderUri", ops.uriOf(folder)); } catch (Exception ignored) { } }
        return r;
    }

    /** " Photos here are from Tokyo (120), Seoul (80), …" — so a miss says where to look instead. */
    /** " Others here: 2024 (10), 2023 (1)." — the same search without its date, by year, outside the asked range. */
    private String otherYears(SearchQuery q, AskScope scope) {
        FileIndex.Filter f = filter(scope);
        f.kind = q.kind; f.country = q.country; f.city = q.city; f.minSize = q.minSize;
        Map<Integer, Integer> byYear = new java.util.TreeMap<>(java.util.Collections.reverseOrder());
        Calendar c = Calendar.getInstance();
        for (FileIndex.Row r : index.query(f, 0)) {
            if (r.whenMs == null || r.whenMs >= q.dateFrom && (q.dateTo == null || r.whenMs < q.dateTo)) continue;
            c.setTimeInMillis(r.whenMs);
            byYear.merge(c.get(Calendar.YEAR), 1, Integer::sum);
        }
        if (byYear.isEmpty() || !q.keywords.isEmpty()) return "";
        List<Map.Entry<Integer, Integer>> top = new ArrayList<>(byYear.entrySet());
        top.sort((x, y) -> y.getValue() - x.getValue());
        StringBuilder sb = new StringBuilder(q.korean ? " 다른 해: " : " Others here: ");
        for (int i = 0; i < Math.min(4, top.size()); i++) sb.append(i > 0 ? ", " : "").append(top.get(i).getKey()).append(" (").append(top.get(i).getValue()).append(")");
        return sb.append(".").toString();
    }

    private String knownPlaces(@Nullable String kind, boolean ko, AskScope scope) {
        FileIndex.Filter f = filter(scope);
        f.kind = kind == null ? FileIndex.PHOTO : kind;
        Map<String, Integer> byPlace = new LinkedHashMap<>();
        for (FileIndex.Row r : index.query(f, 0)) {
            if (r.city == null) continue;
            String name = ko && geo.cityKo(r.city) != null ? geo.cityKo(r.city) : r.city;
            byPlace.merge(name, 1, Integer::sum);
        }
        if (byPlace.isEmpty()) return ko ? " 이 폴더의 사진에는 위치 정보가 없어요." : " Photos in this folder have no location.";
        List<Map.Entry<String, Integer>> top = new ArrayList<>(byPlace.entrySet());
        top.sort((a, b) -> b.getValue() - a.getValue());
        StringBuilder sb = new StringBuilder(ko ? " 여기 사진은 이런 곳에서 찍었어요: " : " Photos here are from ");
        for (int i = 0; i < Math.min(5, top.size()); i++) sb.append(i > 0 ? ", " : "").append(top.get(i).getKey()).append(" (").append(top.get(i).getValue()).append(")");
        return sb.append(".").toString();
    }

    private static final java.util.regex.Pattern GREETING = java.util.regex.Pattern.compile(
            "^(hi+|hello+|hey+|yo|hiya|good (morning|afternoon|evening)|thanks?( you)?|thank u|ty|ok(ay)?|cool|nice|great|help|what can you do\\??|who are you\\??|"
            + "안녕(하세요)?|ㅎㅇ|하이|헬로|반가워(요)?|고마워(요)?|감사(합니다|해요)?|ㄱㅅ|좋아(요)?|오케이|ㅇㅋ|도움말|도와줘|뭐 할 수 있어\\??|뭘 할 수 있어\\??|넌 누구야\\??|누구세요\\??)[.!~ ]*$",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    /** Greetings, thanks and "what can you do": a short reply, never a file search. Null when it is a real question. */
    /** Everyday social turns and a friendly answer to each: {pattern, English, Korean}. */
    private static final String[][] SOCIAL = {
            {"(hi|hey|hello)?[, ]*(how are you|how're you|how are you doing|how's it going|how is it going|how have you been|how do you do|what's up|whats up|sup|wassup)( today)?( doing)?",
             "I'm doing well, thanks for asking! How are you? I'm here whenever you want to find or sort something on your phone.",
             "잘 지내요, 물어봐 줘서 고마워요! 당신은요? 폰에서 찾거나 정리할 게 있으면 언제든 말해 주세요."},
            {"(i'?m|i am) (good|great|fine|ok|okay|well|doing well|doing good|not bad|alright)( too| as well)?(,? thanks?( you)?)?( and you)?|not bad|pretty good|all good",
             "Glad to hear it! What can I help you find?", "다행이에요! 뭘 찾아 드릴까요?"},
            {"(i'?m|i am|feeling) (tired|sad|bored|stressed|down|not great|not good)|bad day|rough day",
             "Sorry to hear that. If it helps, I can pull up some happy photos — try “photos from last summer”.",
             "그랬군요, 힘내요. 기분 전환이 필요하면 “작년 여름 사진”처럼 좋은 추억을 찾아 드릴게요."},
            {"(what'?s|what is) your name|who are you|who r u|what are you|are you (a )?(bot|robot|ai|human|real)",
             "I'm the aindrive agent. I run right here on your phone and help you find, collect and share your files.",
             "저는 aindrive 에이전트예요. 이 폰에서 직접 돌아가면서 파일을 찾고 모으고 공유하는 걸 도와드려요."},
            {"nice to meet you|pleased to meet you|good to meet you", "Nice to meet you too! Ask me about your photos, recordings or documents.", "저도 반가워요! 사진, 녹음, 문서에 대해 물어보세요."},
            {"(good|great|nice|awesome|amazing) (job|work)|well done|you'?re (great|awesome|amazing|the best|smart|helpful)|love (it|you)|i like you",
             "Thank you, that's kind! Happy to help anytime.", "고마워요! 언제든 도와드릴게요."},
            {"sorry|my bad|oops|never mind|nevermind|forget it", "No problem at all. What would you like to do next?", "괜찮아요. 다음엔 뭘 해 드릴까요?"},
            {"(lol|haha+|hehe+|lmao)", "😄 Anything I can find for you?", "😄 찾아 드릴 게 있을까요?"},
            {"good ?night|see you( later| tomorrow)?|talk (to you )?later|bye( bye)?|goodbye|take care", "Bye for now — see you soon!", "다음에 또 봐요!"},
            {"what can you do|what do you do|help|how does this work|how do i use (you|this)", null, null},
            {"잘 지내(요|세요|니|셨어요)?|어떻게 지내(요|세요)?|뭐해\\??|뭐 해\\??|기분 어때(요)?", "I'm doing well, thanks for asking! How are you?", "잘 지내요, 물어봐 줘서 고마워요! 당신은요? 찾을 게 있으면 말씀하세요."},
            {"(너|넌|당신은?) (누구|뭐)(야|예요|니|세요)?|이름이 뭐(야|예요)?", "I'm the aindrive agent, running on your phone.", "저는 aindrive 에이전트예요. 이 폰에서 파일을 찾고 정리해 드려요."},
            {"(잘했어|최고야|고마워|수고했어|좋아)(요)?", "Thank you!", "고마워요! 언제든 불러 주세요."},
            {"미안(해|해요)?|죄송(해요|합니다)?", "No problem at all.", "괜찮아요!"},
            {"잘 ?자|잘 ?가|안녕히 (가세요|계세요)|또 (봐|만나)", "Bye for now!", "다음에 또 봐요!"},
    };
    private static final java.util.regex.Pattern[] SOCIAL_P = new java.util.regex.Pattern[SOCIAL.length];
    static {
        for (int i = 0; i < SOCIAL.length; i++)
            SOCIAL_P[i] = java.util.regex.Pattern.compile("^(" + SOCIAL[i][0] + ")[\\s.!?~,]*(\\s*(:\\)|😊|🙂|😄))?[\\s.!?~]*$", java.util.regex.Pattern.CASE_INSENSITIVE);
    }

    static @Nullable String smallTalk(String question) {
        String t = question.trim();
        boolean hangul = t.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3 || cp >= 0x3131 && cp <= 0x318E);
        for (int i = 0; i < SOCIAL.length; i++) {
            if (!SOCIAL_P[i].matcher(t).matches()) continue;
            if (SOCIAL[i][1] == null) return greeting(hangul);
            return hangul ? SOCIAL[i][2] : SOCIAL[i][1];
        }
        if (!GREETING.matcher(t).matches()) return null;
        boolean ko = t.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3 || cp >= 0x3131 && cp <= 0x318E);
        boolean thanks = t.toLowerCase(Locale.ROOT).matches("^(thanks?|thank|ty|고마|감사|ㄱㅅ).*");
        if (thanks) return ko ? "천만에요! 더 찾을 게 있으면 말씀하세요." : "You're welcome — ask me anything else about your files.";
        return greeting(ko);
    }

    static String greeting(boolean ko) {
        return ko
                ? "안녕하세요! 이 폰의 파일을 찾고 정리해 드려요. 예를 들면:\n· 도쿄에서 찍은 사진\n· 이번달 음식 사진을 폴더로 모아서 공유해줘\n· 예산 얘기한 회의 녹음\n· 많이 통화한 사람 순으로 정리하고 요약해줘"
                : "Hi! I find and organise the files on this phone. Try:\n· photos taken in Tokyo\n· collect this month's food photos into a folder and share it\n· meeting recordings about the budget\n· sort my call history by who I talk to most and summarize it";
    }

    private String folderName(SearchQuery q) {
        StringBuilder n = new StringBuilder();
        for (String k : q.keywords) n.append(n.length() > 0 ? " " : "").append(k);
        if (q.city != null) n.append(n.length() > 0 ? " " : "").append(q.korean && geo.cityKo(q.city) != null ? geo.cityKo(q.city) : q.city);
        else if (q.country != null) n.append(n.length() > 0 ? " " : "").append(geo.countryName(q.country, q.korean));
        n.append(n.length() > 0 ? " " : "").append(kindNoun(q.kind, 2, q.korean));
        if (q.dateFrom != null) n.append(" ").append(new SimpleDateFormat("yyyy-MM", Locale.US).format(q.dateFrom));
        return n.toString().replaceAll("[\\/:*?\"<>|]", " ").trim();
    }

    private static final class Hit {
        final FileIndex.Row row; final int tier; final float score; final String how; final @Nullable String excerpt;
        Hit(FileIndex.Row r, int tier, float score, String how, @Nullable String excerpt) { row = r; this.tier = tier; this.score = score; this.how = how; this.excerpt = excerpt; }
    }

    /** All rows matching the hard filters, each with the strongest way its content matched. */
    private Map<String, Hit> search(SearchQuery q, AskScope scope) throws Exception {
        Map<String, Hit> out = new LinkedHashMap<>();
        FileIndex.Filter base = filter(scope);
        base.kind = q.kind; base.country = q.country; base.city = q.city;
        base.dateFrom = q.dateFrom; base.dateTo = q.dateTo; base.minSize = q.minSize;

        if (q.keywords.isEmpty()) {
            for (FileIndex.Row r : index.query(base, 0)) out.put(r.docId, new Hit(r, 0, 0, "filter", null));
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
                float[] t = emb.embedText(SceneLabels.prompt(en.toString()));
                List<float[]> vecs = new ArrayList<>(photos.size());
                for (FileIndex.Row r : photos) vecs.add(r.vector());
                float[] p = SceneLabels.match(t, emb.labelVectors(), vecs);
                for (int i = 0; i < p.length; i++) {
                    FileIndex.Row r = photos.get(i);
                    if (p[i] >= 0 && !out.containsKey(r.docId)) out.put(r.docId, new Hit(r, 2, p[i], "photo", null));
                }
            }
        }
        return out;
    }

    private static FileIndex.Filter copy(FileIndex.Filter f) {
        FileIndex.Filter c = new FileIndex.Filter();
        c.kind = f.kind; c.country = f.country; c.city = f.city; c.dateFrom = f.dateFrom; c.dateTo = f.dateTo; c.minSize = f.minSize;
        c.under = new ArrayList<>(f.under);
        return c;
    }

    /** A filter already limited to the scope's root: every index query of an ask starts here. */
    private static FileIndex.Filter filter(AskScope scope) {
        FileIndex.Filter f = new FileIndex.Filter();
        f.under = scope.rootSpellings();
        return f;
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

    private String answerFor(SearchQuery q, List<Hit> rows, int total, List<String> relaxed, boolean anyContent, boolean anySpeech, AskScope within) {
        boolean ko = q.korean;
        if (rows.isEmpty()) {
            String where = q.city != null ? (ko && geo.cityKo(q.city) != null ? geo.cityKo(q.city) : q.city) : q.country != null ? geo.countryName(q.country, ko) : null;
            String topic = String.join(" ", q.keywords);
            if (where != null || q.dateFrom != null || !topic.isEmpty()) {
                // "No receipts from August", not "No receipts files from August".
                String what = topic.isEmpty() ? kindNoun(q.kind, 2, ko) : q.kind == null ? topic : topic + " " + kindNoun(q.kind, 2, ko);
                String when = q.dateFrom != null ? new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(q.dateFrom) + (q.dateTo != null ? " ~ " + new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(q.dateTo - 1) : "") : null;
                String none = ko
                        ? (where != null ? where + "에서 찍은 " : "") + (when != null ? when + " " : "") + what + "이 없어요."
                        : "No " + what + (where != null ? " taken in " + where : "") + (when != null ? " from " + when : "") + " here.";
                if (!topic.isEmpty()) {
                    // The place/date has files, just none showing the topic: say that, not "no photos from Tokyo".
                    FileIndex.Filter f = filter(within);
                    f.kind = q.kind == null ? FileIndex.PHOTO : q.kind; f.country = q.country; f.city = q.city; f.dateFrom = q.dateFrom; f.dateTo = q.dateTo;
                    int there = index.query(f, 0).size();
                    String scope = kindNoun(f.kind, there, ko) + (where != null ? (ko ? "" : " taken in " + where) : "") + (when != null ? (ko ? "" : " from " + when) : "");
                    if (there > 0) return ko
                            ? (where != null ? where + "에서 찍은 " : "") + (when != null ? when + " " : "") + kindNoun(f.kind, there, ko) + " " + there + "개 중에 “" + topic + "”에 해당하는 건 없어요."
                            : "There are " + there + " " + scope + ", but none of them show “" + topic + "”.";
                }
                String places = where != null ? knownPlaces(q.kind, ko, within) : "";
                return none + places;
            }
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
        // The list is capped, the number is not: "사진 128장 (상위 50개 표시)".
        String n = String.valueOf(total);
        String shown = total > rows.size() ? (ko ? " (상위 " + rows.size() + "개 표시)" : ", showing " + rows.size()) : "";

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
            a.append(noun).append(" ").append(n).append(countKo(onlyKind)).append("를 찾았어요.").append(shown);
            if (anyContent && anySpeech) a.append(" 사진 내용과 녹음 내용을 인식해서 찾았어요.");
            else if (anyContent) a.append(" 사진 내용을 인식해서 찾았어요.");
            else if (anySpeech) a.append(" 녹음 내용에서 찾았어요.");
        } else {
            a.append("Found ").append(n).append(" ").append(noun)
             .append(where.isEmpty() ? "" : " taken in " + where).append(when.isEmpty() ? "" : " (" + when + ")").append(shown).append(".");
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
