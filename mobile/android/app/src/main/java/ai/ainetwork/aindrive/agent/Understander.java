package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import ai.ainetwork.aindrive.index.FileIndex;
import ai.ainetwork.aindrive.index.GeoLookup;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The on-device model's reading of ONE turn the rules were unsure about
 * ({@link UnderstandTrigger}): prompt → JSON → the rules' own {@link SearchQuery} + route
 * (docs/superpowers/specs/2026-09-27-llm-understanding-design.md).
 *
 * The model never answers in free text and never resolves anything code can: it returns the
 * place and time WORDS as written ("Jeju", "last spring") and code resolves them with the
 * gazetteer and {@link QueryParser#dateWindow} — models do date arithmetic badly and invent city
 * spellings. It cannot destroy or leak: delete / move / share come only from an explicit verb the
 * rules saw, and a collect it claims is honoured only when the rules saw the verb too (#146: "what's
 * in this folder?" once made a folder — a write is never taken on a guess). Anything that does not
 * parse, names a place not in the message, or runs past {@link #BUDGET_MS} yields null, and the
 * rules' answer stands. The model is behind {@link Model} so tests inject canned JSON.
 */
public final class Understander {
    /** prompt → text; the real one is the LiteRT-LM summariser, tests hand in a lambda. */
    public interface Model {
        /**
         * @param examples   worked {message, JSON answer} pairs to place before {@code user} as prior turns ({@link #FEW_SHOT})
         * @param jsonSchema the expected shape, for runtimes that can constrain decoding to it (may be ignored)
         */
        @Nullable String complete(String system, List<String[]> examples, String user, String jsonSchema);
        /** The wall-clock budget ran out: stop generating so the model can be released. */
        default void cancel() { }
    }

    /** Identical text on both platforms (the Mac's llm.js carries a copy): English, the user's language is preserved in `korean`. */
    static final String SYSTEM =
            "You turn one chat message to a file assistant into a JSON search. The assistant only knows the\n"
            + "files on this device: photos, screenshots, videos, recordings, PDFs, documents, spreadsheets,\n"
            + "presentations, archives. Output JSON only, one object:\n"
            + "{\"route\":\"chat|out|files\",\n"
            + " \"kind\":\"photo|screenshot|video|audio|pdf|document|spreadsheet|presentation|archive|null\",\n"
            + " \"place\":\"<place name as written or null>\", \"when\":\"<time words as written or null>\",\n"
            + " \"content\":[\"<what the file shows or is about>\"], \"task\":\"find|count|collect|null\",\n"
            + " \"limit\":<int or 0>, \"oldest\":<bool>, \"largest\":<bool>}\n"
            + "route=chat for greetings and small talk; out for anything not about this device's files\n"
            + "(bookings, weather, general questions); files otherwise. Do not resolve dates. Do not guess a\n"
            + "place that is not in the message. content holds only words about the files, never verbs like\n"
            + "\"show\", \"find\", \"list\".";

    /**
     * Worked examples, given as prior turns (the system text alone makes a small model route every
     * message to chat/out). Mirrors desktop/src/agent/llm.js FEW_SHOT — keep the two lists identical.
     */
    static final List<String[]> FEW_SHOT = java.util.Collections.unmodifiableList(Arrays.asList(
            ex("photos from Tokyo last summer", "{\"route\":\"files\",\"kind\":\"photo\",\"place\":\"Tokyo\",\"when\":\"last summer\",\"content\":[],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}"),
            ex("can you book me a flight to Rome", "{\"route\":\"out\",\"kind\":null,\"place\":null,\"when\":null,\"content\":[],\"task\":null,\"limit\":0,\"oldest\":false,\"largest\":false}"),
            ex("good morning!", "{\"route\":\"chat\",\"kind\":null,\"place\":null,\"when\":null,\"content\":[],\"task\":null,\"limit\":0,\"oldest\":false,\"largest\":false}"),
            ex("the 3 biggest videos of the dog", "{\"route\":\"files\",\"kind\":\"video\",\"place\":null,\"when\":null,\"content\":[\"dog\"],\"task\":\"find\",\"limit\":3,\"oldest\":false,\"largest\":true}"),
            ex("do you still have the contract from the landlord", "{\"route\":\"files\",\"kind\":\"document\",\"place\":null,\"when\":null,\"content\":[\"contract\",\"landlord\"],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}"),
            ex("what did we discuss in yesterday's standup", "{\"route\":\"files\",\"kind\":\"audio\",\"place\":null,\"when\":\"yesterday\",\"content\":[\"standup\"],\"task\":\"find\",\"limit\":0,\"oldest\":false,\"largest\":false}"),
            ex("지난달 제주에서 찍은 영상 몇 개야", "{\"route\":\"files\",\"kind\":\"video\",\"place\":\"제주\",\"when\":\"지난달\",\"content\":[],\"task\":\"count\",\"limit\":0,\"oldest\":false,\"largest\":false}")));

    /** An example as the model sees it: the user side carries the same "Previous search: none" preamble as a real turn. */
    private static String[] ex(String message, String answer) { return new String[]{userPrompt(message, null), answer}; }

    /** The output shape as JSON Schema, for constrained decoding. Nullable strings are typed loosely: the runtime's grammar has no `anyOf`. */
    static final String SCHEMA = "{\"type\":\"object\",\"properties\":{"
            + "\"route\":{\"type\":\"string\",\"enum\":[\"chat\",\"out\",\"files\"]},"
            + "\"kind\":{\"type\":\"string\",\"enum\":[\"photo\",\"screenshot\",\"video\",\"audio\",\"pdf\",\"document\",\"spreadsheet\",\"presentation\",\"archive\",\"null\"]},"
            + "\"place\":{\"type\":\"string\"},\"when\":{\"type\":\"string\"},"
            + "\"content\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},"
            + "\"task\":{\"type\":\"string\",\"enum\":[\"find\",\"count\",\"collect\",\"null\"]},"
            + "\"limit\":{\"type\":\"integer\"},\"oldest\":{\"type\":\"boolean\"},\"largest\":{\"type\":\"boolean\"}},"
            + "\"required\":[\"route\",\"kind\",\"place\",\"when\",\"content\",\"task\",\"limit\",\"oldest\",\"largest\"]}";

    public static final int MAX_TOKENS = 160;
    /** Wall-clock for the model call; past it the rules' answer is used (the load time is not counted — it happens before). */
    public static final long BUDGET_MS = 4000;
    private static final int MAX_CONTENT = 4, MAX_LIMIT = AskRunner.LIMIT;

    private final GeoLookup geo;
    private final Model model;
    private final long budgetMs;

    public Understander(GeoLookup geo, Model model) { this(geo, model, BUDGET_MS); }

    Understander(GeoLookup geo, Model model, long budgetMs) { this.geo = geo; this.model = model; this.budgetMs = budgetMs; }

    /** The user message: the previous search first, so "the ones from Paris" and "and share them" can resolve. */
    static String userPrompt(String question, @Nullable SearchQuery prev) {
        return "Previous search: " + (prev == null ? "none" : prev.toJson().toString()) + "\nMessage: " + question.trim();
    }

    /**
     * Ask the model and rebuild the turn. Null when it timed out, did not parse, or said nothing
     * usable — the caller keeps {@code rules}. Replies for chat/out are the Router's own, so the
     * wording stays parity-tested.
     */
    public @Nullable Router.Turn understand(String question, long nowMs, @Nullable JSONObject context, Router.Turn rules) {
        return understand(question, nowMs, context, rules, true);
    }

    /** The same on the caller's thread with no budget — for a caller that owns the clock (AskRunner times load + call together). */
    public @Nullable Router.Turn understandNow(String question, long nowMs, @Nullable JSONObject context, Router.Turn rules) {
        return understand(question, nowMs, context, rules, false);
    }

    private @Nullable Router.Turn understand(String question, long nowMs, @Nullable JSONObject context, Router.Turn rules, boolean budgeted) {
        boolean wasOut = context != null && "out".equals(context.optString("scope"));
        boolean wasSocial = context != null && "social".equals(context.optString("scope"));
        SearchQuery prev = wasOut || wasSocial ? null : SearchQuery.fromJson(context);
        String text = budgeted ? ask(question, prev) : model.complete(SYSTEM, FEW_SHOT, userPrompt(question, prev), SCHEMA);
        if (text == null) return null;
        JSONObject o = firstObject(text);
        if (o == null) return null;
        return merge(question, nowMs, o, prev, wasOut, rules);
    }

    /** The model call on its own thread, so the budget is a hard wall: over it, cancel and give up. */
    private @Nullable String ask(String question, @Nullable SearchQuery prev) {
        ExecutorService ex = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "understand"); t.setDaemon(true); return t; });
        try {
            Future<String> f = ex.submit(() -> model.complete(SYSTEM, FEW_SHOT, userPrompt(question, prev), SCHEMA));
            try {
                return f.get(budgetMs, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                model.cancel();
                // Let the native call unwind so the engine can be released safely; its late answer is not used.
                try { f.get(2000, TimeUnit.MILLISECONDS); } catch (Exception ignored) { }
                return null;
            }
        } catch (Exception e) {
            return null;
        } finally {
            ex.shutdownNow();
        }
    }

    /** The first balanced {…} block of the text (a runtime that ignored the schema may add prose or fences). */
    static @Nullable JSONObject firstObject(String text) {
        int start = text.indexOf('{');
        if (start < 0) return null;
        int depth = 0;
        boolean inString = false;
        for (int i = start; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inString) { if (c == '\\') i++; else if (c == '"') inString = false; continue; }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}' && --depth == 0) {
                try { return new JSONObject(text.substring(start, i + 1)); } catch (Exception e) { return null; }
            }
        }
        return null;
    }

    /** Post-processing: code owns places, dates, content words and the guards. */
    @Nullable Router.Turn merge(String question, long nowMs, JSONObject o, @Nullable SearchQuery prev, boolean wasOut, Router.Turn rules) {
        String route = str(o, "route");
        boolean ko = question.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        if ("chat".equals(route)) {
            String reply = rules.route == Router.Route.CHAT ? rules.reply : SocialReply.reply(question.trim(), ko, !QueryParser.kindWords(question).isEmpty());
            JSONObject next = new JSONObject();
            try { next.put("scope", "social"); } catch (Exception ignored) { }
            Router.Turn t = new Router.Turn(Router.Route.CHAT, "Chat", reply, null, next);
            t.social = true; t.why = Router.Why.MODEL; t.parsed = rules.parsed; t.afterFiles = prev != null;
            return t;
        }
        if ("out".equals(route)) {
            String reply = rules.route == Router.Route.OUT ? rules.reply : Router.outOfScope(ko, wasOut, false);
            Router.Turn t = Router.outTurn(reply, null, prev != null);
            t.why = Router.Why.MODEL; t.parsed = rules.parsed;
            return t;
        }
        if (!"files".equals(route)) return null;

        SearchQuery q = new SearchQuery();
        q.korean = ko;
        q.kind = kindOf(str(o, "kind"));
        // A place the model names must be in the message and in the gazetteer — never a guess, never its own spelling.
        String place = str(o, "place");
        if (place != null && mentions(question, place)) {
            GeoLookup.Place p = geo.byPlaceName(place);
            if (p == null) p = geo.byPlaceName(QueryParser.stripPlaceParticles(place));
            if (p != null) { q.city = p.city; q.country = p.country; }
        }
        long[] when = QueryParser.dateWindow(str(o, "when"), nowMs);
        if (when != null) { q.dateFrom = when[0]; q.dateTo = when[1] == Long.MAX_VALUE ? null : when[1]; }
        JSONArray content = o.optJSONArray("content");
        boolean media = q.kind == null || FileIndex.PHOTO.equals(q.kind) || FileIndex.VIDEO.equals(q.kind) || FileIndex.SCREENSHOT.equals(q.kind);
        if (content != null) {
            for (int i = 0; i < content.length() && q.keywords.size() < MAX_CONTENT; i++) {
                for (String w : content.optString(i, "").trim().split("\\s+")) {
                    String k = QueryParser.stripParticles(w.replaceAll("^[\"'.,;:!?]+|[\"'.,;:!?]+$", ""));
                    // Only words about the files, and only words the person actually wrote: no verbs, no inventions.
                    if (k.isEmpty() || QueryParser.isStopOrKind(k, media) || !mentions(question, k) || q.keywords.contains(k)) continue;
                    q.keywords.add(k);
                }
            }
        }
        String task = str(o, "task");
        SearchQuery seen = rules.query != null ? rules.query : rules.parsed;
        if ("count".equals(task)) q.count = true;
        else if ("collect".equals(task) && seen != null && seen.collect) q.collect = true;   // the verb was there; the model only confirms it
        // delete / move / share: never from the model (an unknown task word falls to find).
        q.limit = Math.max(0, Math.min(MAX_LIMIT, o.optInt("limit", 0)));
        q.oldestFirst = o.optBoolean("oldest", false);
        if (o.optBoolean("largest", false)) { q.bySize = true; if (q.limit == 0) q.minSize = QueryParser.LARGE_BYTES; }
        // A follow-up inherits what it does not restate, as QueryParser.parse does with the previous turn.
        if (prev != null && (QueryParser.isFollowUp(question) || q.isTaskOnly() || !q.hasFilters())) {
            if (q.kind == null) q.kind = prev.kind;
            if (q.city == null && q.country == null) { q.city = prev.city; q.country = prev.country; }
            if (q.dateFrom == null && q.dateTo == null) { q.dateFrom = prev.dateFrom; q.dateTo = prev.dateTo; }
            if (q.minSize == null) q.minSize = prev.minSize;
            if (q.limit == 0) q.limit = prev.limit;
            q.oldestFirst |= prev.oldestFirst;
            q.bySize |= prev.bySize;
            for (String k : prev.keywords) if (!q.keywords.contains(k)) q.keywords.add(0, k);
            q.followUp = true;
        }
        // "files" with nothing to search for would list the whole drive: not an answer, the rules' one is.
        if (!q.hasFilters() && !q.count && q.limit == 0 && !q.oldestFirst && !q.bySize) return null;
        Router.Turn t = new Router.Turn(Router.Route.FILES, Router.intentOf(q), null, q, q.toJson());
        t.why = Router.Why.MODEL; t.parsed = rules.parsed; t.afterFiles = prev != null;
        return t;
    }

    private static @Nullable String str(JSONObject o, String key) {
        if (o.isNull(key)) return null;
        String s = o.optString(key, "").trim();
        return s.isEmpty() || s.equalsIgnoreCase("null") ? null : s;
    }

    /** The word (minus a possessive) appears in the message, case-blind; Korean particles on the message side are fine as substrings. */
    private static boolean mentions(String question, String word) {
        String w = word.toLowerCase(Locale.ROOT).replaceAll("'s$|’s$", "").trim();
        return !w.isEmpty() && question.toLowerCase(Locale.ROOT).contains(w);
    }

    private static @Nullable String kindOf(@Nullable String k) {
        if (k == null) return null;
        switch (k.toLowerCase(Locale.ROOT)) {
            case "photo": return FileIndex.PHOTO;
            case "screenshot": return FileIndex.SCREENSHOT;
            case "video": return FileIndex.VIDEO;
            case "audio": return FileIndex.AUDIO;
            case "pdf": return FileIndex.PDF;
            case "document": return FileIndex.DOCUMENT;
            case "spreadsheet": return FileIndex.SPREADSHEET;
            case "presentation": return FileIndex.PRESENTATION;
            case "archive": return FileIndex.ARCHIVE;
            default: return null;
        }
    }

    /** Bridge for the LiteRT-LM summariser (kept out of the class so tests never load the runtime). */
    public static Model of(ai.ainetwork.aindrive.llm.Summarizer llm) {
        return new Model() {
            @Override public @Nullable String complete(String system, List<String[]> examples, String user, String schema) { return llm.json(system, examples, user, schema, MAX_TOKENS); }
            @Override public void cancel() { llm.cancel(); }
        };
    }
}
