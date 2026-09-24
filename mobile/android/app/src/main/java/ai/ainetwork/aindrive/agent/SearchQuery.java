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

    public @Nullable String textQuery() {
        return keywords.isEmpty() ? null : String.join(" ", keywords);
    }

    @Override public String toString() {
        return "SearchQuery{kind=" + kind + ", country=" + country + ", city=" + city + ", from=" + dateFrom
                + ", to=" + dateTo + ", minSize=" + minSize + ", keywords=" + keywords + "}";
    }
}
