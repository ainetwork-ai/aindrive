package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
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

    /**
     * WHICH branch of {@link #route} decided — the evidence behind a route, not the route. The
     * LLM trigger ({@link UnderstandTrigger}) asks the model only after the thin ones, so a
     * decision must say whether it came from a pattern, a named kind word, a follow-up of the
     * previous search, a bare search-box query, or the out-of-scope fall-through.
     */
    public enum Why { PATTERN, CALLS, NAMED, FOLLOW_UP, SEARCH_BOX, OUT, SOCIAL, MODEL }

    public static final class Decision {
        public final Route route;
        public final @Nullable String reply;
        public final @Nullable SearchQuery query;
        /** Chit-chat that deserves a real reply (the on-device LLM writes one when it's there). */
        public boolean social;
        public Why why = Why.PATTERN;
        /** The rules' parse of the text, kept even when the route is not FILES (an OUT turn's kind/place/date words). */
        public @Nullable SearchQuery parsed;
        /** A weak kind word, a place, a date or a kind word was seen — an OUT turn that might still be about files. */
        public boolean hint;
        Decision(Route r, @Nullable String reply, @Nullable SearchQuery q) { route = r; this.reply = reply; query = q; }
        Decision by(Why w, @Nullable SearchQuery p, boolean h) { why = w; parsed = p; hint = h; return this; }
    }

    /** Kind words that are also everyday words: "live music", "a text", "a movie tonight", "the slides at the park". */
    static final Set<String> WEAK_KINDS = new HashSet<>(Arrays.asList(
            "movie", "movies", "music", "song", "songs", "clip", "clips", "voice", "word", "text", "notes", "note",
            "sheet", "sheets", "slide", "slides", "deck", "capture", "captures", "archive", "archives", "doc", "docs",
            "keynote", "presentation", "audio", "memo", "picture", "md", "markdown", "excel", "zip", "pic", "rar",
            "음악", "노래", "한글", "텍스트", "메모", "시트", "슬라이드", "자료", "것들", "워드", "오디오", "이미지"));

    /** An owner right before it, or a place on the phone, makes a weak kind word mean files: "my music", "songs on my phone" — not "my favourite songs are pop". */
    private static final Pattern OWNED = Pattern.compile(
            "\\b(my|our)\\s+(music|songs?|movies?|clips?|notes?|memos?|voice memos?|audio|slides?|sheets?|docs?|archives?|texts?|presentations?)\\b(?!\\s+(at|is|was|will|starts?|practice|lessons?|class(es)?|teachers?|festival|concert|band|recital)\\b)"
            + "|\\b(on|in|from)\\s+(this|my)\\s+(phone|drive|folder|device|gallery|camera roll)\\b|\\b(saved|downloaded)\\b"
            + "|(내|나의|제|저장된|저장한|다운받은)\\s*(음악|노래|메모|텍스트|슬라이드|자료|오디오)|폰에\\s*있는", Pattern.CASE_INSENSITIVE);

    /** Weak kind words that are verbs or everyday nouns in the singular. */
    private static final Set<String> SINGULAR = new HashSet<>(Arrays.asList(
            "note", "doc", "text", "word", "slide", "sheet", "capture", "archive", "clip", "memo", "md", "deck", "song", "movie", "picture", "keynote", "presentation", "audio", "excel", "zip", "rar", "pic", "markdown"));

    /** Kind words from the world of entertainment ("find me some songs", "a movie tonight"): files only when owned or made. */
    static final Set<String> MEDIA_WEAK = new HashSet<>(Arrays.asList("movie", "movies", "music", "song", "songs", "음악", "노래", "voice"));

    /** A request about stored things: "open the contract docs", "the 5 largest docs", "how many notes". */
    private static final Pattern FILE_REQUEST = Pattern.compile(
            "^(please |can you |could you |ok,? |okay,? )?(show|find|open|list|pull up|get|collect|gather|share|delete|remove|count|move|put|organi[sz]e|where('s| is| are)|where (did|do) i (put|save|leave|keep))\\b"
            + "|\\bhow many\\b|\\b(largest|biggest|oldest|newest|latest|most recent)\\b", Pattern.CASE_INSENSITIVE);

    /** Lowercase plurals that, in a file agent, mean files ("clips from Barcelona", "lease sheets") — "Great Clips" is a salon. */
    private static final Pattern FILEISH = Pattern.compile("\\b(clips|docs|sheets|slides|decks|archives|notes|memos)\\b");
    private static final Pattern ABOUT = Pattern.compile("\\b(about|on|regarding|for my)\\s+(the\\s+)?\\w+", Pattern.CASE_INSENSITIVE);

    /** "any clips?", "my invoice sheets", "the notes for my salary". */
    private static final Pattern OPENS_OWNED = Pattern.compile("^(any|my)\\b|\\b(for|with) my\\b", Pattern.CASE_INSENSITIVE);

    /** "clips taken in Toronto", "notes I saved last week": a weak kind word the person made or kept. */
    private static final Pattern MADE = Pattern.compile("\\b(taken|took|shot|filmed|recorded|saved|downloaded|scanned|wrote|written)\\b", Pattern.CASE_INSENSITIVE);

    /** Words of a request sentence, not of a search-box query: "Find me a good restaurant", "I want to eat". */
    private static final Pattern SENTENCE = Pattern.compile(
            "\\b(i|i'm|i'd|me|you|we|us|they|it|is|are|am|be|do|does|did|can|could|would|will|should|want|wanna|need|like|looking|look|find|get|book|reserve|buy|pay|send|play|watch|listen|go|make|tell|give|help|what|what's|where|when|how|who|which|why|yes|yeah|yep|no|nope|please|sure|right|correct|that|this|there|some|any|else|other|another|the|to|search|show|leaving|leave)\\b"
            + "|[?]|해줘|할래|싶어|주세요|어때|뭐야|언제|누구|왜|예약|알려", Pattern.CASE_INSENSITIVE);

    /** "Drive", "gallery" are also street and shop names ("1450 Creekside Drive", "Reframe Hair Gallery"): only with an owner. */
    private static final Pattern FILE_WORDS = Pattern.compile(
            "\\bfolders?\\b|\\b(my|this|our)\\s+(drive|gallery)\\b|\\bcamera roll\\b|\\bthumbnails?\\b|폴더|드라이브|갤러리|앨범", Pattern.CASE_INSENSITIVE);

    /** Playing media is a player's job, not a file search: "play the song on my kitchen speaker", "what time is my movie playing". */
    private static final Pattern PLAYBACK = Pattern.compile("\\b(play|plays|playing|played|listen|listening|watch|watching|stream|streaming|speakers?|enjoy|mood|jams|youtube|tiktok|netflix|instagram)\\b", Pattern.CASE_INSENSITIVE);

    /** Signs that a kind word asks for the person's own files. */
    private static final Pattern FILE_INTENT = Pattern.compile(
            "\\b(my|mine|our)\\b|\\bhow many\\b|\\b(show|find|search|collect|gather|share|delete|remove|move|copy|open|list|organi[sz]e|count)\\b|\\b(taken|took|saved|downloaded|recorded)\\b|\\bfrom (last|this|(19|20)\\d\\d)\\b"
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
        return route(parser, question, nowMs, prev, wasOut, false);
    }

    /** @param wasSocial the conversation is chit-chat: "In Oakland." or "travel videos" there is small talk, not a search. */
    public static Decision route(QueryParser parser, String question, long nowMs, @Nullable SearchQuery prev, boolean wasOut, boolean wasSocial) {
        String t = question == null ? "" : question.trim();
        if (t.isEmpty()) return new Decision(Route.CHAT, AskRunner.greeting(false), null);
        String chat = AskRunner.smallTalk(t);
        if (chat != null) return new Decision(Route.CHAT, chat, null);
        boolean ko = t.codePoints().anyMatch(cp -> cp >= 0xAC00 && cp <= 0xD7A3);
        if (CLOSING.matcher(t).matches() || onlyWords(t, CLOSING_WORDS, CLOSING_ANCHORS)) return new Decision(Route.CHAT, ko ? "천만에요!" : "You're welcome!", null);
        if (onlyWords(t, GREETING_WORDS, GREETING_ANCHORS) || GREET_NAME.matcher(t).matches()) return new Decision(Route.CHAT, AskRunner.greeting(ko), null);

        SearchQuery q = parser.parse(t, nowMs, prev);
        if (q.calls) return new Decision(Route.CALLS, null, q).by(Why.CALLS, q, false);

        boolean named = false, weak = false;
        for (String k : QueryParser.kindWords(t)) {
            if (!WEAK_KINDS.contains(k)) named = true;
            // A weak word counts only as a lowercase plural: "make a note", "Great Clips", "Doc appointment" are not files.
            else if (!SINGULAR.contains(k) && (!k.matches("[a-z]+") || Pattern.compile("\\b" + Pattern.quote(k) + "\\b").matcher(t).find())) weak = true;
        }
        if (named && NARRATION.matcher(t).find()) named = false;
        // Talking about yourself is conversation, not a request: "I like taking photos", "my dog loves videos".
        String norm = QueryParser.normalise(t);   // "slide decks" → "presentations", "screen grabs" → "screenshots"
        boolean asks = (FILE_ASK.matcher(norm).find() || TAKEN_IN.matcher(t).find() && !QueryParser.kindWords(t).isEmpty())
                && !YOURS.matcher(t).find() && !SHARE_WITH_PEOPLE.matcher(t).find() && !SOMEDAY.matcher(t).find();
        // …and so is asking the assistant about itself: "what kind of pictures do you like to take?"
        boolean aboutSelf = (SELF_TALK.matcher(t).find() || YOU.matcher(t).find()) && !asks;
        if (aboutSelf || wasSocial && !asks) named = false;
        // A long statement that merely mentions videos or photos ("I love watching cat videos on YouTube") is chat.
        if (named && !asks && WHAT_KIND.matcher(t).find()) { named = false; aboutSelf = true; }
        if (named && !asks && (words(t) >= 7 && PEOPLE_TALK.matcher(t).find() || words(t) >= 12 || PLAYBACK.matcher(t).find())) { named = false; aboutSelf = true; }
        // Inside a conversation about something else, "I'd like to see some pictures" means pictures of THAT.
        if (named && wasOut && !FILE_INTENT.matcher(t).find()) named = false;
        boolean media = false;
        for (String k : QueryParser.kindWords(t)) media |= MEDIA_WEAK.contains(k);
        boolean fileish = FILEISH.matcher(t).find();
        boolean weakMeansFiles = weak && !PLAYBACK.matcher(t).find() && (OWNED.matcher(t).find() && (asks || words(t) <= 5)
                || !media && (MADE.matcher(t).find() || FILE_REQUEST.matcher(t).find() || asks)
                || fileish && (q.city != null || q.country != null || q.dateFrom != null || OPENS_OWNED.matcher(t).find()
                        || ABOUT.matcher(t).find() || words(t) <= 4 && !SENTENCE.matcher(t).find()));
        if (aboutSelf || wasSocial && !asks) weakMeansFiles = false;
        if (named || !aboutSelf && !(wasSocial && !asks) && FILE_WORDS.matcher(t).find() || weakMeansFiles) return new Decision(Route.FILES, null, q).by(Why.NAMED, q, true);
        // A follow-up of a file question is short and about the files — not "Me too! I'm sure it will be bright for you."
        if (prev != null && !aboutSelf && (words(t) <= 10 || asks) && (q.followUp || q.isTaskOnly() || few(q, 2) && q.ignoredWords <= 1 && words(t) <= 7))
            return new Decision(Route.FILES, null, q).by(Why.FOLLOW_UP, q, true);
        // A search-box query opening the conversation: "Paris", "last winter in Tokyo", "dog".
        if (!wasOut && !wasSocial && prev == null && few(q, 1) && q.ignoredWords == 0 && !weak && words(t) <= 5 && !SENTENCE.matcher(t).find()
                && (q.keywords.isEmpty() ? q.city != null || q.country != null || q.dateFrom != null : ContentWords.isVisual(q.keywords.get(0))))
            return new Decision(Route.FILES, null, q).by(Why.SEARCH_BOX, q, true);
        // Not about files. A service request (book, weather, a ride…) is out of scope — and so is the rest of that
        // conversation; anything else is people talking, which gets a friendly reply.
        // The sentence had no file word — but a weak one, a place, a date or a kind word means it might still be
        // about files ("the slides at the park", "the stuff from Jeju last spring"): the trigger's hint, for both fall-throughs.
        boolean hint = weak || q.city != null || q.country != null || q.dateFrom != null || !QueryParser.kindWords(t).isEmpty();
        if (wasOut && !SELF_TALK.matcher(t).find() || SERVICE.matcher(t).find() && !(wasSocial && YOU.matcher(t).find())
                || !wasSocial && !SOCIAL_Q.matcher(t).find() && (IMPERATIVE.matcher(t).find() && !YOU.matcher(t).find() || FACT_Q.matcher(t).find() && !YOU.matcher(t).find() && !SELF_TALK.matcher(t).find()))
            return new Decision(Route.OUT, outOfScope(ko, wasOut, weak), null).by(Why.OUT, q, hint);
        Decision d = new Decision(Route.CHAT, SocialReply.reply(t, ko, !QueryParser.kindWords(t).isEmpty()), null).by(Why.SOCIAL, q, hint);
        d.social = true;
        return d;
    }

    /** A turn about the speaker or the listener: "I love hiking", "my sister…", "do you have pets?", "that's cool". */
    private static final Pattern SELF_TALK = Pattern.compile(
            "^((oh|wow|yeah|yes|no|well|haha|lol|hmm|ah|aw+|ok|okay|sure|cool|nice|really|same|me too|thanks|thank you|awesome|great|hi|hey|hello|not much|omg|that's (cool|great|awesome|nice|interesting|amazing|so cool|really cool)|sounds (good|great|fun|cool))[,.!]*\\s+)*"
            + "(i|i'm|i've|i'd|i'll|im|ive|my|me|we|we're|we've|our|you|you're|you've|your|do you|did you|are you|have you|would you|what's your|what is your|how about you|what about you|that|that's|it|it's|they|they're|he|she|he's|she's|those are|these are|sounds|maybe|so)\\b"
            + "|^(나는|난|저는|전|내가|제가|우리|너는|넌|당신)", Pattern.CASE_INSENSITIVE);
    /** …unless it asks for files: "I want to see my photos from Paris", "can you show my videos", "my 5 biggest clips". */
    private static final String REQ_VERBS = "show|find|search|search for|collect|gather|share|delete|remove|move|copy|open|list|organi[sz]e|count|bundle|dig up|pull up|bring up|look for|get|put|make|throw|send|save|wipe|erase|trash|display|locate|give";
    private static final Pattern FILE_ASK = Pattern.compile(
            // a verb in request position: "show me…", "can you find…", "I want to see…", "please share them"
            "(^|[.!?]\\s+)((please|ok|okay|now|also|then|and|so|hey|actually|never mind)[,.]?\\s+)*"
            + "(can you |could you |would you |will you |help me |let me |i (want|need) (you )?to |i('d| would) like (you )?to |i('d| would) love to |i('m| am) trying to )?"
            + "(" + REQ_VERBS + "|see|check|look at|view)\\b(?! (you|it to you|them to you|new|ways|a way|out|more|the best))"
            + "|\\bhow many\\b|\\bwhere (are|is|did i put|did i save)\\b|\\blooking for (the|my|all|some|those|these|any)\\b(?! (best|perfect|right|new|good))"
            + "|\\bi (need|want) (the|my|all|those|these)\\b|^(my|any) ([\\w-]+ ){0,2}(photos|pictures|pics|snaps|shots|images|videos|clips|screenshots|recordings|voice memos|pdfs|documents|docs|files|notes|sheets|spreadsheets|presentations|slides|music|songs|audio)\\b|\\bmy \\d+\\b|^(do i have|are there( any)?|is there( a| an| any)?|have i got|did i (take|save|record|download))\\b|\\b(number of|tell me how many|tell me the number)\\b"
            + "|\\b(into|in|to) (a |an |one |the |new |a new |their own |separate )*(album|folder)\\b|\\b(make|create) (a |an |one )?(new )?(album|folder)\\b|\\b(give|send) me (a |the )?link\\b|\\blink (to|for) (those|them|these|it|the)\\b"
            + "|찾아|보여|모아|공유|지워|삭제|옮겨|정리|몇", Pattern.CASE_INSENSITIVE);
    /** Things that are the listener's, not the phone's: "I'd love to see your photos". */
    private static final Pattern YOURS = Pattern.compile("\\byour\\b", Pattern.CASE_INSENSITIVE);
    /** "share my music with people", "share some of my photos with you": sharing as a social act. */
    private static final Pattern SHARE_WITH_PEOPLE = Pattern.compile("\\bshare\\b.{0,40}\\bwith (you|people|other people|others|the world|everyone|friends|my friends|family)\\b|\\b(send|show) you\\b", Pattern.CASE_INSENSITIVE);
    /** "I'd love to see pictures of them sometime": a wish, not a request. */
    private static final Pattern SOMEDAY = Pattern.compile("\\b(sometime|someday|one day|some day|next time|later)\\b|\\bto (a |the )?music video\\b", Pattern.CASE_INSENSITIVE);
    /** "taken in Paris", "the ones I took last summer" — pointing at existing files, unlike "I took a lot of photos". */
    private static final Pattern TAKEN_IN = Pattern.compile("\\btaken (in|at|on|from|during|last|this|near)\\b|\\b(i|we) (took|shot|recorded) (in|at|on|during|last|this|yesterday|today)\\b", Pattern.CASE_INSENSITIVE);
    /** "What kind of video?" — asking about someone's taste. */
    private static final Pattern WHAT_KIND = Pattern.compile("^(\\w+[!,.]\\s+)*what (kind|kinds|sort|type|types) of\\b", Pattern.CASE_INSENSITIVE);
    /** Statements about people (me, my dad, she…) rather than requests. */
    private static final Pattern PEOPLE_TALK = Pattern.compile("^((oh|wow|yeah|yes|well|haha|so|and|but|cool|nice|awesome|great)[,.!]*\\s+)*(i|i'm|i've|i'd|my|me|we|he|she|they|he's|she's|they're|you|you're|it's|that's|there's)\\b|[.!]\\s+(i|i'm|he|she|my|we)\\b", Pattern.CASE_INSENSITIVE);

    /** Asking for a service aindrive doesn't offer. */
    private static final Pattern SERVICE = Pattern.compile(
            "(^|[.!?]\\s+)(please |can you |could you |would you |i('d| would) like( you)? to |i (want|need)( you)? to |i want |i need |help me (to )?|i'm looking for |i am looking for )?"
            + "(book|reserve|order|rent|buy|schedule|set up|set|call|check|find|get|search for|look for|look up|cancel|transfer|pay|send|play|recommend|translate|remind)\\b[^.?!]{0,40}"
            + "\\b(flights?|hotels?|rooms?|airbnb|tickets?|appointments?|alarms?|reminders?|weather|forecast|rides?|cab|taxi|uber|lyft|bus|buses|trains?|rental cars?|restaurants?|table|reservations?|salon|stylist|dentist|doctor|payments?|pizza|delivery|directions|showtimes?|timer|jazz|songs?|music|movies?|joke|massage|house|apartment)\\b"
            + "|\\b(what's|what is|how's|how is|check|tell me)( the)? (weather|forecast)\\b(?! (like )?(today|lately) for you)|\\bremind me (to|at|in|about|tomorrow|tonight|later)\\b|\\bset (an|a) (alarm|timer)\\b|^i (need|want) (a|an|some) (hotel|flight|ride|cab|taxi|table|room|car|ticket)", Pattern.CASE_INSENSITIVE);
    private static final Pattern IMPERATIVE = Pattern.compile("^(please |can you |could you )?(book|reserve|order|rent|buy|schedule|set|call|check|find|get|search|look up|tell me|give me|play|send|transfer|translate|remind|recommend|cancel|show me how)\\b", Pattern.CASE_INSENSITIVE);
    /** Openers that are small talk even without a "you": "What's up?", "How's the day going?", "What a day!" */
    private static final Pattern SOCIAL_Q = Pattern.compile("^((oh|wow|nice|hey|hi|cool)[,!.]*\\s+)*((what\\W{0,3}s|what is|whats) (up|new|good|wrong|going on|happening|the matter)|what (kind|kinds|sort|type) of|what an? |how('s| is| was| are)\\b(?! (much|many|far|long|tall|big|old is the))|can'?t complain|not (much|bad)|so what'?s)", Pattern.CASE_INSENSITIVE);
    private static final Pattern FACT_Q = Pattern.compile("^(what|what's|whats|when|where|which|who|how|why|is|are|does|do|did|can|will)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern YOU = Pattern.compile("(?<!thank )\\b(you|your|you're|yourself|u)\\b|너|당신", Pattern.CASE_INSENSITIVE);

    /** One turn understood: where it goes, what it asks, the query, and the context to hand the next turn. */
    public static final class Turn {
        public final Route route;
        public final String intent;
        public final @Nullable String reply;
        public final @Nullable SearchQuery query;
        public final @Nullable org.json.JSONObject nextContext;
        public boolean social;
        /** How the rules decided (see {@link Why}); {@code MODEL} when the on-device LLM's reading replaced theirs. */
        public Why why = Why.PATTERN;
        /** The rules' parse, whatever the route — what an OUT turn's words looked like as a search. */
        public @Nullable SearchQuery parsed;
        /** See {@link Decision#hint}. */
        public boolean hint;
        /** The turn followed a file search (there was a previous search to refine). */
        public boolean afterFiles;
        /** The text asks something ("?", or a Korean question ending). */
        public boolean question;
        Turn(Route route, String intent, @Nullable String reply, @Nullable SearchQuery query, @Nullable org.json.JSONObject next) {
            this.route = route; this.intent = intent; this.reply = reply; this.query = query; nextContext = next;
        }
        Turn by(Decision d, boolean afterFiles) { why = d.why; parsed = d.parsed; hint = d.hint; this.afterFiles = afterFiles; return this; }
        Turn asking(String text) { question = QUESTION.matcher(text).find(); return this; }
    }

    /**
     * The whole of "what did they mean": routing, the parsed query with the previous turn's
     * context applied, the intent, and the context the shell keeps for the next turn. The app
     * (AskRunner.ask) and the dialogue benchmark (DialogueDatasetTest) both go through here.
     */
    public static Turn understand(QueryParser parser, String question, long nowMs, @Nullable org.json.JSONObject context) {
        boolean wasOut = context != null && "out".equals(context.optString("scope"));
        boolean wasSocial = context != null && "social".equals(context.optString("scope"));
        SearchQuery prev = wasOut || wasSocial ? null : SearchQuery.fromJson(context);
        Decision d = route(parser, question, nowMs, prev, wasOut, wasSocial);
        Turn tn;
        switch (d.route) {
            case CHAT: {
                org.json.JSONObject next = context;
                if (d.social) { next = new org.json.JSONObject(); try { next.put("scope", "social"); } catch (org.json.JSONException ignored) { } }
                tn = new Turn(d.route, "Chat", d.reply, null, next).by(d, prev != null); tn.social = d.social; break;
            }
            case OUT: tn = outTurn(d.reply, d, prev != null); break;
            case CALLS: tn = new Turn(d.route, d.query.likes ? "WhoLikesMe" : d.query.transcribe ? "TranscribeCall" : "CallReport", null, d.query, context).by(d, prev != null); break;
            default: tn = new Turn(d.route, intentOf(d.query), null, d.query, d.query.toJson()).by(d, prev != null);
        }
        return tn.asking(question == null ? "" : question);
    }

    /** "…?", "…있어", "…있나요", "…뭐야": the person asked something. */
    private static final Pattern QUESTION = Pattern.compile("\\?|(있어|있나|있니|있나요|있을까|없어|없나|뭐야|뭐지|어디|언제|몇)[요]?[.!]*$");

    /** An out-of-scope turn: the reply plus the context that keeps the rest of the conversation out. */
    static Turn outTurn(@Nullable String reply, @Nullable Decision d, boolean afterFiles) {
        org.json.JSONObject out = new org.json.JSONObject();
        try { out.put("scope", "out"); } catch (org.json.JSONException ignored) { }
        Turn t = new Turn(Route.OUT, "OutOfScope", reply, null, out);
        return d == null ? t : t.by(d, afterFiles);
    }

    static String intentOf(SearchQuery q) {
        if (q.delete) return "DeleteFiles";
        if (q.move) return "MoveFiles";
        if (q.share) return "ShareFiles";
        if (q.collect) return "CollectFiles";
        if (q.count) return "CountFiles";
        return "FindFiles";
    }

    private static final Set<String> CLOSING_WORDS = new HashSet<>(Arrays.asList(
            "thanks", "thank", "thx", "ty", "you", "so", "much", "very", "a", "lot", "bunch", "that's", "thats", "that", "is", "it", "all", "for", "now", "the", "help",
            "great", "perfect", "ok", "okay", "alright", "fine", "good", "sounds", "cool", "awesome", "nice", "excellent", "wonderful", "bye", "goodbye", "cheers",
            "see", "later", "got", "i", "i'm", "im", "done", "set", "appreciate", "have", "day", "one", "night", "hope", "too", "same", "to", "u", "take", "care", "enjoy", "rest", "of", "your", "weekend", "evening", "do", "again", "sure", "thing", "no", "nope", "nothing", "else", "more", "that'll", "be", "will", "would"));
    private static final Set<String> CLOSING_ANCHORS = new HashSet<>(Arrays.asList(
            "thanks", "thank", "thx", "ty", "bye", "goodbye", "cheers", "appreciate", "great", "perfect", "awesome", "cool", "sounds", "that's", "thats", "done", "excellent", "wonderful", "night", "care", "will"));
    private static final Pattern GREET_NAME = Pattern.compile("^(?i:hi|hey|hello|hiya|yo)(?i: there)?[,!]?\\s+[A-Z][\\p{L}'-]+[!.]*$");
    private static final Set<String> GREETING_WORDS = new HashSet<>(Arrays.asList(
            "hi", "hello", "hey", "there", "yo", "hiya", "howdy", "good", "morning", "afternoon", "evening", "greetings", "agent", "aindrive", "how", "are", "you", "doing"));
    private static final Set<String> GREETING_ANCHORS = new HashSet<>(Arrays.asList("hi", "hello", "hey", "yo", "hiya", "howdy", "morning", "afternoon", "evening", "greetings"));

    /** Every word is from `words` and one is an anchor: "Thanks, that's it.", "Hey there". */
    private static boolean onlyWords(String t, Set<String> words, Set<String> anchors) {
        boolean anchor = false;
        for (String w : t.toLowerCase(Locale.ROOT).replace('’', '\'').split("[^a-z']+")) {
            if (w.isEmpty()) continue;
            if (!words.contains(w)) return false;
            anchor |= anchors.contains(w);
        }
        return anchor;
    }

    /** At most n leftover words: the rest was place/date/kind. */
    private static boolean few(SearchQuery q, int n) { return q.keywords.size() <= n; }

    private static int words(String t) { return t.split("\\s+").length; }

    static String outOfScope(boolean ko, boolean again, boolean weak) {
        String hint = weak ? (ko ? " 폰에 있는 파일을 말하는 거라면 “내 노래 파일”처럼 말해 주세요." : " If you mean files on this phone, say “my songs” or “my videos from last summer”.") : "";
        if (again) return (ko ? "그건 여기서 할 수 없어요 — 이 폰의 파일과 통화 기록만 다뤄요." : "I can't help with that here — I only work with the files and call history on this phone.") + hint;
        return (ko
                ? "그건 제가 할 수 없는 일이에요. 저는 이 폰의 파일을 찾고 정리해요 — 사진, 영상, 녹음, 문서, 통화 기록. 예: “도쿄에서 찍은 사진”, “이번달 음식 사진 모아서 공유해줘”, “누구랑 제일 많이 통화해?”"
                : "That's not something I can do. I find and organise the files on this phone — photos, videos, recordings, documents and your call history. Try “photos taken in Tokyo”, “collect this month's food photos and share them”, or “who do I call the most?”.") + hint;
    }
}
