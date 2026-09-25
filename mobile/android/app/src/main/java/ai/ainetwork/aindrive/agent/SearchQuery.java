package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * What a question means, once parsed: the single "tool call" the on-device
 * agent makes. Mirrors the `search_files` contract in
 * docs/superpowers/specs/2026-09-23-mobile-on-device-agent-design.md so a
 * P2 LLM planner can emit exactly this shape.
 */
public final class SearchQuery {
    /** One of FileIndex.PHOTO … OTHER, or null for any kind. */
    public @Nullable String kind;
    public @Nullable String country;    // ISO-3166 alpha-2
    public @Nullable String city;       // GeoNames name
    public @Nullable Long dateFrom;     // epoch ms, inclusive
    public @Nullable Long dateTo;       // epoch ms, exclusive
    /** Bytes; "large files". */
    public @Nullable Long minSize;
    /** Leftover content words: matched against file names now, against CLIP embeddings later. */
    public List<String> keywords = new ArrayList<>();
    /** The question was written in Korean → answer in Korean. */
    public boolean korean;
    /** "…모아서 폴더로 만들어줘": copy the matches into a new folder. */
    public boolean collect;
    /** "…옮겨줘": like collect, but MOVE (the originals disappear). */
    public boolean move;
    /** "…공유해줘": after collecting, mint a share link for that folder (done by the shell, which holds the session). */
    public boolean share;
    /** "…삭제해줘": destructive — the agent lists what it WOULD delete and waits for confirmation. */
    public boolean delete;
    /** "몇 개야 / how many": answer with the count only. */
    public boolean count;
    /** "가장 최근 3개 / 큰 파일 5개": cap the result list. 0 = default. */
    public int limit;
    /** "가장 오래된": oldest first instead of newest. */
    public boolean oldestFirst;
    /** "큰 파일 5개": rank by size (with a limit) rather than a size floor. */
    public boolean bySize;
    /** "통화내역 많이 통화한 순으로 / sort my calls by who I talk to most": the call-history report, not a file search. */
    public boolean calls;
    /** "who likes me the most": rank contacts by signs of affection in calls, with proof. */
    public boolean likes;
    /** Filters were inherited from the previous turn ("…and share them"). */
    public boolean followUp;
    /** Words that were neither a filter nor content ("check", "weather"): a search box doesn't get those. */
    public int ignoredWords;

    /** Any hard filter or content word — i.e. the question said WHAT to look for. */
    public boolean hasFilters() {
        return kind != null || country != null || city != null || dateFrom != null || dateTo != null || minSize != null || !keywords.isEmpty();
    }

    /** True when the question only says what to DO (share, collect, count…), not what with. */
    public boolean isTaskOnly() {
        return !hasFilters() && (collect || move || share || delete || count || limit > 0 || oldestFirst || bySize);
    }

    /**
     * The filters as JSON — the "context" the shell keeps between turns so
     * "…and share them" knows what "them" is. Task flags are not carried: each
     * turn says what to do. How many and in what order ("the 5 oldest") are.
     */
    public JSONObject toJson() {
        try {
            return new JSONObject().putOpt("kind", kind).putOpt("country", country).putOpt("city", city)
                    .putOpt("dateFrom", dateFrom).putOpt("dateTo", dateTo).putOpt("minSize", minSize)
                    .put("keywords", new JSONArray(keywords)).put("korean", korean)
                    .put("limit", limit).put("oldestFirst", oldestFirst).put("bySize", bySize);
        } catch (Exception e) { return new JSONObject(); }
    }

    public static @Nullable SearchQuery fromJson(@Nullable JSONObject o) {
        if (o == null) return null;
        SearchQuery q = new SearchQuery();
        q.kind = o.isNull("kind") ? null : o.optString("kind");
        q.country = o.isNull("country") ? null : o.optString("country");
        q.city = o.isNull("city") ? null : o.optString("city");
        q.dateFrom = o.isNull("dateFrom") ? null : o.optLong("dateFrom");
        q.dateTo = o.isNull("dateTo") ? null : o.optLong("dateTo");
        q.minSize = o.isNull("minSize") ? null : o.optLong("minSize");
        JSONArray k = o.optJSONArray("keywords");
        if (k != null) for (int i = 0; i < k.length(); i++) q.keywords.add(k.optString(i));
        q.korean = o.optBoolean("korean");
        q.limit = o.optInt("limit");
        q.oldestFirst = o.optBoolean("oldestFirst");
        q.bySize = o.optBoolean("bySize");
        return q.hasFilters() ? q : null;
    }

    public @Nullable String textQuery() {
        return keywords.isEmpty() ? null : String.join(" ", keywords);
    }

    @Override public String toString() {
        return "SearchQuery{kind=" + kind + ", country=" + country + ", city=" + city + ", from=" + dateFrom
                + ", to=" + dateTo + ", minSize=" + minSize + ", keywords=" + keywords + "}";
    }
}
