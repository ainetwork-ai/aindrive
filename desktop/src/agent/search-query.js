// Mirrors mobile/android/app/src/main/java/ai/ainetwork/aindrive/agent/SearchQuery.java
/**
 * What a question means, once parsed: the single "tool call" the on-device
 * agent makes (the `search_files` contract in
 * docs/superpowers/specs/2026-09-23-mobile-on-device-agent-design.md).
 *
 * Fields are the Java ones; `null` where Java has a null object. `toJson()` /
 * `SearchQuery.fromJson()` use the same keys as the phone, so a context the Mac
 * produces round-trips through the shell like the phone's.
 */
export class SearchQuery {
  constructor() {
    /** One of the file kinds ("photo", "screenshot", "video", "audio", "pdf", …) or null for any kind. */
    this.kind = null;
    /** ISO-3166 alpha-2. */
    this.country = null;
    /** GeoNames name. */
    this.city = null;
    /** Epoch ms, inclusive. */
    this.dateFrom = null;
    /** Epoch ms, exclusive. */
    this.dateTo = null;
    /** Bytes; "large files". */
    this.minSize = null;
    /** Leftover content words: matched against file names, and CLIP. */
    this.keywords = [];
    /** The question was written in Korean → answer in Korean. */
    this.korean = false;
    /** "…모아서 폴더로 만들어줘": copy the matches into a new folder. */
    this.collect = false;
    /** "…옮겨줘": like collect, but MOVE. */
    this.move = false;
    /** "…공유해줘": after collecting, mint a share link (done by the shell). */
    this.share = false;
    /** "…삭제해줘": list what would be deleted and wait for confirmation. */
    this.delete = false;
    /** "몇 개야 / how many": answer with the count only. */
    this.count = false;
    /** "가장 최근 3개": cap the result list. 0 = default. */
    this.limit = 0;
    /** "가장 오래된": oldest first. */
    this.oldestFirst = false;
    /** "큰 파일 5개": rank by size. */
    this.bySize = false;
    /** The call-history report, not a file search. */
    this.calls = false;
    /** "who likes me the most": rank contacts by affection in calls. */
    this.likes = false;
    /** "엄유준 최신 통화 stt 해줘": transcribe one recording. */
    this.transcribe = false;
    /** The question as asked, for a transcribe request. */
    this.asked = null;
    /** Filters were inherited from the previous turn. */
    this.followUp = false;
    /** Words that were neither a filter nor content. */
    this.ignoredWords = 0;
  }

  /** Any hard filter or content word — the question said WHAT to look for. */
  hasFilters() {
    return this.kind != null || this.country != null || this.city != null || this.dateFrom != null || this.dateTo != null
      || this.minSize != null || this.keywords.length > 0;
  }

  /** True when the question only says what to DO (share, collect, count…), not what with. */
  isTaskOnly() {
    return !this.hasFilters() && (this.collect || this.move || this.share || this.delete || this.count || this.limit > 0 || this.oldestFirst || this.bySize);
  }

  /**
   * The filters as a plain object — the "context" the shell keeps between turns.
   * Null filters are left out (JSONObject.putOpt); task flags are not carried.
   */
  toJson() {
    const o = {};
    for (const k of ["kind", "country", "city", "dateFrom", "dateTo", "minSize"]) if (this[k] != null) o[k] = this[k];
    Object.assign(o, { keywords: [...this.keywords], korean: this.korean, limit: this.limit, oldestFirst: this.oldestFirst, bySize: this.bySize });
    return o;
  }

  /** A context object back into a query; null when it carries no filter. */
  static fromJson(o) {
    if (o == null) return null;
    const q = new SearchQuery();
    q.kind = o.kind == null ? null : optString(o.kind);
    q.country = o.country == null ? null : optString(o.country);
    q.city = o.city == null ? null : optString(o.city);
    q.dateFrom = o.dateFrom == null ? null : optLong(o.dateFrom);
    q.dateTo = o.dateTo == null ? null : optLong(o.dateTo);
    q.minSize = o.minSize == null ? null : optLong(o.minSize);
    if (Array.isArray(o.keywords)) for (const k of o.keywords) q.keywords.push(k == null ? "" : optString(k));
    q.korean = optBoolean(o.korean);
    q.limit = optInt(o.limit);
    q.oldestFirst = optBoolean(o.oldestFirst);
    q.bySize = optBoolean(o.bySize);
    return q.hasFilters() ? q : null;
  }

  textQuery() {
    return this.keywords.length === 0 ? null : this.keywords.join(" ");
  }

  toString() {
    return `SearchQuery{kind=${this.kind}, country=${this.country}, city=${this.city}, from=${this.dateFrom}, to=${this.dateTo}, minSize=${this.minSize}, keywords=[${this.keywords.join(", ")}]}`;
  }
}

// org.json's lenient accessors, for contexts that went through JSON (numbers as strings, etc.).
const optString = (v) => (typeof v === "string" ? v : String(v));
const optLong = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const optInt = (v) => optLong(v) | 0;
const optBoolean = (v) => v === true || (typeof v === "string" && v.toLowerCase() === "true");
