package ai.ainetwork.aindrive.agent;

import androidx.annotation.Nullable;

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
    /** "…공유해줘": after collecting, mint a share link for that folder (done by the shell, which holds the session). */
    public boolean share;

    public @Nullable String textQuery() {
        return keywords.isEmpty() ? null : String.join(" ", keywords);
    }

    @Override public String toString() {
        return "SearchQuery{kind=" + kind + ", country=" + country + ", city=" + city + ", from=" + dateFrom
                + ", to=" + dateTo + ", minSize=" + minSize + ", keywords=" + keywords + "}";
    }
}
