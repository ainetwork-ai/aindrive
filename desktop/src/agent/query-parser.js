// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/QueryParser.java
/**
 * Rule-based question → {@link SearchQuery}: the stand-in for an LLM planner. It
 * understands file kinds ("screenshots", "PDF", "영상"), places (via the
 * gazetteer), dates (absolute and relative, Korean and English), size ("large
 * files") and leaves the rest as keywords for the file name.
 *
 * Korean particles are stripped from the END of tokens ("파리에서" → "파리")
 * and the longest place name wins, so "New York" beats "York".
 *
 * Dates are computed in the process's local time zone, as the phone uses the
 * device's (Calendar.getInstance(TimeZone.getDefault())).
 */
import { isVisual } from "./content-words.js";
import { SearchQuery } from "./search-query.js";
import { hasHangul, isUpperCaseAt0, javaTrim, jre, jreFull } from "./java-regex.js";

/** Mirrors FileIndex's kind constants. */
export const KIND = Object.freeze({
  PHOTO: "photo", SCREENSHOT: "screenshot", VIDEO: "video", AUDIO: "audio", PDF: "pdf", DOCUMENT: "document",
  SPREADSHEET: "spreadsheet", PRESENTATION: "presentation", ARCHIVE: "archive", OTHER: "other",
});

/**
 * Particles stripped from the end of a token before it is used as a keyword or
 * date word. The subject markers 이/가 are deliberately absent: 고양이/나비/거미 must stay whole.
 */
const KO_PARTICLES = ["에서의", "에서는", "에서", "으로", "로", "까지", "부터", "에는", "에", "의", "은", "는", "을", "를", "과", "와", "도", "랑", "이랑", "하고", "들만", "만"];
/** For PLACE matching only the locative/possessive particles are stripped: 고양이 (cat) is not 고양 (Goyang). */
const KO_PLACE_PARTICLES = ["에서의", "에서는", "에서", "으로", "로", "까지", "부터", "에는", "에", "의", "은", "는", "도", "랑", "이랑", "하고", "과", "와"];
const STOP = new Set([
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
  "back", "past", "around", "during", "since", "before", "after", "between", "recording", "file", "files", "mine", "us", "we", "our", "ours", "discuss", "talk",
]);
const TRIP_WORDS = new Set(["trip", "travel", "travelled", "traveled", "vacation", "holiday", "holidays", "trips"]);
/** Kind words, per category. "사진" alone means photos; "파일" means any kind ("*"). */
const KIND_WORDS = new Map();
const kinds = (kind, ...words) => { for (const w of words) KIND_WORDS.set(w, kind); };
kinds(KIND.PHOTO, "사진", "사진들", "이미지", "포토", "photo", "photos", "picture", "pictures", "pic", "pics", "image", "images", "jpg", "jpeg", "heic", "snaps", "snapshots", "shots");
kinds(KIND.SCREENSHOT, "스크린샷", "스샷", "캡처", "캡쳐", "화면캡처", "screenshot", "screenshots", "screencap", "screencaps", "capture", "captures");
kinds(KIND.VIDEO, "영상", "동영상", "비디오", "영상들", "video", "videos", "movie", "movies", "clip", "clips", "mp4", "mov");
kinds(KIND.AUDIO, "음악", "녹음", "녹음파일", "오디오", "노래", "audio", "music", "song", "songs", "recording", "recordings", "voice", "mp3", "m4a");
kinds(KIND.PDF, "pdf", "pdfs", "pdf들", "피디에프");
kinds(KIND.DOCUMENT, "문서", "문서들", "워드", "한글", "텍스트", "메모", "document", "documents", "doc", "docs", "word", "text", "txt", "hwp", "docx", "notes", "note", "markdown", "md");
kinds(KIND.SPREADSHEET, "엑셀", "스프레드시트", "시트", "excel", "spreadsheet", "spreadsheets", "sheet", "sheets", "xlsx", "xls", "csv");
kinds(KIND.PRESENTATION, "발표자료", "피피티", "프레젠테이션", "슬라이드", "ppt", "pptx", "presentation", "presentations", "slides", "slide", "deck", "keynote", "powerpoint", "powerpoints", "decks");
kinds(KIND.ARCHIVE, "압축", "압축파일", "zip", "archive", "archives", "rar");
kinds("*", "파일", "파일들", "file", "files", "자료", "것들");

/** Words the date pass owns. Never tried as places (지난 = Jinan, spring = Spring TX). */
const DATE_WORDS = new Set([
  "작년", "올해", "재작년", "지난", "지난달", "이번달", "이번", "지난주", "이번주", "오늘", "어제", "그제", "그저께", "최근", "최근에", "요즘", "봄", "여름", "가을", "겨울",
  "last", "this", "next", "year", "month", "week", "today", "yesterday", "recent", "recently", "latest", "newest",
  "spring", "summer", "autumn", "fall", "winter",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);
/** English city names that are also everyday words: only a capitalised token means the city. */
const NEEDS_CAPITAL = new Set(["nice", "spring", "reading", "bath", "orange", "mobile", "buffalo", "phoenix", "jordan", "victoria", "of", "most", "split", "bar", "male", "media"]);
/** Words that describe a recording rather than what was said in it ("meeting recording about X"). */
export const RECORDING_WORDS = new Set([
  "meeting", "meetings", "회의", "미팅", "interview", "인터뷰", "call", "통화", "conversation", "대화", "talk", "강의", "lecture", "voice", "memo", "메모"]);

/** The keywords minus recording words: what the transcript / photo must be about. */
export function contentWords(keywords) {
  return keywords.filter((k) => !RECORDING_WORDS.has(k.toLowerCase()));
}

/** Verbs that turn a question into a task. Matched as prefixes of a Korean token ("모아서", "만들어줘"). */
const COLLECT_WORDS = ["모아", "모아서", "모아줘", "모으", "묶어", "정리", "폴더", "앨범", "collect", "gather", "folder", "album", "organize", "organise", "copy", "복사", "save", "group", "bundle", "throw"];
const MOVE_WORDS = ["옮겨", "옮기", "이동", "move"];
/** Collect words that are nouns: a destination ("into a folder") — or the folder being asked about ("what's in this folder"). */
const PLACE_NOUNS = ["폴더", "앨범", "folder", "album"];
/** Right before a place noun, these point at the folder that is already there: "this folder", "이 폴더", "현재 폴더". */
const POINTING = new Set(["this", "that", "the", "my", "our", "current", "these", "those", "이", "그", "저", "현재", "지금", "여기", "이번"]);
const SHARE_WORDS = ["공유", "링크", "share", "link"];
const DELETE_WORDS = ["삭제", "지워", "지우", "없애", "delete", "remove", "trash", "rid", "wipe", "erase"];
const COUNT_WORDS = ["몇", "개수", "갯수", "count", "number", "how many"];
const OLDEST_WORDS = ["오래된", "옛날", "가장오래된", "oldest", "earliest"];
const TASK_FILLER = ["만들어", "만들고", "만들어서", "만들어줘", "만든", "새", "넣어", "넣고", "해줘", "해서", "하고", "줘", "그리고", "다음", "개야", "개나", "개", "있어", "있니", "있나", "있는지", "알려줘", "알려", "골라", "골라줘", "뽑아", "뽑아줘", "보여줘",
  "then", "and", "make", "create", "put", "into", "new", "them", "it", "me", "there", "are", "is", "do", "i", "have", "tell", "pick", "top", "only", "did", "take", "took", "taken", "just", "to", "get", "of", "my", "ate", "eat", "eaten", "had"];
const KO_COUNT = jreFull("(\\d{1,3})(개|장|건|개만|장만|건만)");
const EN_COUNT = jreFull("(\\d{1,3})");
/** Bare counters left behind by "몇 장", "몇 개". */
const COUNT_UNITS = new Set(["장", "개", "건", "번", "곡", "편"]);
const RECENT_N_WORDS = new Set(["가장", "제일", "최근", "최신", "가장최근", "latest", "most", "recent", "newest", "biggest", "largest"]);
const SIZE_WORDS = new Set(["큰", "대용량", "용량큰", "무거운", "large", "big", "huge", "biggest", "largest"]);
const YEAR = jreFull("(19|20)\\d{2}");
const YEAR_MONTH = jreFull("((?:19|20)\\d{2})[-./]?(0?[1-9]|1[0-2])");
const KO_YEAR = jreFull("((?:19|20)\\d{2})년");
const KO_MONTH = jreFull("(0?[1-9]|1[0-2])월");
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "large" = at least this many bytes. */
export const LARGE_BYTES = 1024 * 1024;
/** "recent" = the last N days. */
export const RECENT_DAYS = 30;

/** "통화 내역 / call history / who I call most": a report over the call log, not a file search. */
const CALLS_TASK = jre(
  "통화\\s*(내역|기록|녹음|목록|요약|많이)|통화한|통화했|(call|phone)\\s*(history|logs?|records?|recordings?)|\\b(show|list|check|summari[sz]e|rank|sort|analy[sz]e|report (on|of)|review|give me)\\b.{0,24}\\b(my )?(phone |missed |recent )?calls\\b|\\bwho (called|calls) me\\b|who\\s+(do\\s+|did\\s+)?i\\s+(call|talk|phone|speak)"
  + "|\\b(talk|talked|speak|spoke|chat)\\s+(to|with)?\\s*(\\w+\\s+)?(the most|most)\\s+on the phone|\\bwho\\b.*\\bon the phone\\b.*\\bmost|\\b(rank|sort)\\s+my\\s+contacts\\b|\\bpeople i (call|phone|talk to)\\b|who (have|had) i been (calling|phoning|talking to)|\\bcalling the most\\b", { ci: true });
const SHARE_ASK = jre("공유|링크|\\bshare|\\blink", { ci: true });

/** "who likes me the most?", "누가 나를 제일 좋아해?": an affection ranking over calls. */
const LIKES_TASK = jre(
  "(^|[.!?]\\s*|\\b(tell me|show me|find out|guess|know)\\s+)who\\s+(likes|loves|cares\\s+about|misses|adores)\\s+me|who('s| is)\\s+(closest|fond)|"
  + "(나를|날|저를|절)\\s*(제일|가장|젤)?\\s*(좋아|사랑|아끼|챙기|그리워)|나\\s*(좋아하는|사랑하는)\\s*사람|누가\\s*(나|날)\\s*(제일|가장)?\\s*(좋아|사랑)", { ci: true });

export const isLikesTask = (question) => question != null && LIKES_TASK.test(question);

/** "엄유준 최신 통화 stt 해줘", "transcribe my last call with Amy": one recording as text. */
const CALL_WORD = jre("통화|전화|녹음|\\bcalls?\\b|\\brecordings?\\b|\\bphone\\b", { ci: true });
const TRANSCRIBE_WORD = jre(
  "(?<![a-z])stt(?![a-z])|받아\\s*(써|쓰|적)|전사|녹취|텍스트로|글로\\s*(써|옮겨|바꿔|적어|변환)|문자로\\s*(바꿔|변환)|스크립트"
  + "|\\btranscri(be|bed|ption|pt)|speech[- ]to[- ]text", { ci: true });
const RANKING = jre("많이|순으로|순서|\\b(rank|sort|most|who)\\b", { ci: true });

export const isTranscribeTask = (question) =>
  question != null && CALL_WORD.test(question) && TRANSCRIBE_WORD.test(question) && !RANKING.test(question);

export const isCallsTask = (question) =>
  question != null && (CALLS_TASK.test(question) || isLikesTask(question) || isTranscribeTask(question));

/** Follow-up cues: the question refers to the previous turn's results ("and share them", "그중 파리 사진만"). */
const FOLLOWUP = jre(
  "\\b(those|them|these|the ones|of those|of them|among them|the same|that one|this one|the rest|also|too|instead|same but|narrow|now|switch to|change (it )?to|limit it)\\b|^(and|now|then|only|just|but|what about|how about|what if|switch|limit)\\b"
  + "|그중|그 중|그것|그거|그걸|이것들|그것들|얘네|걔네|나머지|거기서|거기에서|그리고|또|만$|중에서|중에", { ci: true });

export const isFollowUp = (question) => question != null && FOLLOWUP.test(javaTrim(question));

/** Multi-word kinds rewritten before tokenising: "screen captures" → "screenshots", "voice memos" → "recordings". */
const PHRASES = [
  ["screen ?captures?|screen ?grabs?|screen ?caps?", "screenshots"],
  ["voice ?memos?|voice recordings?|audio (files?|recordings?)|sound recordings?", "recordings"],
  ["video ?clips?|movies i (shot|took|made|filmed|recorded)|films i (shot|took)|home videos", "videos"],
  ["pdf files?|pdf documents?", "pdfs"],
  ["word (files?|documents?|docs)|text files?", "documents"],
  ["excel (files?|sheets?|spreadsheets?)|google sheets", "spreadsheets"],
  ["slide ?decks?|powerpoint (files?|decks?|presentations?)|keynote files?", "presentations"],
  ["zip (files?|archives?)|compressed files?", "archives"],
  ["(camera )?photographs?", "photos"],
  ["video ?games?|videogames?", "videogames"],
  ["(?<=\\b(the|my|any|all|some) )audio(?! (quality|system|book|books))", "recordings"],
].map(([p, to]) => [jre("\\b(" + p + ")\\b", { ci: true, global: true }), to]);
/** "move... no, collect X" → "collect X". */
const SELF_CORRECTION = jre("^.*?(\\.\\.\\.|…|—| - )\\s*(no|sorry|i mean|actually|wait)[,.!]?\\s+", { ci: true });
const THE_US = jre("\\b(the )?(US|U\\.S\\.?|U\\.S\\.A\\.?|States)\\b", { global: true });
const CALL_ABOUT = jre("\\b(the |a |that )?(phone )?call (where|when|in which|about)\\b", { ci: true, global: true });

/** Self-corrections, "the US" and multi-word kinds rewritten into the words the parser knows. */
export function normalise(question) {
  let s = question.replace(SELF_CORRECTION, "");
  s = s.replace(THE_US, "USA");
  // "the call where we discussed pricing" is a recording to find, not the call-log report.
  s = s.replace(CALL_ABOUT, "the recording $3");
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s;
}

const NUM = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few)";
const AGO = jre("\\b" + NUM + "\\s+(day|days|week|weeks|month|months|year|years)\\s+ago\\b", { ci: true });
const PAST_N = jre("\\b(?:in |from |over |during )?(?:the )?(?:past|last)\\s+(?:" + NUM + "\\s+)?(days?|weeks?|months?)\\b", { ci: true });
const WEEKEND = jre("\\b(last|this|past)\\s+weekend\\b|\\bover the weekend\\b", { ci: true });
const EARLIER_THIS_YEAR = jre("\\b(earlier|so far) this year\\b|\\b(from|since) the (start|beginning) of (the|this) year\\b", { ci: true });

function number(w) {
  switch (w.toLowerCase()) {
    case "a": case "an": case "one": return 1;
    case "two": case "a couple of": return 2;
    case "three": case "a few": return 3;
    case "four": return 4; case "five": return 5; case "six": return 6; case "seven": return 7;
    case "eight": return 8; case "nine": return 9; case "ten": return 10;
    default: return parseInt(w, 10);
  }
}

// ------------------------------------------------------------ calendar (local time, like java.util.Calendar)

/** Local midnight of y-m-d (m 1-based; d may overflow, like Calendar's lenient add). */
function localMidnight(y, m, d) {
  const c = new Date(2000, 0, 1);
  c.setFullYear(y, m - 1, d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}
const startOfMonth = (y, m) => localMidnight(y, m, 1);
/** The year and 1-based month `n` months from `now` (Calendar.add(MONTH, n) — the day is irrelevant here). */
function addMonths(now, n) {
  const t = now.getFullYear() * 12 + now.getMonth() + n;
  return { y: Math.floor(t / 12), m: (((t % 12) + 12) % 12) + 1 };
}
/** [start of today+fromDays, start of today+toDays). */
const days = (now, fromDays, toDays) => [
  localMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate() + fromDays),
  localMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate() + toDays),
];
/** Monday-based week; offset 0 = this week, -1 = last week. */
function week(now, offsetWeeks) {
  const dow = (now.getDay() + 6) % 7;   // Mon=0 … Sun=6
  const d = now.getDate() - dow + 7 * offsetWeeks;
  return [localMidnight(now.getFullYear(), now.getMonth() + 1, d), localMidnight(now.getFullYear(), now.getMonth() + 1, d + 7)];
}

/**
 * Relative-date phrases the token loop can't see ("3 days ago", "the past week"):
 * [from, to), with the phrase removed from `text.s`.
 */
function phraseWindow(text, now) {
  let m, w = null;
  if ((m = AGO.exec(text.s))) {
    const n = number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith("day")) w = days(now, -n, -n + 1);
    else if (unit.startsWith("week")) w = week(now, -n);
    else if (unit.startsWith("month")) {
      const c = addMonths(now, -n);
      w = [startOfMonth(c.y, c.m), c.m === 12 ? startOfMonth(c.y + 1, 1) : startOfMonth(c.y, c.m + 1)];
    } else { const y = now.getFullYear() - n; w = [startOfMonth(y, 1), startOfMonth(y + 1, 1)]; }
  } else if ((m = PAST_N.exec(text.s))) {
    const n = m[1] == null ? 1 : number(m[1]);
    const unit = m[2].toLowerCase();
    const d = unit.startsWith("day") ? n : unit.startsWith("week") ? 7 * n : 30 * n;
    // "the past week" = the last 7 days up to today; but "last week" alone is the calendar week (token loop).
    const all = m[0].toLowerCase();
    if (m[1] == null && !all.includes("past") && !all.includes("the")) return null;
    w = days(now, -d, 1);
  } else if ((m = WEEKEND.exec(text.s))) {
    const thisWeek = week(now, 0);
    const past = !m[0].toLowerCase().startsWith("this") || now.getDay() === 1;
    const mon = past ? thisWeek[0] : thisWeek[1];
    w = [mon - 2 * 86400000, mon];
  } else if ((m = EARLIER_THIS_YEAR.exec(text.s))) {
    const y = now.getFullYear();
    w = [startOfMonth(y, 1), startOfMonth(y + 1, 1)];
  }
  if (w != null) text.s = text.s.slice(0, m.index) + " " + text.s.slice(m.index + m[0].length);
  return w;
}

// ------------------------------------------------------------ tokens

const POSSESSIVE = jre("'s\\b", { ci: true, global: true });
const TOKEN_SPLIT = jre("[\\s,;!?~()\\[\\]\"']+");

function tokenize(s) {
  const out = [];
  s = s.replace(POSSESSIVE, "");   // "this year's" → "this year"
  for (let t of javaTrim(s).split(TOKEN_SPLIT)) {
    t = t.replace(/^[.]+|[.]+$/g, "");
    if (t !== "") out.push(t);
  }
  return out;
}

export function stripParticles(tok) {
  for (const p of KO_PARTICLES) if (tok.length > p.length + 1 && tok.endsWith(p)) return tok.slice(0, tok.length - p.length);
  return tok;
}

export function stripPlaceParticles(tok) {
  for (const p of KO_PLACE_PARTICLES) if (tok.length > p.length + 1 && tok.endsWith(p)) return tok.slice(0, tok.length - p.length);
  return tok;
}

/** Korean verbs inflect at the END ("모아", "모아서"), so a prefix match is right; English words must match whole. */
function startsWithAny(t, prefixes) {
  const hangul = hasHangul(t);
  for (const p of prefixes) if (hangul && hasHangul(p) ? t.startsWith(p) : t === p) return true;
  return false;
}

/** A span is off-limits as a place when it holds a date/kind/size word or an uncapitalised ambiguous name. */
function reservedSpan(tokens, from, n) {
  for (let i = from; i < from + n; i++) {
    const raw = tokens[i];
    const t = stripParticles(raw).toLowerCase();
    if (DATE_WORDS.has(t) || KIND_WORDS.has(t) || SIZE_WORDS.has(t)) return true;
    if (n === 1 && NEEDS_CAPITAL.has(t) && !isUpperCaseAt0(raw)) return true;
    // "sunrise snaps" is not Sunrise, Florida: a lowercase word for something a photo shows is that thing.
    if (n === 1 && !isUpperCaseAt0(raw) && isVisual(t)) return true;
  }
  return false;
}

const GLUED_KINDS = ["사진", "영상", "동영상", "문서", "녹음", "스크린샷"];

/** The file-kind words a question uses ("photos", "사진을" → "사진", "음식사진" → "사진"), lowercased. */
export function kindWords(question) {
  const out = [];
  for (const raw of tokenize(normalise(question))) {
    const lower = raw.toLowerCase(), stripped = stripParticles(raw).toLowerCase();
    if (KIND_WORDS.has(stripped)) { out.push(stripped); continue; }
    if (KIND_WORDS.has(lower)) { out.push(lower); continue; }
    for (const kw of GLUED_KINDS) if (stripped.length > kw.length && stripped.endsWith(kw)) { out.push(kw); break; }
  }
  return out;
}

const DETERMINERS = new Set(["a", "an", "the", "my", "our", "his", "her", "their", "some", "any", "s", "this", "that", "those", "these"]);
const MARKERS = new Set([
  "about", "of", "with", "mentions", "mentioning", "mentioned", "regarding", "re", "for", "on", "featuring", "showing", "show", "shows",
  "there", "called", "named", "titled", "discussed", "discussing", "discuss", "talked", "talking", "talk", "said", "says", "containing", "contains", "include", "includes", "including"]);

/** "invoice sheets": the word right before a kind word names what the files are. */
const beforeKind = (tokens, kindTok, i) => i + 1 < tokens.length && kindTok[i + 1];

/** "about the budget", "of a horse", "with my receipt", "where there's a boat". */
function afterMarker(tokens, i) {
  for (let j = i - 1; j >= 0; j--) {
    const w = tokens[j].toLowerCase();
    if (DETERMINERS.has(w)) continue;
    return MARKERS.has(w);
  }
  return false;
}

const hasCount = (tokens) => tokens.some((t) => EN_COUNT.test(t) || KO_COUNT.test(t));
const anyUsed = (used, from, n) => used.slice(from, from + n).some(Boolean);
const next = (tokens, i) => (i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : "");

/** "this folder", "이 폴더에", "the album": the folder already there, which a question is about — not "make a folder". */
function pointedAt(tokens, i) {
  if (i === 0) return false;
  const t = stripParticles(tokens[i]).toLowerCase();
  return PLACE_NOUNS.some((n) => t === n || t === n + "s") && POINTING.has(tokens[i - 1].toLowerCase());
}

function isSeason(t) {
  switch (t) {
    case "봄": case "spring": return "spring";
    case "여름": case "summer": return "summer";
    case "가을": case "autumn": case "fall": return "autumn";
    case "겨울": case "winter": return "winter";
    default: return null;
  }
}

/** Full month name or the usual 3-letter abbreviation; 0 when neither. */
function monthIndex(t) {
  for (let i = 0; i < EN_MONTHS.length; i++) if (t === EN_MONTHS[i] || t === EN_MONTHS[i].slice(0, 3)) return i + 1;
  return 0;
}

function applyDate(q, y, m, season) {
  let fromMonth = 1, toMonth = 12, toYear = y;   // inclusive month range
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
  q.dateTo = toMonth === 12 ? startOfMonth(toYear + 1, 1) : startOfMonth(toYear, toMonth + 1);
}

/** Question → SearchQuery, against a gazetteer (GeoLookup). */
export class QueryParser {
  /** @param {import("./geo-lookup.js").GeoLookup} geo */
  constructor(geo) {
    this.geo = geo;
  }

  /**
   * `prev` is the previous turn's filters (SearchQuery.fromJson of the context the
   * shell keeps). A question that only says what to DO — or that points back at
   * "those" — is applied to them: missing filters are inherited, given ones
   * override, keywords accumulate.
   * @param {string} question
   * @param {number} nowMs
   * @param {SearchQuery | null} [prev]
   * @returns {SearchQuery}
   */
  parse(question, nowMs, prev = null) {
    const q = this.parseOne(question, nowMs);
    if (prev == null || q.calls) return q;
    const refers = isFollowUp(question);
    // "just Seattle", "2023 instead": only a place or a date — a refinement of the last question.
    const refines = q.kind == null && contentWords(q.keywords).length === 0 && (q.city != null || q.country != null || q.dateFrom != null);
    if (!q.isTaskOnly() && !refers && !refines) return q;
    if (q.kind == null) q.kind = prev.kind;
    if (q.city == null && q.country == null) { q.city = prev.city; q.country = prev.country; }
    if (q.dateFrom == null && q.dateTo == null) { q.dateFrom = prev.dateFrom; q.dateTo = prev.dateTo; }
    if (q.minSize == null) q.minSize = prev.minSize;
    if (q.limit === 0) q.limit = prev.limit;
    q.oldestFirst ||= prev.oldestFirst;
    q.bySize ||= prev.bySize;
    for (const k of prev.keywords) if (!q.keywords.includes(k)) q.keywords.unshift(k);
    q.followUp = true;
    return q;
  }

  /** @private */
  parseOne(question, nowMs) {
    question = normalise(question);
    const q = new SearchQuery();
    q.korean = hasHangul(question);
    if (isCallsTask(question)) {
      q.calls = true;
      q.likes = isLikesTask(question);
      q.transcribe = !q.likes && isTranscribeTask(question);
      if (q.transcribe) q.asked = question;
      q.share = SHARE_ASK.test(question);
      return q;
    }
    const now = new Date(nowMs);
    const year = now.getFullYear();
    const text = { s: question };
    let window = phraseWindow(text, now);   // explicit [from, to) from day/week/recent words
    const tokens = tokenize(text.s);

    let y = null, m = null;   // absolute year / month
    let season = null;
    const used = new Array(tokens.length).fill(false);
    const kindTok = new Array(tokens.length).fill(false);

    // 1. Places: try 3-, 2-, then 1-token spans so multi-word names win.
    for (let span = 3; span >= 1; span--) {
      for (let i = 0; i + span <= tokens.length; i++) {
        if (anyUsed(used, i, span)) continue;
        if (reservedSpan(tokens, i, span)) continue;
        const p = this.placeOf(tokens.slice(i, i + span).join(" "));
        if (p == null) continue;
        if (p.city != null && q.city == null) { q.city = p.city; q.country = p.country; }
        else if (p.city == null && q.country == null) q.country = p.country;
        // A second place ("파리랑 런던") has no slot yet; swallow it rather than let it leak into the keywords.
        used.fill(true, i, i + span);
      }
    }

    // 2. Kind, size, dates.
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) continue;
      let t = stripParticles(tokens[i]);
      let lower = t.toLowerCase();
      let kind = KIND_WORDS.get(lower) ?? null;
      if (kind == null) kind = KIND_WORDS.get(tokens[i].toLowerCase()) ?? null;
      if (kind != null) {
        // "PDF 파일": the specific word wins over the generic one.
        if (q.kind == null || q.kind === "*") q.kind = kind;
        used[i] = true; kindTok[i] = true; continue;
      }
      // "음식사진", "회의영상": a content word glued to a kind word.
      for (const kw of GLUED_KINDS) {
        if (lower.length > kw.length + 1 && lower.endsWith(kw)) {
          const k2 = KIND_WORDS.get(kw);
          if (q.kind == null || q.kind === "*") q.kind = k2;
          tokens[i] = t.slice(0, t.length - kw.length);   // leave the content part for step 4
          kind = "";
          break;
        }
      }
      if (kind != null) { t = tokens[i]; lower = t.toLowerCase(); }
      if (SIZE_WORDS.has(lower)) { q.minSize = LARGE_BYTES; q.bySize = true; used[i] = true; continue; }
      let mm;
      if ((mm = YEAR_MONTH.exec(t))) { y = parseInt(mm[1], 10); m = parseInt(mm[2], 10); used[i] = true; }
      else if (YEAR.test(t)) { y = parseInt(t, 10); used[i] = true; }
      else if ((mm = KO_YEAR.exec(t))) { y = parseInt(mm[1], 10); used[i] = true; }
      else if ((mm = KO_MONTH.exec(t))) { m = parseInt(mm[1], 10); used[i] = true; }
      else if (lower === "작년" || (lower === "last" && next(tokens, i) === "year")) { y = year - 1; used[i] = true; if (lower === "last") used[i + 1] = true; }
      else if (lower === "재작년") { y = year - 2; used[i] = true; }
      else if (lower === "올해" || (lower === "this" && next(tokens, i) === "year")) { y = year; used[i] = true; if (lower === "this") used[i + 1] = true; }
      else if (lower === "지난달" || (lower === "last" && next(tokens, i) === "month")) {
        const c = addMonths(now, -1);
        y = c.y; m = c.m; used[i] = true; if (lower === "last") used[i + 1] = true;
      }
      else if (lower === "이번달" || (lower === "this" && next(tokens, i) === "month")) { y = year; m = now.getMonth() + 1; used[i] = true; if (lower === "this") used[i + 1] = true; }
      else if (lower === "오늘" || lower === "today") { window = days(now, 0, 1); used[i] = true; }
      else if (lower === "어제" || lower === "yesterday") { window = days(now, -1, 0); used[i] = true; }
      else if (lower === "그제" || lower === "그저께") { window = days(now, -2, -1); used[i] = true; }
      else if (lower === "이번주" || (lower === "this" && next(tokens, i) === "week")) { window = week(now, 0); used[i] = true; if (lower === "this") used[i + 1] = true; }
      else if (lower === "지난주" || (lower === "last" && next(tokens, i) === "week")) { window = week(now, -1); used[i] = true; if (lower === "last") used[i + 1] = true; }
      else if (["최근", "최근에", "요즘", "recent", "recently", "latest", "newest"].includes(lower)) {
        // "the latest 10 PDFs" is a count in date order, not "from the last 30 days".
        if (!hasCount(tokens)) window = days(now, -RECENT_DAYS, 1);
        used[i] = true;
      }
      else if (isSeason(lower) != null) {
        season = isSeason(lower); used[i] = true;
        // "last summer" / "지난 여름" = that season of the previous year.
        if (i > 0 && !used[i - 1]) {
          const prev = tokens[i - 1].toLowerCase();
          if (prev === "last" || prev === "지난") { y = year - 1; used[i - 1] = true; }
        }
      }
      else {
        const mi = monthIndex(lower);
        if (mi > 0) {
          m = mi; used[i] = true;
          // "last April" = the most recent April that's over: this year's if it has passed, else last year's.
          if (i > 0 && !used[i - 1] && tokens[i - 1].toLowerCase() === "last") {
            used[i - 1] = true;
            y = mi < now.getMonth() + 1 ? year : year - 1;
          }
        }
      }
    }
    if (q.kind === "*") q.kind = null;
    if (window != null) { q.dateFrom = window[0]; q.dateTo = window[1]; }
    else {
      if (season != null && y == null) y = year;   // "여름" alone = this year's summer
      // "5월" alone = this year's May — unless May is still ahead: "photos from December" in September means last December.
      if (m != null && y == null) y = m > now.getMonth() + 1 ? year - 1 : year;
      if (y != null) applyDate(q, y, m, season);
    }

    // 3. Task words: "모아서 폴더로 만들어서 공유해줘" is an instruction, not content.
    //    Counts ("3개", "5 largest") cap the list; "몇 개" asks for the number only.
    //    First pass: is this a task at all? (so fillers before the verb — "put … in a folder" — count too)
    let task = false;
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) continue;
      const lower = stripParticles(tokens[i]).toLowerCase(), raw = tokens[i].toLowerCase();
      if (pointedAt(tokens, i)) continue;
      for (const set of [MOVE_WORDS, DELETE_WORDS, COLLECT_WORDS, SHARE_WORDS, COUNT_WORDS]) if (startsWithAny(raw, set) || startsWithAny(lower, set)) task = true;
      if (KO_COUNT.test(raw) || EN_COUNT.test(raw) || (raw === "how" && next(tokens, i) === "many")) task = true;
    }
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) continue;
      const lower = stripParticles(tokens[i]).toLowerCase();
      const raw = tokens[i].toLowerCase();
      let cm;
      if (pointedAt(tokens, i)) { used[i] = true; used[i - 1] = true; continue; }   // "this folder": where to look, not a task
      if (startsWithAny(raw, MOVE_WORDS) || startsWithAny(lower, MOVE_WORDS)) { q.move = true; used[i] = true; }
      else if (startsWithAny(raw, DELETE_WORDS) || startsWithAny(lower, DELETE_WORDS)) { q.delete = true; used[i] = true; }
      else if (startsWithAny(raw, COLLECT_WORDS) || startsWithAny(lower, COLLECT_WORDS)) { q.collect = true; used[i] = true; }
      else if (startsWithAny(raw, SHARE_WORDS) || startsWithAny(lower, SHARE_WORDS)) { q.share = true; q.collect = true; used[i] = true; }
      else if (startsWithAny(raw, COUNT_WORDS) || startsWithAny(lower, COUNT_WORDS) || (raw === "how" && next(tokens, i) === "many")) { q.count = true; used[i] = true; if (raw === "how") used[i + 1] = true; }
      else if (startsWithAny(raw, OLDEST_WORDS) || startsWithAny(lower, OLDEST_WORDS)) { q.oldestFirst = true; used[i] = true; }
      else if ((cm = KO_COUNT.exec(raw) ?? EN_COUNT.exec(raw))) { q.limit = parseInt(cm[1], 10); used[i] = true; }
      else if (RECENT_N_WORDS.has(lower) || COUNT_UNITS.has(raw)) { used[i] = true; }
      else if (startsWithAny(raw, TASK_FILLER) || startsWithAny(lower, TASK_FILLER)) { if (task || i > 0) used[i] = true; }
    }
    if (q.move) q.collect = true;   // a move is a collect that also removes the originals
    if (q.bySize && q.limit > 0) q.minSize = null;   // "biggest 5" is a ranking, not a floor

    // 4. Whatever is left is a keyword for the file name (and CLIP).
    //    "Japan vacation pictures": the trip is the occasion, not what the photo shows.
    const media = q.kind == null || q.kind === KIND.PHOTO || q.kind === KIND.VIDEO || q.kind === KIND.SCREENSHOT;
    // English: a word is WHAT the file is about only where grammar says so — a thing a photo can show,
    // a modifier right before the kind ("invoice sheets"), or after a topic marker ("about the budget").
    const bare = q.kind == null && q.city == null && q.country == null && q.dateFrom == null && window == null && y == null && m == null
      && !q.collect && !q.share && !q.delete && !q.count && q.limit === 0;
    const grammar = !q.korean && !bare;
    let prevKept = false;
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) { prevKept = false; continue; }
      const t = stripParticles(tokens[i]);
      const lower = t.toLowerCase();
      if (t === "" || STOP.has(lower) || STOP.has(tokens[i].toLowerCase())) { prevKept = prevKept && DETERMINERS.has(lower); continue; }
      if (media && TRIP_WORDS.has(lower)) { prevKept = false; continue; }
      if (grammar && !(isVisual(lower) || beforeKind(tokens, kindTok, i) || afterMarker(tokens, i) || prevKept)) { prevKept = false; q.ignoredWords++; continue; }
      q.keywords.push(t);
      prevKept = true;
    }
    return q;
  }

  /**
   * The date window a fragment of time words means ("last spring", "지난 여름", "3 days ago", "2024년 5월"),
   * resolved against `nowMs` by the same rules `parse` applies — for a model that hands the words back
   * to code (llm.js). Places are not looked up, so "spring" is never Spring, TX. Null when no date.
   * @param {string} fragment
   * @param {number} nowMs
   * @returns {{ dateFrom: number, dateTo: number } | null}
   */
  static dateWindow(fragment, nowMs) {
    if (fragment == null || javaTrim(String(fragment)) === "") return null;
    const q = NO_PLACES.parseOne(String(fragment), nowMs);
    return q.dateFrom == null ? null : { dateFrom: q.dateFrom, dateTo: q.dateTo };
  }

  /** @private */
  placeOf(raw) {
    const p = this.geo.byPlaceName(raw);
    if (p != null) return p;
    const stripped = stripPlaceParticles(raw);
    return stripped === raw ? null : this.geo.byPlaceName(stripped);
  }
}

/** A parser without a gazetteer: only dates and kinds are recognised. */
const NO_PLACES = new QueryParser({ byPlaceName: () => null });

/** The message asks to collect ("모아서", "into a folder", "gather"): a model may claim `collect` only then. */
export function asksToCollect(question) {
  return tokenize(normalise(String(question ?? ""))).some((raw, i, tokens) => {
    const lower = stripParticles(raw).toLowerCase();
    return !pointedAt(tokens, i) && (startsWithAny(raw.toLowerCase(), COLLECT_WORDS) || startsWithAny(lower, COLLECT_WORDS));
  });
}

/** Follow-up cues a model tends to copy into `content` ("switch to Turkey", "narrow it down", "limit it"). */
const FOLLOWUP_WORDS = new Set(["switch", "change", "narrow", "limit", "rest", "same", "ones", "refine", "restrict", "widen", "keep"]);

/**
 * The words of a model's `content` as the parser would keep them: stop words, kind words and date words
 * dropped, the rest kept as written. Never a verb like "show" (STOP) — the prompt forbids them, this enforces it.
 * @param {string[]} phrases
 * @returns {string[]}
 */
export function contentKeywords(phrases) {
  const out = [];
  for (const phrase of phrases ?? []) {
    for (const raw of tokenize(String(phrase ?? ""))) {
      const t = stripParticles(raw), lower = t.toLowerCase();
      if (t === "" || STOP.has(lower) || STOP.has(raw.toLowerCase()) || KIND_WORDS.has(lower) || DATE_WORDS.has(lower) || TRIP_WORDS.has(lower)) continue;
      if (startsWithAny(lower, TASK_FILLER) || RECENT_N_WORDS.has(lower) || SIZE_WORDS.has(lower)) continue;
      if ([MOVE_WORDS, DELETE_WORDS, COLLECT_WORDS, SHARE_WORDS, COUNT_WORDS, OLDEST_WORDS].some((set) => startsWithAny(lower, set))) continue;
      if (FOLLOWUP_WORDS.has(lower) || RECORDING_WORDS.has(lower) || KO_PARTICLES.includes(lower)) continue;
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}
