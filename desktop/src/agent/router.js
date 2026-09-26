// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/Router.java
/**
 * Decides what a chat turn IS before anything touches the index: small talk,
 * a request this agent can't serve, a call-log report, or a file question.
 *
 * A turn is a file question only when it is ABOUT files:
 *  - it names files ("photos", "recordings", "PDF", "사진", "녹음", "folder"),
 *    or an ambiguous kind word with an owner ("my music", "my notes");
 *  - or it asks about calls (the call-log report);
 *  - or it follows a file question ("only the ones from Paris", "and share them");
 *  - or it opens a conversation as a search-box query ("Paris", "last winter
 *    in Tokyo", "dog") — a few words, nothing else.
 * Anything else is out of scope, and a conversation that went out of scope
 * stays there: "San Jose" answering "which city?" is not a photo search.
 *
 * Checked against every user turn of the Schema-Guided Dialogue corpus and
 * Persona-chat (src/__tests__/router.test.js), like the phone.
 */
import { isVisual } from "./content-words.js";
import { hasHangul, javaSplit, javaTrim, jre, jreFull } from "./java-regex.js";
import { kindWords, normalise } from "./query-parser.js";
import { SearchQuery } from "./search-query.js";
import { greeting, smallTalk } from "./small-talk.js";
import { socialReply } from "./social-reply.js";

/** Where a turn goes: Java's Router.Route enum, by name. */
export const Route = Object.freeze({ CHAT: "CHAT", OUT: "OUT", CALLS: "CALLS", FILES: "FILES" });

/** Kind words that are also everyday words: "live music", "a text", "a movie tonight", "the slides at the park". */
export const WEAK_KINDS = new Set([
  "movie", "movies", "music", "song", "songs", "clip", "clips", "voice", "word", "text", "notes", "note",
  "sheet", "sheets", "slide", "slides", "deck", "capture", "captures", "archive", "archives", "doc", "docs",
  "keynote", "presentation", "audio", "memo", "picture", "md", "markdown", "excel", "zip", "pic", "rar",
  "음악", "노래", "한글", "텍스트", "메모", "시트", "슬라이드", "자료", "것들", "워드", "오디오", "이미지"]);

/** An owner right before it, or a place on the phone, makes a weak kind word mean files: "my music", "songs on my phone". */
const OWNED = jre(
  "\\b(my|our)\\s+(music|songs?|movies?|clips?|notes?|memos?|voice memos?|audio|slides?|sheets?|docs?|archives?|texts?|presentations?)\\b(?!\\s+(at|is|was|will|starts?|practice|lessons?|class(es)?|teachers?|festival|concert|band|recital)\\b)"
  + "|\\b(on|in|from)\\s+(this|my)\\s+(phone|drive|folder|device|gallery|camera roll)\\b|\\b(saved|downloaded)\\b"
  + "|(내|나의|제|저장된|저장한|다운받은)\\s*(음악|노래|메모|텍스트|슬라이드|자료|오디오)|폰에\\s*있는", { ci: true });

/** Weak kind words that are verbs or everyday nouns in the singular. */
const SINGULAR = new Set([
  "note", "doc", "text", "word", "slide", "sheet", "capture", "archive", "clip", "memo", "md", "deck", "song", "movie", "picture", "keynote", "presentation", "audio", "excel", "zip", "rar", "pic", "markdown"]);

/** Kind words from the world of entertainment ("find me some songs", "a movie tonight"): files only when owned or made. */
export const MEDIA_WEAK = new Set(["movie", "movies", "music", "song", "songs", "음악", "노래", "voice"]);

/** A request about stored things: "open the contract docs", "the 5 largest docs", "how many notes". */
const FILE_REQUEST = jre(
  "^(please |can you |could you |ok,? |okay,? )?(show|find|open|list|pull up|get|collect|gather|share|delete|remove|count|move|put|organi[sz]e|where('s| is| are)|where (did|do) i (put|save|leave|keep))\\b"
  + "|\\bhow many\\b|\\b(largest|biggest|oldest|newest|latest|most recent)\\b", { ci: true });

/** Lowercase plurals that, in a file agent, mean files ("clips from Barcelona") — "Great Clips" is a salon. */
const FILEISH = jre("\\b(clips|docs|sheets|slides|decks|archives|notes|memos)\\b");
const ABOUT = jre("\\b(about|on|regarding|for my)\\s+(the\\s+)?\\w+", { ci: true });

/** "any clips?", "my invoice sheets", "the notes for my salary". */
const OPENS_OWNED = jre("^(any|my)\\b|\\b(for|with) my\\b", { ci: true });

/** "clips taken in Toronto", "notes I saved last week": a weak kind word the person made or kept. */
const MADE = jre("\\b(taken|took|shot|filmed|recorded|saved|downloaded|scanned|wrote|written)\\b", { ci: true });

/** Words of a request sentence, not of a search-box query: "Find me a good restaurant", "I want to eat". */
const SENTENCE = jre(
  "\\b(i|i'm|i'd|me|you|we|us|they|it|is|are|am|be|do|does|did|can|could|would|will|should|want|wanna|need|like|looking|look|find|get|book|reserve|buy|pay|send|play|watch|listen|go|make|tell|give|help|what|what's|where|when|how|who|which|why|yes|yeah|yep|no|nope|please|sure|right|correct|that|this|there|some|any|else|other|another|the|to|search|show|leaving|leave)\\b"
  + "|[?]|해줘|할래|싶어|주세요|어때|뭐야|언제|누구|왜|예약|알려", { ci: true });

/** "Drive", "gallery" are also street and shop names: only with an owner. */
const FILE_WORDS = jre(
  "\\bfolders?\\b|\\b(my|this|our)\\s+(drive|gallery)\\b|\\bcamera roll\\b|\\bthumbnails?\\b|폴더|드라이브|갤러리|앨범", { ci: true });

/** Playing media is a player's job, not a file search. */
const PLAYBACK = jre("\\b(play|plays|playing|played|listen|listening|watch|watching|stream|streaming|speakers?|enjoy|mood|jams|youtube|tiktok|netflix|instagram)\\b", { ci: true });

/** Signs that a kind word asks for the person's own files. */
const FILE_INTENT = jre(
  "\\b(my|mine|our)\\b|\\bhow many\\b|\\b(show|find|search|collect|gather|share|delete|remove|move|copy|open|list|organi[sz]e|count)\\b|\\b(taken|took|saved|downloaded|recorded)\\b|\\bfrom (last|this|(19|20)\\d\\d)\\b"
  + "|내\\s|나의|찍은|보여|찾아|모아|공유|지워|삭제|옮겨|정리", { ci: true });

/** Talking about pictures is not asking for them: "I saw pictures of that park". */
const NARRATION = jre(
  "\\b(i|we)\\s+(saw|have seen|'ve seen|looked at)\\b|\\b(photos?|pictures?)\\s+(look|looks|looked)\\b|\\bpictures? of (their|the hotel|the facilities)", { ci: true });

const CLOSING = jreFull(
  "^(no[,.!]?\\s*)?(thanks?|thank you|thank you so much|thanks a lot|many thanks|ty|that'?s (all|it|everything)|that is (all|it)|that would be (all|it)|that will be (all|it)|"
  + "nothing (else|more)|no,? that'?s (all|it)|i'?m (good|done|all set)|bye|goodbye|see you|ok(ay)?|great|cool|perfect|awesome|sounds good|got it|i appreciate (it|that)|appreciate it)"
  + "([,.!]+\\s*(that'?s all|that is all|bye|goodbye|thanks?( a lot)?|thank you( so much| very much)?|have a (good|nice|great) (day|one|night)|i appreciate (it|that)))*[.!]*$",
  { ci: true });

/** A turn about the speaker or the listener: "I love hiking", "my sister…", "do you have pets?", "that's cool". */
const SELF_TALK = jre(
  "^((oh|wow|yeah|yes|no|well|haha|lol|hmm|ah|aw+|ok|okay|sure|cool|nice|really|same|me too|thanks|thank you|awesome|great|hi|hey|hello|not much|omg|that's (cool|great|awesome|nice|interesting|amazing|so cool|really cool)|sounds (good|great|fun|cool))[,.!]*\\s+)*"
  + "(i|i'm|i've|i'd|i'll|im|ive|my|me|we|we're|we've|our|you|you're|you've|your|do you|did you|are you|have you|would you|what's your|what is your|how about you|what about you|that|that's|it|it's|they|they're|he|she|he's|she's|those are|these are|sounds|maybe|so)\\b"
  + "|^(나는|난|저는|전|내가|제가|우리|너는|넌|당신)", { ci: true });
/** …unless it asks for files: "I want to see my photos from Paris", "can you show my videos". */
const REQ_VERBS = "show|find|search|search for|collect|gather|share|delete|remove|move|copy|open|list|organi[sz]e|count|bundle|dig up|pull up|bring up|look for|get|put|make|throw|send|save|wipe|erase|trash|display|locate|give";
const FILE_ASK = jre(
  // a verb in request position: "show me…", "can you find…", "I want to see…", "please share them"
  "(^|[.!?]\\s+)((please|ok|okay|now|also|then|and|so|hey|actually|never mind)[,.]?\\s+)*"
  + "(can you |could you |would you |will you |help me |let me |i (want|need) (you )?to |i('d| would) like (you )?to |i('d| would) love to |i('m| am) trying to )?"
  + "(" + REQ_VERBS + "|see|check|look at|view)\\b(?! (you|it to you|them to you|new|ways|a way|out|more|the best))"
  + "|\\bhow many\\b|\\bwhere (are|is|did i put|did i save)\\b|\\blooking for (the|my|all|some|those|these|any)\\b(?! (best|perfect|right|new|good))"
  + "|\\bi (need|want) (the|my|all|those|these)\\b|^(my|any) ([\\w-]+ ){0,2}(photos|pictures|pics|snaps|shots|images|videos|clips|screenshots|recordings|voice memos|pdfs|documents|docs|files|notes|sheets|spreadsheets|presentations|slides|music|songs|audio)\\b|\\bmy \\d+\\b|^(do i have|are there( any)?|is there( a| an| any)?|have i got|did i (take|save|record|download))\\b|\\b(number of|tell me how many|tell me the number)\\b"
  + "|\\b(into|in|to) (a |an |one |the |new |a new |their own |separate )*(album|folder)\\b|\\b(make|create) (a |an |one )?(new )?(album|folder)\\b|\\b(give|send) me (a |the )?link\\b|\\blink (to|for) (those|them|these|it|the)\\b"
  + "|찾아|보여|모아|공유|지워|삭제|옮겨|정리|몇", { ci: true });
/** Things that are the listener's, not the phone's: "I'd love to see your photos". */
const YOURS = jre("\\byour\\b", { ci: true });
/** "share my music with people": sharing as a social act. */
const SHARE_WITH_PEOPLE = jre("\\bshare\\b.{0,40}\\bwith (you|people|other people|others|the world|everyone|friends|my friends|family)\\b|\\b(send|show) you\\b", { ci: true });
/** "I'd love to see pictures of them sometime": a wish, not a request. */
const SOMEDAY = jre("\\b(sometime|someday|one day|some day|next time|later)\\b|\\bto (a |the )?music video\\b", { ci: true });
/** "taken in Paris", "the ones I took last summer" — pointing at existing files. */
const TAKEN_IN = jre("\\btaken (in|at|on|from|during|last|this|near)\\b|\\b(i|we) (took|shot|recorded) (in|at|on|during|last|this|yesterday|today)\\b", { ci: true });
/** "What kind of video?" — asking about someone's taste. */
const WHAT_KIND = jre("^(\\w+[!,.]\\s+)*what (kind|kinds|sort|type|types) of\\b", { ci: true });
/** Statements about people (me, my dad, she…) rather than requests. */
const PEOPLE_TALK = jre("^((oh|wow|yeah|yes|well|haha|so|and|but|cool|nice|awesome|great)[,.!]*\\s+)*(i|i'm|i've|i'd|my|me|we|he|she|they|he's|she's|they're|you|you're|it's|that's|there's)\\b|[.!]\\s+(i|i'm|he|she|my|we)\\b", { ci: true });

/** Asking for a service aindrive doesn't offer. */
const SERVICE = jre(
  "(^|[.!?]\\s+)(please |can you |could you |would you |i('d| would) like( you)? to |i (want|need)( you)? to |i want |i need |help me (to )?|i'm looking for |i am looking for )?"
  + "(book|reserve|order|rent|buy|schedule|set up|set|call|check|find|get|search for|look for|look up|cancel|transfer|pay|send|play|recommend|translate|remind)\\b[^.?!]{0,40}"
  + "\\b(flights?|hotels?|rooms?|airbnb|tickets?|appointments?|alarms?|reminders?|weather|forecast|rides?|cab|taxi|uber|lyft|bus|buses|trains?|rental cars?|restaurants?|table|reservations?|salon|stylist|dentist|doctor|payments?|pizza|delivery|directions|showtimes?|timer|jazz|songs?|music|movies?|joke|massage|house|apartment)\\b"
  + "|\\b(what's|what is|how's|how is|check|tell me)( the)? (weather|forecast)\\b(?! (like )?(today|lately) for you)|\\bremind me (to|at|in|about|tomorrow|tonight|later)\\b|\\bset (an|a) (alarm|timer)\\b|^i (need|want) (a|an|some) (hotel|flight|ride|cab|taxi|table|room|car|ticket)", { ci: true });
const IMPERATIVE = jre("^(please |can you |could you )?(book|reserve|order|rent|buy|schedule|set|call|check|find|get|search|look up|tell me|give me|play|send|transfer|translate|remind|recommend|cancel|show me how)\\b", { ci: true });
/** Openers that are small talk even without a "you": "What's up?", "How's the day going?", "What a day!" */
const SOCIAL_Q = jre("^((oh|wow|nice|hey|hi|cool)[,!.]*\\s+)*((what\\W{0,3}s|what is|whats) (up|new|good|wrong|going on|happening|the matter)|what (kind|kinds|sort|type) of|what an? |how('s| is| was| are)\\b(?! (much|many|far|long|tall|big|old is the))|can'?t complain|not (much|bad)|so what'?s)", { ci: true });
const FACT_Q = jre("^(what|what's|whats|when|where|which|who|how|why|is|are|does|do|did|can|will)\\b", { ci: true });
const YOU = jre("(?<!thank )\\b(you|your|you're|yourself|u)\\b|너|당신", { ci: true });

const CLOSING_WORDS = new Set([
  "thanks", "thank", "thx", "ty", "you", "so", "much", "very", "a", "lot", "bunch", "that's", "thats", "that", "is", "it", "all", "for", "now", "the", "help",
  "great", "perfect", "ok", "okay", "alright", "fine", "good", "sounds", "cool", "awesome", "nice", "excellent", "wonderful", "bye", "goodbye", "cheers",
  "see", "later", "got", "i", "i'm", "im", "done", "set", "appreciate", "have", "day", "one", "night", "hope", "too", "same", "to", "u", "take", "care", "enjoy", "rest", "of", "your", "weekend", "evening", "do", "again", "sure", "thing", "no", "nope", "nothing", "else", "more", "that'll", "be", "will", "would"]);
const CLOSING_ANCHORS = new Set([
  "thanks", "thank", "thx", "ty", "bye", "goodbye", "cheers", "appreciate", "great", "perfect", "awesome", "cool", "sounds", "that's", "thats", "done", "excellent", "wonderful", "night", "care", "will"]);
// Java: ^(?i:hi|hey|hello|hiya|yo)(?i: there)?[,!]?\s+[A-Z][\p{L}'-]+[!.]*$ — inline (?i:) spelled out (ASCII-only folding).
const GREET_NAME = jreFull("(?:[hH][iI]|[hH][eE][yY]|[hH][eE][lL][lL][oO]|[hH][iI][yY][aA]|[yY][oO])(?: [tT][hH][eE][rR][eE])?[,!]?\\s+[A-Z][\\p{L}'-]+[!.]*", { unicode: true });
const GREETING_WORDS = new Set([
  "hi", "hello", "hey", "there", "yo", "hiya", "howdy", "good", "morning", "afternoon", "evening", "greetings", "agent", "aindrive", "how", "are", "you", "doing"]);
const GREETING_ANCHORS = new Set(["hi", "hello", "hey", "yo", "hiya", "howdy", "morning", "afternoon", "evening", "greetings"]);

/** Every word is from `words` and one is an anchor: "Thanks, that's it.", "Hey there". */
function onlyWords(t, words, anchors) {
  let anchor = false;
  for (const w of t.toLowerCase().replaceAll("’", "'").split(/[^a-z']+/)) {
    if (w === "") continue;
    if (!words.has(w)) return false;
    anchor ||= anchors.has(w);
  }
  return anchor;
}

/** At most n leftover words: the rest was place/date/kind. */
const few = (q, n) => q.keywords.length <= n;
const words = (t) => javaSplit(t, /[\t\n\x0B\f\r ]+/).length;

/** The "that's not something I can do" reply; `again` for a conversation already out of scope. */
export function outOfScope(ko, again, weak) {
  const hint = weak ? (ko ? " 폰에 있는 파일을 말하는 거라면 “내 노래 파일”처럼 말해 주세요." : " If you mean files on this phone, say “my songs” or “my videos from last summer”.") : "";
  if (again) return (ko ? "그건 여기서 할 수 없어요 — 이 폰의 파일과 통화 기록만 다뤄요." : "I can't help with that here — I only work with the files and call history on this phone.") + hint;
  return (ko
    ? "그건 제가 할 수 없는 일이에요. 저는 이 폰의 파일을 찾고 정리해요 — 사진, 영상, 녹음, 문서, 통화 기록. 예: “도쿄에서 찍은 사진”, “이번달 음식 사진 모아서 공유해줘”, “누구랑 제일 많이 통화해?”"
    : "That's not something I can do. I find and organise the files on this phone — photos, videos, recordings, documents and your call history. Try “photos taken in Tokyo”, “collect this month's food photos and share them”, or “who do I call the most?”.") + hint;
}

/**
 * @typedef {{ route: string, reply: string | null, query: SearchQuery | null, social: boolean }} Decision
 *   route: a Route value; reply: the canned answer for CHAT/OUT; query: the parsed question for FILES/CALLS;
 *   social: chit-chat that deserves a real reply (an LLM writes one when there is one).
 */
const decision = (route, reply, query, social = false) => ({ route, reply, query, social });

/**
 * Route one turn.
 * @param {import("./query-parser.js").QueryParser} parser
 * @param {string} question
 * @param {number} nowMs
 * @param {SearchQuery | null} prev   the file question this one may follow
 * @param {boolean} wasOut            the previous turn of this conversation was out of scope
 * @param {boolean} [wasSocial]       the conversation is chit-chat: "In Oakland." there is small talk, not a search
 * @returns {Decision}
 */
export function route(parser, question, nowMs, prev, wasOut, wasSocial = false) {
  const t = question == null ? "" : javaTrim(question);
  if (t === "") return decision(Route.CHAT, greeting(false), null);
  const chat = smallTalk(t);
  if (chat != null) return decision(Route.CHAT, chat, null);
  const ko = hasHangul(t);
  if (CLOSING.test(t) || onlyWords(t, CLOSING_WORDS, CLOSING_ANCHORS)) return decision(Route.CHAT, ko ? "천만에요!" : "You're welcome!", null);
  if (onlyWords(t, GREETING_WORDS, GREETING_ANCHORS) || GREET_NAME.test(t)) return decision(Route.CHAT, greeting(ko), null);

  const q = parser.parse(t, nowMs, prev);
  if (q.calls) return decision(Route.CALLS, null, q);

  const kinds = kindWords(t);
  let named = false, weak = false;
  for (const k of kinds) {
    if (!WEAK_KINDS.has(k)) named = true;
    // A weak word counts only as a lowercase plural: "make a note", "Great Clips", "Doc appointment" are not files.
    else if (!SINGULAR.has(k) && (!/^[a-z]+$/.test(k) || new RegExp("\\b" + k + "\\b").test(t))) weak = true;
  }
  if (named && NARRATION.test(t)) named = false;
  // Talking about yourself is conversation, not a request: "I like taking photos", "my dog loves videos".
  const norm = normalise(t);   // "slide decks" → "presentations", "screen grabs" → "screenshots"
  const asks = (FILE_ASK.test(norm) || (TAKEN_IN.test(t) && kinds.length > 0))
    && !YOURS.test(t) && !SHARE_WITH_PEOPLE.test(t) && !SOMEDAY.test(t);
  // …and so is asking the assistant about itself: "what kind of pictures do you like to take?"
  let aboutSelf = (SELF_TALK.test(t) || YOU.test(t)) && !asks;
  if (aboutSelf || (wasSocial && !asks)) named = false;
  // A long statement that merely mentions videos or photos is chat.
  if (named && !asks && WHAT_KIND.test(t)) { named = false; aboutSelf = true; }
  if (named && !asks && ((words(t) >= 7 && PEOPLE_TALK.test(t)) || words(t) >= 12 || PLAYBACK.test(t))) { named = false; aboutSelf = true; }
  // Inside a conversation about something else, "I'd like to see some pictures" means pictures of THAT.
  if (named && wasOut && !FILE_INTENT.test(t)) named = false;
  const media = kinds.some((k) => MEDIA_WEAK.has(k));
  const fileish = FILEISH.test(t);
  let weakMeansFiles = weak && !PLAYBACK.test(t) && ((OWNED.test(t) && (asks || words(t) <= 5))
    || (!media && (MADE.test(t) || FILE_REQUEST.test(t) || asks))
    || (fileish && (q.city != null || q.country != null || q.dateFrom != null || OPENS_OWNED.test(t)
      || ABOUT.test(t) || (words(t) <= 4 && !SENTENCE.test(t)))));
  if (aboutSelf || (wasSocial && !asks)) weakMeansFiles = false;
  if (named || (!aboutSelf && !(wasSocial && !asks) && FILE_WORDS.test(t)) || weakMeansFiles) return decision(Route.FILES, null, q);
  // A follow-up of a file question is short and about the files — not "Me too! I'm sure it will be bright for you."
  if (prev != null && !aboutSelf && (words(t) <= 10 || asks) && (q.followUp || q.isTaskOnly() || (few(q, 2) && q.ignoredWords <= 1 && words(t) <= 7)))
    return decision(Route.FILES, null, q);
  // A search-box query opening the conversation: "Paris", "last winter in Tokyo", "dog".
  if (!wasOut && !wasSocial && prev == null && few(q, 1) && q.ignoredWords === 0 && !weak && words(t) <= 5 && !SENTENCE.test(t)
    && (q.keywords.length === 0 ? q.city != null || q.country != null || q.dateFrom != null : isVisual(q.keywords[0])))
    return decision(Route.FILES, null, q);
  // Not about files. A service request (book, weather, a ride…) is out of scope — and so is the rest of that
  // conversation; anything else is people talking, which gets a friendly reply.
  if ((wasOut && !SELF_TALK.test(t)) || (SERVICE.test(t) && !(wasSocial && YOU.test(t)))
    || (!wasSocial && !SOCIAL_Q.test(t) && ((IMPERATIVE.test(t) && !YOU.test(t)) || (FACT_Q.test(t) && !YOU.test(t) && !SELF_TALK.test(t)))))
    return decision(Route.OUT, outOfScope(ko, wasOut, weak), null);
  return decision(Route.CHAT, socialReply(t, ko, kinds.length > 0), null, true);
}

/** The intent name of a file question, as the dialogue benchmark labels it. */
export function intentOf(q) {
  if (q.delete) return "DeleteFiles";
  if (q.move) return "MoveFiles";
  if (q.share) return "ShareFiles";
  if (q.collect) return "CollectFiles";
  if (q.count) return "CountFiles";
  return "FindFiles";
}

/**
 * @typedef {{ route: string, intent: string, reply: string | null, query: SearchQuery | null, nextContext: object | null, social: boolean }} Turn
 *   intent: Chat | OutOfScope | CallReport | WhoLikesMe | TranscribeCall | FindFiles | CountFiles | CollectFiles | ShareFiles | MoveFiles | DeleteFiles;
 *   nextContext: what the shell keeps for the next turn — {scope: "social"|"out"}, a SearchQuery.toJson(), or the context passed in.
 */

/**
 * The whole of "what did they mean": routing, the parsed query with the previous
 * turn's context applied, the intent, and the context to hand the next turn.
 * @param {import("./query-parser.js").QueryParser} parser
 * @param {string} question
 * @param {number} nowMs
 * @param {object | null} context the previous Turn's nextContext (plain JSON, same keys as the phone's)
 * @returns {Turn}
 */
export function understand(parser, question, nowMs, context) {
  const scope = context == null || context.scope == null ? "" : String(context.scope);
  const wasOut = scope === "out", wasSocial = scope === "social";
  const d = route(parser, question, nowMs, wasOut || wasSocial ? null : SearchQuery.fromJson(context), wasOut, wasSocial);
  const turn = (intent, next) => ({ route: d.route, intent, reply: d.reply, query: d.query, nextContext: next, social: d.social });
  switch (d.route) {
    case Route.CHAT: return turn("Chat", d.social ? { scope: "social" } : context);
    case Route.OUT: return turn("OutOfScope", { scope: "out" });
    case Route.CALLS: return turn(d.query.likes ? "WhoLikesMe" : d.query.transcribe ? "TranscribeCall" : "CallReport", context);
    default: return turn(intentOf(d.query), d.query.toJson());
  }
}
