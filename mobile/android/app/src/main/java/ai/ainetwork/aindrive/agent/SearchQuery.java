package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

/**
 * What a question means, once parsed: the single "tool call" the on-device
 * agent makes. Mirrors the `search_files` contract in
 * docs/superpowers/specs/2026-09-23-mobile-on-device-agent-design.md so a
 * P2 LLM planner can emit exactly this shape.
 */
public final class SearchQuery {
    public @Nullable String country;    // ISO-3166 alpha-2
    public @Nullable String city;       // GeoNames name
    public @Nullable Long dateFrom;     // epoch ms, inclusive
    public @Nullable Long dateTo;       // epoch ms, exclusive
    public @Nullable String textQuery;  // leftover content words (unused until CLIP lands)
    /** The question was written in Korean → answer in Korean. */
    public boolean korean;

    public boolean hasFilter() {
        return country != null || city != null || dateFrom != null || dateTo != null;
    }

    @Override public String toString() {
        return "SearchQuery{country=" + country + ", city=" + city + ", from=" + dateFrom
                + ", to=" + dateTo + ", text=" + textQuery + "}";
    }
}
