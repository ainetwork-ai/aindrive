// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/AskRunner.java — the file questions and
// tasks. Not on the Mac yet: call reports, speech transcripts, CLIP photo contents, the on-device LLM.
import { AUDIO, ARCHIVE, DOCUMENT, PDF, PHOTO, PRESENTATION, SCREENSHOT, SPREADSHEET, VIDEO } from "./file-index.js";

export const LIMIT = 50;

const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const ym = (ms) => ymd(ms).slice(0, 7);

/**
 * One folder's agent: understand the turn (router.js, the phone's Router), then search this
 * folder's index and phrase the answer the way the phone does.
 *
 * @param {{ index: import("./file-index.js").FileIndex, geo: any, parser: any, router: { understand: Function },
 *   contentWords: (keywords: string[]) => string[], ops?: { copy(from: string, to: string): Promise<void>, move(from: string, to: string): Promise<void> } | null,
 *   now?: () => number }} deps
 */
export function createAskRunner({ index, geo, parser, router, contentWords, ops = null, now = () => Date.now() }) {
  const cityName = (city, ko) => (ko && geo?.cityKo?.(city)) || city;
  const countryName = (c, ko) => geo?.countryName?.(c, ko) ?? c;

  /** The reply for small talk / out of scope, or null for a file question (cheap: no index access). */
  function replyOf(t) {
    if (t.route !== "CHAT" && t.route !== "OUT") return null;
    return { answer: t.reply, sources: [], query: t.route === "CHAT" ? "chat" : "out", context: t.nextContext ?? null };
  }

  /** @param {import("./router.js").Turn} [turn] the turn already understood (device-agent.js, once per question, maybe by the model) */
  function route(question, context, turn) {
    return replyOf(turn ?? router.understand(parser, question, now(), context ?? null));
  }

  async function ask(question, context, turn) {
    if (!question?.trim()) throw new Error("empty_query");
    turn ??= router.understand(parser, question, now(), context ?? null);
    const routed = replyOf(turn);
    if (routed) return routed;
    const q = turn.query;
    if (q.calls) return { answer: "Call reports come from the phone app — the Mac has no call log.", sources: [], query: "out", context: context ?? null };
    const out = { query: String(q), context: q.toJson(), followUp: q.followUp ?? null };
    if (index.count() === 0) return { ...out, answer: q.korean ? "아직 인덱스가 비어 있어요. 잠시 후 다시 물어봐 주세요." : "This folder isn't indexed yet — ask again in a moment.", sources: [] };

    const relaxed = [];
    let hits = search(q);
    const onlyWords = q.kind == null && q.country == null && q.city == null && q.dateFrom == null && q.dateTo == null
      && q.minSize == null && !q.collect && !q.delete && !q.count && !q.limit && !q.bySize && !q.oldestFirst;
    if (!hits.size && q.keywords.length && onlyWords) {
      const w = q.keywords.join(" ");
      return { ...out, sources: [], answer: q.korean
        ? `“${w}”와 관련된 파일을 찾지 못했어요. 장소·날짜(예: 도쿄에서 찍은 사진), 파일 종류(예: 지난주 스크린샷), 파일 이름으로 물어보세요.`
        : `Nothing here matches “${w}”. Try a place or date ("photos from Tokyo"), a kind of file ("last week's screenshots"), or a word from the file name.` };
    }
    if (!hits.size && q.kind != null && !q.keywords.length && (q.city != null || q.country != null || q.dateFrom != null)) {
      const kind = q.kind; q.kind = null; relaxed.push("kind"); hits = search(q);
      if (!hits.size) { q.kind = kind; relaxed.pop(); }
    }

    let ranked = [...hits.values()];
    const when = (h) => h.row.whenMs ?? 0;
    ranked.sort((a, b) => q.bySize ? b.row.size - a.row.size
      : a.tier !== b.tier ? a.tier - b.tier
      : q.oldestFirst ? when(a) - when(b) : when(b) - when(a));
    const total = ranked.length;
    const cap = q.limit > 0 ? Math.min(q.limit, LIMIT) : LIMIT;
    ranked = ranked.slice(0, cap);

    const sources = ranked.map((h) => ({ path: h.row.path, snippet: snippet(h), matchedBy: h.how }));
    let answer = answerFor(q, ranked, total, relaxed);
    if (q.dateFrom != null && total > 0 && total <= 3 && !relaxed.length) answer += otherYears(q);
    let action;
    if (q.count) {
      answer = (q.korean ? `모두 ${total}개예요. ` : `There are ${total}. `) + answer;
      action = { type: "count", count: total };
    }
    const exact = ranked.length > 0 && !relaxed.length;
    if (q.delete) {
      action = { type: "delete", pending: true, count: exact ? ranked.length : 0, files: ranked.map((h) => h.row.path), skipped: !exact,
        reason: exact ? null : ranked.length ? "only loose matches" : "nothing matched" };
    } else if (q.collect && ops && exact) {
      action = await collect(q, ranked);
    } else if (q.collect) {
      action = { type: q.move ? "move" : "collect", skipped: true, reason: !ranked.length ? "nothing matched" : relaxed.length ? "only loose matches" : "no file access" };
    }
    return { ...out, answer, sources, relaxed: relaxed.length > 0, ...(action ? { action } : {}) };
  }

  /** Copy (or move) the matches into a new top-level folder named after the question, e.g. "Tokyo photos 2026-09". */
  async function collect(q, hits) {
    const folder = folderName(q);
    let copied = 0, failed = 0;
    const files = [];
    for (const h of hits) {
      const dest = `${folder}/${h.row.name}`;
      if (h.row.path === dest) continue;
      try { if (q.move) await ops.move(h.row.path, dest); else await ops.copy(h.row.path, dest); copied++; files.push(dest); }
      catch { failed++; }
    }
    return { type: q.move ? "move" : "collect", folder, copied, failed, share: !!q.share, files };
  }

  function folderName(q) {
    const n = [...q.keywords];
    if (q.city != null) n.push(cityName(q.city, q.korean));
    else if (q.country != null) n.push(countryName(q.country, q.korean));
    n.push(kindNoun(q.kind, 2, q.korean));
    let s = n.join(" ");
    if (q.dateFrom != null) s += " " + ym(q.dateFrom);
    return s.replace(/[\\/:*?"<>|]/g, " ").trim();
  }

  /** All rows matching the hard filters, keyed by path. Content words match the file name here (no CLIP / speech yet). */
  function search(q) {
    const out = new Map();
    const base = { kind: q.kind, country: q.country, city: q.city, dateFrom: q.dateFrom, dateTo: q.dateTo, minSize: q.minSize };
    if (!q.keywords.length) {
      for (const r of index.query(base, 0)) out.set(r.path, { row: r, tier: 0, how: "filter" });
      return out;
    }
    for (const r of index.query({ ...base, keywords: [...q.keywords] }, LIMIT)) out.set(r.path, { row: r, tier: 0, how: "name" });
    // "receipt photos" → a file NAMED like the content word counts too, when the full phrase isn't in any name.
    if (!out.size) {
      const content = contentWords(q.keywords);
      if (content.length && content.length < q.keywords.length) {
        for (const r of index.query({ ...base, keywords: content }, LIMIT)) out.set(r.path, { row: r, tier: 0, how: "name" });
      }
    }
    return out;
  }

  function otherYears(q) {
    if (q.keywords.length) return "";
    const byYear = new Map();
    for (const r of index.query({ kind: q.kind, country: q.country, city: q.city, minSize: q.minSize }, 0)) {
      if (r.whenMs == null || (r.whenMs >= q.dateFrom && (q.dateTo == null || r.whenMs < q.dateTo))) continue;
      const y = new Date(r.whenMs).getFullYear();
      byYear.set(y, (byYear.get(y) ?? 0) + 1);
    }
    if (!byYear.size) return "";
    const top = [...byYear.entries()].sort((a, b) => b[0] - a[0]).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return (q.korean ? " 다른 해: " : " Others here: ") + top.map(([y, n]) => `${y} (${n})`).join(", ") + ".";
  }

  function knownPlaces(kind, ko) {
    const byPlace = new Map();
    for (const r of index.query({ kind: kind ?? PHOTO }, 0)) {
      if (r.city == null) continue;
      const name = cityName(r.city, ko);
      byPlace.set(name, (byPlace.get(name) ?? 0) + 1);
    }
    if (!byPlace.size) return ko ? " 이 폴더의 사진에는 위치 정보가 없어요." : " Photos in this folder have no location.";
    const top = [...byPlace.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return (ko ? " 여기 사진은 이런 곳에서 찍었어요: " : " Photos here are from ") + top.map(([p, n]) => `${p} (${n})`).join(", ") + ".";
  }

  function snippet(h) {
    const r = h.row;
    let s = r.whenMs != null ? ymd(r.whenMs) : "";
    if (r.city != null) s += (s ? " · " : "") + r.city;
    if (r.country != null) s += (r.city != null ? ", " : s ? " · " : "") + r.country;
    if (r.city == null && r.country == null) s += (s ? " · " : "") + r.kind + " · " + humanSize(r.size);
    return s;
  }

  function answerFor(q, rows, total, relaxed) {
    const ko = q.korean;
    if (!rows.length) {
      const where = q.city != null ? cityName(q.city, ko) : q.country != null ? countryName(q.country, ko) : null;
      const topic = q.keywords.join(" ");
      if (where != null || q.dateFrom != null || topic) {
        const what = !topic ? kindNoun(q.kind, 2, ko) : q.kind == null ? topic : `${topic} ${kindNoun(q.kind, 2, ko)}`;
        const when = q.dateFrom != null ? ymd(q.dateFrom) + (q.dateTo != null ? " ~ " + ymd(q.dateTo - 1) : "") : null;
        const none = ko
          ? (where != null ? `${where}에서 찍은 ` : "") + (when != null ? `${when} ` : "") + what + "이 없어요."
          : `No ${what}${where != null ? ` taken in ${where}` : ""}${when != null ? ` from ${when}` : ""} here.`;
        if (topic) {
          const kind = q.kind ?? PHOTO;
          const there = index.query({ kind, country: q.country, city: q.city, dateFrom: q.dateFrom, dateTo: q.dateTo }, 0).length;
          if (there > 0) return ko
            ? (where != null ? `${where}에서 찍은 ` : "") + (when != null ? `${when} ` : "") + `${kindNoun(kind, there, ko)} ${there}개 중에 “${topic}”에 해당하는 건 없어요.`
            : `There are ${there} ${kindNoun(kind, there, ko)}${where != null ? ` taken in ${where}` : ""}${when != null ? ` from ${when}` : ""}, but none of them show “${topic}”.`;
        }
        return none + (where != null ? knownPlaces(q.kind, ko) : "");
      }
      return ko ? "조건에 맞는 파일을 찾지 못했어요." : "No files matched your question.";
    }
    const cities = new Set(), countries = new Set(), kinds = new Set();
    let min = null, max = null;
    for (const { row: r } of rows) {
      if (r.city != null) cities.add(cityName(r.city, ko));
      if (r.country != null) countries.add(countryName(r.country, ko));
      kinds.add(r.kind);
      if (r.whenMs != null) { min = min == null ? r.whenMs : Math.min(min, r.whenMs); max = max == null ? r.whenMs : Math.max(max, r.whenMs); }
    }
    const onlyKind = kinds.size === 1 ? [...kinds][0] : null;
    const noun = kindNoun(onlyKind, rows.length, ko);
    const where = describeWhere([...cities], [...countries], ko);
    const when = describeWhen(min, max, ko);
    const shown = total > rows.length ? (ko ? ` (상위 ${rows.length}개 표시)` : `, showing ${rows.length}`) : "";
    let a = "";
    if (relaxed.length) {
      const parts = relaxed.map((r) => (ko ? RELAXED_KO : RELAXED_EN)[r] ?? (ko ? "국가" : "ignoring the country"));
      a += (ko ? "정확히 일치하는 파일은 없어서 " : "Nothing matched exactly, so ") + parts.join(ko ? "·" : " and ") + (ko ? " 조건을 빼고 " : " — ");
    }
    if (ko) {
      const photoish = onlyKind != null && (onlyKind === PHOTO || onlyKind === SCREENSHOT);
      if (where) a += where + " ";
      if (when) a += when + " ";
      if (photoish && (where || when)) a += "찍은 ";
      a += `${noun} ${total}${countKo(onlyKind)}를 찾았어요.${shown}`;
    } else {
      a += `Found ${total} ${noun}${where ? ` taken in ${where}` : ""}${when ? ` (${when})` : ""}${shown}.`;
    }
    return a;
  }

  return { ask, route, index };
}

const RELAXED_KO = { keyword: "내용", city: "도시", date: "날짜", kind: "종류" };
const RELAXED_EN = { keyword: "ignoring the content words", city: "ignoring the city", date: "ignoring the date", kind: "ignoring the file type" };

function countKo(kind) {
  if (kind == null) return "개";
  if (kind === PHOTO || kind === SCREENSHOT) return "장";
  if (kind === VIDEO || kind === AUDIO) return "개";
  return "건";
}

export function kindNoun(kind, n, ko) {
  const one = n === 1;
  switch (kind) {
    case PHOTO: return ko ? "사진" : one ? "photo" : "photos";
    case SCREENSHOT: return ko ? "스크린샷" : one ? "screenshot" : "screenshots";
    case VIDEO: return ko ? "영상" : one ? "video" : "videos";
    case AUDIO: return ko ? "녹음" : one ? "recording" : "recordings";
    case PDF: return ko ? "PDF" : one ? "PDF" : "PDFs";
    case DOCUMENT: return ko ? "문서" : one ? "document" : "documents";
    case SPREADSHEET: return ko ? "스프레드시트" : one ? "spreadsheet" : "spreadsheets";
    case PRESENTATION: return ko ? "발표자료" : one ? "presentation" : "presentations";
    case ARCHIVE: return ko ? "압축 파일" : one ? "archive" : "archives";
    default: return ko ? "파일" : one ? "file" : "files";
  }
}

function describeWhere(cities, countries, ko) {
  const parts = cities.slice(0, 3);
  if (cities.length > 3) parts.push(ko ? `외 ${cities.length - 3}곳` : `+${cities.length - 3} more`);
  const city = parts.join(ko ? "·" : ", ");
  const country = countries.length === 1 ? countries[0] : "";
  if (!city) return country ? (ko ? `${country}에서` : country) : "";
  if (!country) return ko ? `${city}에서` : city;
  return ko ? `${country} ${city}에서` : `${city}, ${country}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function describeWhen(min, max, ko) {
  if (min == null || max == null) return "";
  const f = (ms) => { const d = new Date(ms); return ko ? `${d.getFullYear()}년 ${d.getMonth() + 1}월` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const a = f(min), b = f(max);
  return a === b ? (ko ? `${a}에` : a) : (ko ? `${a}부터 ${b} 사이에` : `${a} – ${b}`);
}

export function humanSize(bytes) {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
  if (bytes >= 2 ** 10) return `${Math.round(bytes / 2 ** 10)} KB`;
  return `${bytes} B`;
}
