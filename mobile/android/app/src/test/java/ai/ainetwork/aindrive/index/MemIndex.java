package ai.ainetwork.aindrive.index;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * A FileIndex held in a list, for running the agent end to end on the JVM (SQLite isn't
 * here). `count` and `query` mirror FileIndex's SQL; every method that would change the
 * index is recorded in {@link #writes} instead, so a test can prove nothing was written.
 */
public class MemIndex extends FileIndex {
    public final List<Row> rows = new ArrayList<>();
    public final List<String> writes = new ArrayList<>();

    public MemIndex add(String path, String kind, String city, String country, long whenMs) {
        Row r = new Row();
        r.docId = "doc:" + path;
        r.path = path;
        r.name = path.substring(path.lastIndexOf('/') + 1);
        r.kind = kind;
        r.mime = FileIndex.PHOTO.equals(kind) ? "image/jpeg" : null;
        r.city = city;
        r.country = country;
        r.whenMs = whenMs;
        r.mtimeMs = whenMs;
        r.size = 1000 + rows.size();
        rows.add(r);
        return this;
    }

    @Override public int count() { return rows.size(); }

    @Override public List<Row> query(Filter f, int limit) {
        List<Row> out = new ArrayList<>();
        for (Row r : rows) if (matches(f, r)) out.add(r);
        Comparator<Row> byWhen = Comparator.comparing((Row r) -> r.whenMs == null ? Long.MIN_VALUE : r.whenMs).reversed();
        out.sort(f.minSize != null
                ? Comparator.comparingLong((Row r) -> r.size).reversed().thenComparing(byWhen)
                : byWhen.thenComparing(r -> r.path));
        return limit > 0 && out.size() > limit ? new ArrayList<>(out.subList(0, limit)) : out;
    }

    private static boolean matches(Filter f, Row r) {
        if (f.kind != null && !f.kind.equals(r.kind)) return false;
        if (f.country != null && !f.country.equals(r.country)) return false;
        if (f.city != null && (r.city == null || !f.city.equalsIgnoreCase(r.city))) return false;
        if (f.dateFrom != null && (r.whenMs == null || r.whenMs < f.dateFrom)) return false;
        if (f.dateTo != null && (r.whenMs == null || r.whenMs >= f.dateTo)) return false;
        if (f.minSize != null && r.size < f.minSize) return false;
        if (f.keywordsInTranscript && !f.keywords.isEmpty()) {
            if (r.transcript == null) return false;
            String t = r.transcript.toLowerCase(Locale.ROOT);
            boolean any = false;
            for (String k : f.keywords) any |= t.contains(k.toLowerCase(Locale.ROOT));
            if (!any) return false;
        } else {
            String n = r.name.toLowerCase(Locale.ROOT);
            for (String k : f.keywords) if (!n.contains(k.toLowerCase(Locale.ROOT))) return false;
        }
        if (f.withVec && r.vec == null) return false;
        boolean under = true;
        for (String p : f.under) {
            if (p == null || p.isEmpty()) continue;
            under = false;
            if (r.path.equals(p) || r.path.startsWith(p + "/")) return true;
        }
        return under;
    }

    // Every write is recorded, never done.
    @Override public void upsert(Row r) { writes.add("upsert"); }
    @Override public int deleteMissing(Set<String> live) { writes.add("deleteMissing"); return 0; }
    @Override public int removeUnder(List<String> spellings) { writes.add("removeUnder"); return 0; }
    @Override public boolean rekey(List<String> o, String id, String p, String n, String k, long m, long s) { writes.add("rekey"); return false; }
    @Override public int removeAtExcept(List<String> spellings, String keep) { writes.add("removeAtExcept"); return 0; }
    @Override public void setRecognition(String docId, byte[] vec, String transcript) { writes.add("setRecognition"); }
    @Override public void setMeta(String key, String value) { writes.add("setMeta"); }
    @Override public String getMeta(String key) { return null; }
    @Override public void adoptSpeechEngine(String engine) { writes.add("adoptSpeechEngine"); }
    @Override public void adoptImageModel(String model) { writes.add("adoptImageModel"); }
}
