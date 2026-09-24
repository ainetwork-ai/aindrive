package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.speech.SpeechRecognizer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * "Sort my call history by who I talk to most and summarise what we talk
 * about": the call log gives the ranking, the call recordings (Samsung names
 * them "통화 녹음 <who>_yymmdd_hhmmss.m4a" / "Call recording <who>_…") give the
 * words. There is no LLM on the phone, so "what we talk about" is the most
 * distinctive vocabulary of each person's transcripts plus one representative
 * sentence — the markdown says so. Recordings are transcribed on demand
 * (the newest few per person, first minutes only) because a Call folder can
 * hold thousands of hours.
 */
public final class CallReport {
    /** Rows of the phone's call log; null when the app was not allowed to read it. */
    public interface CallLog {
        @Nullable List<Call> calls();
    }

    public static final class Call {
        public final String number; public final @Nullable String name; public final long seconds, whenMs;
        public Call(String number, @Nullable String name, long seconds, long whenMs) { this.number = number; this.name = name; this.seconds = seconds; this.whenMs = whenMs; }
    }

    static final int TOP_PEOPLE = 10;
    static final int RECORDINGS_PER_PERSON = 3;
    static final int SECONDS_PER_RECORDING = 3 * 60;
    static final int TOPICS = 5;

    private static final Pattern RECORDING = Pattern.compile(
            "^(?:통화\\s*녹음|call\\s*recording)\\s*#?\\s*(.+?)_(\\d{6})_(\\d{6})\\.[A-Za-z0-9]+$", Pattern.CASE_INSENSITIVE);

    static final class Person {
        String name; int calls; long seconds; long lastMs;
        final List<FileIndex.Row> recordings = new ArrayList<>();
        final List<String> transcripts = new ArrayList<>();
        List<String> topics = new ArrayList<>();
        String gist = "";
    }

    private final FileIndex index;
    private final @Nullable CallLog callLog;
    private final Supplier<SpeechRecognizer> speech;
    private final @Nullable AskRunner.FileOps ops;

    public CallReport(FileIndex index, @Nullable CallLog callLog, Supplier<SpeechRecognizer> speech, @Nullable AskRunner.FileOps ops) {
        this.index = index; this.callLog = callLog; this.speech = speech; this.ops = ops;
    }

    /** Recording file name → who it was with, or null when it is not a call recording. */
    public static @Nullable String personOf(String fileName) {
        Matcher m = RECORDING.matcher(fileName.trim());
        if (!m.matches()) return null;
        return normName(m.group(1));
    }

    static String normName(String s) {
        return s.replaceFirst("^#", "").replaceAll("\\s+", " ").trim();
    }

    private static String normNumber(String s) { return s.replaceAll("[^0-9+]", ""); }

    public JSONObject run(SearchQuery q, long nowMs) throws Exception {
        boolean ko = q.korean;
        Map<String, Person> people = new LinkedHashMap<>();
        List<Call> calls = callLog == null ? null : callLog.calls();
        boolean haveLog = calls != null;
        if (haveLog) {
            for (Call c : calls) {
                String key = c.name != null && !c.name.trim().isEmpty() ? normName(c.name) : normNumber(c.number);
                if (key.isEmpty()) continue;
                Person p = people.computeIfAbsent(key, k -> { Person x = new Person(); x.name = k; return x; });
                p.calls++; p.seconds += c.seconds; p.lastMs = Math.max(p.lastMs, c.whenMs);
            }
        }
        // Recordings: by contact name; a name the call log does not know (or no log at all) still gets a row.
        FileIndex.Filter f = new FileIndex.Filter();
        f.kind = FileIndex.AUDIO;
        int recordings = 0;
        for (FileIndex.Row r : index.query(f, 0)) {
            String who = personOf(r.name);
            if (who == null) continue;
            recordings++;
            Person p = people.get(who);
            if (p == null) {
                // "010-1234-5678" recordings match a log entry with that number.
                String num = normNumber(who);
                if (num.length() >= 7) p = people.get(num);
            }
            if (p == null) { p = new Person(); p.name = who; people.put(who, p); }
            p.recordings.add(r);
            if (!haveLog) { p.calls++; p.lastMs = Math.max(p.lastMs, r.whenMs == null ? r.mtimeMs : r.whenMs); }
        }
        List<Person> ranked = new ArrayList<>(people.values());
        ranked.sort((a, b) -> a.calls != b.calls ? Integer.compare(b.calls, a.calls) : Long.compare(b.seconds, a.seconds));
        for (Person p : ranked) p.recordings.sort((a, b) -> Long.compare(when(b), when(a)));

        if (ranked.isEmpty()) {
            String why = ko ? "통화 기록을 읽을 수 없고 통화 녹음 파일도 없어요. 앱에서 통화 기록 접근을 허용하고 '통화 녹음' 폴더를 에이전트 소스로 추가해 주세요."
                    : "I can't read the call log and there are no call recordings. Allow call-log access in the app and add the call-recordings folder as an agent source.";
            return new JSONObject().put("answer", why).put("sources", new JSONArray())
                    .put("action", new JSONObject().put("type", "collect").put("skipped", true).put("reason", "nothing matched").put("needsCallLog", !haveLog).put("report", "calls"));
        }

        // Words: transcripts already in the index, else transcribe the newest few now.
        List<Person> top = ranked.subList(0, Math.min(TOP_PEOPLE, ranked.size()));
        SpeechRecognizer asr = null;
        for (Person p : top) {
            int used = 0;
            for (FileIndex.Row r : p.recordings) {
                if (used >= RECORDINGS_PER_PERSON) break;
                String t = r.transcript;
                if (t == null && ops != null) {   // reading needs no output drive
                    if (asr == null) asr = speech.get();
                    if (asr == null) break;
                    try (android.os.ParcelFileDescriptor pfd = ops.openFd(r.docId)) {
                        if (pfd == null) continue;
                        SpeechRecognizer.Transcript tr = asr.transcribe(pfd.getFileDescriptor(), SECONDS_PER_RECORDING);
                        t = tr == null ? "" : tr.text;
                        index.setRecognition(r.docId, null, t);
                    } catch (Exception e) { continue; }
                }
                if (t != null && !t.trim().isEmpty()) { p.transcripts.add(t); used++; }
            }
        }
        topics(top);

        // Answer + sources (one per person: the newest recording, snippet = topics).
        StringBuilder a = new StringBuilder();
        JSONArray sources = new JSONArray();
        a.append(ko ? "많이 통화한 순서예요" : "Ranked by how often you talk").append(haveLog ? "" : (ko ? " (통화 기록 없이 녹음 파일 기준)" : " (from recordings only — call log not allowed)")).append(":\n");
        int i = 0;
        for (Person p : top) {
            i++;
            a.append(i).append(". ").append(p.name).append(" — ").append(countText(p, ko));
            if (!p.topics.isEmpty()) a.append(ko ? " · 주로 " : " · usually ").append(String.join(", ", p.topics));
            a.append("\n");
            if (!p.recordings.isEmpty()) {
                FileIndex.Row r = p.recordings.get(0);
                sources.put(new JSONObject().put("path", r.path).put("matchedBy", "speech")
                        .put("snippet", p.topics.isEmpty() ? (ko ? "녹음 " + p.recordings.size() + "개" : p.recordings.size() + " recordings") : String.join(" · ", p.topics)));
            }
        }
        JSONObject out = new JSONObject().put("answer", a.toString().trim()).put("sources", sources);

        // The markdown report, in a folder the shell can turn into a shareable drive.
        String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(nowMs));
        String folder = (ko ? "통화 요약 " : "Call summary ") + day;
        JSONObject action = new JSONObject().put("type", "collect").put("report", "calls").put("share", q.share).put("needsCallLog", !haveLog)
                .put("people", peopleJson(top));
        if (ops == null || !ops.canWrite()) {
            action.put("skipped", true).put("reason", "no file access");
        } else {
            String file = folder + "/" + (ko ? "통화 요약.md" : "Call summary.md");
            ops.write(file, markdown(ranked, top, haveLog, recordings, day, ko).getBytes(StandardCharsets.UTF_8));
            action.put("folder", folder).put("copied", 1).put("failed", 0).put("files", new JSONArray().put(file));
            try { action.putOpt("folderUri", ops.uriOf(folder)); } catch (Exception ignored) { }
        }
        return out.put("action", action);
    }

    private static long when(FileIndex.Row r) { return r.whenMs == null ? r.mtimeMs : r.whenMs; }

    private static String countText(Person p, boolean ko) {
        String n = ko ? p.calls + "회" : p.calls + (p.calls == 1 ? " call" : " calls");
        if (p.seconds > 0) n += ", " + duration(p.seconds, ko);
        if (!p.recordings.isEmpty()) n += ko ? ", 녹음 " + p.recordings.size() + "개" : ", " + p.recordings.size() + (p.recordings.size() == 1 ? " recording" : " recordings");
        return n;
    }

    static String duration(long s, boolean ko) {
        long h = s / 3600, m = (s % 3600) / 60;
        if (h > 0) return ko ? h + "시간 " + m + "분" : h + "h " + m + "m";
        if (m > 0) return ko ? m + "분" : m + " min";
        return ko ? s + "초" : s + " s";
    }

    private static JSONArray peopleJson(List<Person> top) throws Exception {
        JSONArray out = new JSONArray();
        for (Person p : top) out.put(new JSONObject().put("name", p.name).put("calls", p.calls).put("seconds", p.seconds)
                .put("recordings", p.recordings.size()).put("topics", new JSONArray(p.topics)).put("gist", p.gist));
        return out;
    }

    private static String markdown(List<Person> all, List<Person> top, boolean haveLog, int recordings, String day, boolean ko) {
        StringBuilder md = new StringBuilder();
        md.append(ko ? "# 통화 요약 — " : "# Call summary — ").append(day).append("\n\n");
        md.append(ko
                ? "이 폰의 통화 기록" + (haveLog ? "" : "(접근 불가)") + "과 통화 녹음 " + recordings + "개를 바탕으로, 많이 통화한 사람 순으로 정리했어요. "
                  + "\"주로 나누는 이야기\"는 폰에서 Whisper로 받아쓴 녹음 내용 중 그 사람과의 대화에서 특히 자주 나온 말과 대표 문장이에요 — AI 요약이 아니라 통계입니다.\n\n"
                : "From this phone's call log" + (haveLog ? "" : " (not accessible)") + " and " + recordings + " call recordings, ranked by how often you talk. "
                  + "\"Usually about\" is the vocabulary that stands out in that person's recordings (transcribed on the phone with Whisper) plus one representative sentence — a statistic, not an AI summary.\n\n");
        md.append(ko ? "| # | 이름 | 통화 | 통화 시간 | 녹음 | 주로 나누는 이야기 |\n|---|---|---|---|---|---|\n"
                     : "| # | Person | Calls | Talk time | Recordings | Usually about |\n|---|---|---|---|---|---|\n");
        int i = 0;
        for (Person p : all) {
            i++;
            md.append("| ").append(i).append(" | ").append(p.name.replace("|", "\\|")).append(" | ").append(p.calls).append(" | ")
              .append(p.seconds > 0 ? duration(p.seconds, ko) : "–").append(" | ").append(p.recordings.size()).append(" | ")
              .append(p.topics.isEmpty() ? "–" : String.join(", ", p.topics)).append(" |\n");
            if (i >= 50) break;
        }
        md.append("\n");
        i = 0;
        for (Person p : top) {
            i++;
            md.append("## ").append(i).append(". ").append(p.name).append("\n\n");
            md.append(ko ? "- 통화 " : "- Calls: ").append(countText(p, ko)).append("\n");
            if (p.lastMs > 0) md.append(ko ? "- 마지막 통화: " : "- Last call: ").append(new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(p.lastMs))).append("\n");
            if (!p.topics.isEmpty()) md.append(ko ? "- 자주 나온 말: " : "- Topics: ").append(String.join(", ", p.topics)).append("\n");
            if (!p.gist.isEmpty()) md.append("\n> ").append(p.gist).append("\n");
            if (p.topics.isEmpty()) md.append(ko ? "\n_녹음이 없거나 아직 받아쓰지 못했어요._\n" : "\n_No recording, or not transcribed yet._\n");
            md.append("\n");
        }
        return md.toString();
    }

    // ------------------------------------------------------------ topics

    private static final Set<String> STOP = new HashSet<>(Arrays.asList(
            // Korean fillers, pronouns, phone talk
            "그냥", "지금", "그거", "이거", "저거", "근데", "그래서", "그러면", "그리고", "그런데", "진짜", "약간", "정도", "이제", "그럼", "아니", "네네", "그게", "이렇게", "그렇게",
            "저희", "우리", "제가", "내가", "거기", "여기", "어디", "언제", "하는", "있는", "없는", "해서", "하고", "했는데", "있어요", "없어요", "같아요", "그래", "그니까", "그러니까",
            "일단", "조금", "많이", "다시", "오늘", "내일", "어제", "이번", "다음", "한번", "하나", "그렇", "아니요", "뭔가", "이런", "그런", "저런", "어떤", "어떻게", "감사합니다",
            "안녕하세요", "여보세요", "알겠습니다", "알겠어요", "괜찮아요", "그렇죠", "맞아요", "있습니다", "없습니다", "합니다", "됩니다", "하는데", "그러고", "통화", "전화", "얘기",
            "이야기", "때문에", "혹시", "직접", "아마", "계속", "바로", "먼저", "우선", "거의", "너무", "아주", "완전", "그때", "이때", "항상", "가끔", "자주", "벌써", "아직", "이미", "다들", "전부", "모두", "같이", "함께", "알았어", "알겠", "몰라", "맞아", "맞다", "그렇", "저기", "잠깐", "잠시", "천천히", "빨리", "일찍", "늦게", "그러면은", "그래가지고", "가지고", "그러니깐", "근데요", "그쵸", "예예", "아니면", "그래도", "이거는", "그거는", "있고", "없고", "하면", "되면", "했어요",
            "해요", "돼요", "할게요", "될까요", "인데", "이고", "하는게", "되는", "되고", "되는데", "봐요", "봤어요", "보고", "그건", "이건", "저는", "너는", "나는", "우리가", "제가요",
            // English
            "the", "and", "you", "that", "for", "with", "this", "have", "not", "are", "but", "was", "yeah", "okay", "like", "just", "what", "know", "about", "there", "then", "they",
            "will", "your", "from", "can", "get", "all", "one", "out", "when", "how", "her", "him", "his", "she", "who", "its", "our", "were", "been", "has", "had", "did", "does",
            "going", "gonna", "think", "really", "right", "well", "mean", "something", "thing", "things", "because", "also", "into", "them", "want", "need", "hello", "thanks", "call"));

    /** Endings of conjugated verbs/adjectives and dangling pronouns — never a topic. */
    private static final Pattern KO_VERBISH = Pattern.compile(
            "(잖아|는데|은데|거야|거예|거든|니까|더라|하는|되는|있는|없는|같은|많은|이런|그런|저런|어떤|하고|되고|있고|없고|해서|돼서|있어|없어|했어|됐어|있다|없다|한다|된다|이다|입니다|습니다|세요|해요|돼요|어요|아요|에요|예요|이고|이니|이면|이지|하면|되면|하지|되지|겠|을까|ㄹ까|같아|그래|들어|나와|봐요|봤어|하죠|되죠|이죠|해야|되어|하니|되니|았어|었어|았는데|었는데|할게|을게|ㄹ게|는지|은지|던데|더니|라고|다고|냐고|자고)$"
            + "|^(그|이|저|뭐|왜|어|음|아|네|예|응)[가-힣]$");
    private static final String[] KO_SUFFIXES = {"에서는", "으로는", "이라고", "에게는", "한테는", "에서", "으로", "에게", "한테", "부터", "까지", "라고", "이나", "이든", "은", "는", "이", "가", "을", "를", "에", "의", "도", "로", "와", "과", "랑", "요", "죠", "네", "만"};

    static List<String> words(String text) {
        List<String> out = new ArrayList<>();
        for (String w : text.split("[^\\p{L}\\p{N}]+")) {
            if (w.isEmpty()) continue;
            String t = w.toLowerCase(Locale.ROOT);
            if (STOP.contains(t)) continue;
            boolean hangul = t.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
            if (hangul) for (String s : KO_SUFFIXES) { if (t.length() > s.length() + 1 && t.endsWith(s)) { t = t.substring(0, t.length() - s.length()); break; } }
            if (t.length() < 2 || t.matches("\\d+") || STOP.contains(t)) continue;
            // Whisper's Korean comes out as verb fragments ("있는데", "거야", "되게"): keep noun-like tokens only.
            if (hangul && (KO_VERBISH.matcher(t).find() || t.length() < 2)) continue;
            out.add(t);
        }
        return out;
    }

    /** TF-IDF across people: a word is a topic when this person says it a lot and the others do not. */
    static void topics(List<Person> people) {
        Map<String, Integer> df = new HashMap<>();
        List<Map<String, Integer>> tfs = new ArrayList<>();
        for (Person p : people) {
            Map<String, Integer> tf = new HashMap<>();
            Map<String, Integer> inTranscripts = new HashMap<>();
            for (String t : p.transcripts) {
                Set<String> seen = new HashSet<>();
                for (String w : words(t)) { tf.merge(w, 1, Integer::sum); seen.add(w); }
                for (String w : seen) inTranscripts.merge(w, 1, Integer::sum);
            }
            // "Usually" = recurring: with several recordings a topic must come up in more than one.
            if (p.transcripts.size() >= 2) tf.keySet().removeIf(w -> inTranscripts.get(w) < 2 && tf.get(w) < 3);
            for (String w : tf.keySet()) df.merge(w, 1, Integer::sum);
            tfs.add(tf);
        }
        int n = people.size();
        for (int i = 0; i < n; i++) {
            Person p = people.get(i);
            Map<String, Integer> tf = tfs.get(i);
            List<Map.Entry<String, Integer>> es = new ArrayList<>(tf.entrySet());
            final Map<String, Integer> dfF = df;
            es.sort((a, b) -> Double.compare(score(b, dfF, n), score(a, dfF, n)));
            List<String> topics = new ArrayList<>();
            for (Map.Entry<String, Integer> e : es) {
                if (topics.size() >= TOPICS) break;
                if (e.getValue() < 2 && tf.size() > 20) continue;
                topics.add(e.getKey());
            }
            p.topics = topics;
            p.gist = gist(p.transcripts, topics);
        }
    }

    private static double score(Map.Entry<String, Integer> e, Map<String, Integer> df, int n) {
        return e.getValue() * Math.log((n + 1.0) / (df.getOrDefault(e.getKey(), 0) + 0.5));
    }

    /** The sentence that carries the most topic words, trimmed for a quote. */
    static String gist(List<String> transcripts, List<String> topics) {
        String best = ""; int bestHits = 0;
        for (String t : transcripts) {
            for (String s : t.split("(?<=[.?!。])\\s+|(?<=[다요죠])\\s+")) {
                s = s.trim();
                if (s.length() < 15) continue;
                int hits = 0;
                String low = s.toLowerCase(Locale.ROOT);
                for (String w : topics) if (low.contains(w)) hits++;
                if (hits > bestHits || hits == bestHits && hits > 0 && s.length() < best.length()) { bestHits = hits; best = s; }
            }
        }
        if (best.length() > 140) best = best.substring(0, 137) + "…";
        return best;
    }
}
