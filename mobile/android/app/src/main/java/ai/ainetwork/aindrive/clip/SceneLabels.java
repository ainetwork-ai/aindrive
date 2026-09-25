package ai.ainetwork.aindrive.clip;

import java.util.ArrayList;
import java.util.List;

/**
 * Zero-shot "does this photo show X?" — the photo is classified against X plus
 * a fixed vocabulary of everyday scenes, instead of comparing its raw cosine
 * to a fixed cut-off.
 *
 * Why: raw CLIP cosines are small and shift per library and per concept. On a
 * real phone the grilled-meat and fish photos scored 0.19/0.18 for "food"
 * while documents scored 0.28 for "document" — any single threshold either
 * missed the food or flooded the result with signs. Asking "is food the most
 * likely of ~90 things this could be?" is scale-free: 34/35 hits were food on
 * the same library, and cats, cars, sunsets, people, mountains held up too.
 *
 * Labels whose text is (nearly) the query itself ("food" vs "a meal") are
 * merged into the query, so a synonym doesn't steal its photos.
 */
public final class SceneLabels {
    private SceneLabels() { }

    /** Everyday things a phone photo shows. Order is irrelevant; add freely. */
    public static final String[] VOCAB = {
        "food", "a meal", "a drink", "coffee", "dessert", "a person", "a group of people", "a selfie", "a child", "a baby",
        "a dog", "a cat", "an animal", "a bird", "a building", "a street", "a city skyline", "a landscape", "mountains",
        "a beach", "the sea", "the sky", "a sunset", "a night scene", "flowers", "a plant", "trees", "a car", "a bus",
        "an airplane", "a train", "a room", "an office", "a desk", "a computer screen", "a laptop", "a phone screenshot",
        "a document", "text", "a receipt", "a sign", "a poster", "a whiteboard", "a presentation slide", "a map", "a ticket",
        "a qr code", "a book", "clothes", "shoes", "a product", "a toy", "a stuffed toy", "a painting", "a sculpture", "sports",
        "a concert", "a stage", "a conference", "a hotel room", "a bed", "a bathroom", "a kitchen", "a restaurant",
        "a store", "a market", "a bottle", "a chart", "a card", "a logo", "a floor", "a wall", "a ceiling", "a door",
        "a window", "a table", "a chair", "a car interior", "an airport", "a parking lot", "a road", "a river", "a park",
        "a bridge", "a crowd", "hands", "a menu",
    };

    /** Labels at/above this text similarity to the query are the query (synonyms/articles). */
    static final float SAME = 0.95f;
    /** …or the single closest label, when at least this similar and this far ahead of the runner-up. */
    static final float ALIAS = 0.88f, ALIAS_GAP = 0.03f;
    /** CLIP's logit scale. */
    static final float SCALE = 100f;
    /** Match when the query wins with at least MIN_WIN, or is at least MIN_ANY likely even if another label wins. */
    static final float MIN_WIN = 0.2f, MIN_ANY = 0.3f;

    public static String prompt(String label) { return "a photo of " + label; }

    /**
     * Probability that each photo shows the query (softmax over query + competing labels),
     * or -1 when it doesn't count as a match. {@code labels[i]} are the label text vectors.
     */
    public static float[] match(float[] query, float[][] labels, List<float[]> photos) {
        float[] sim = new float[labels.length];
        int first = -1, second = -1;
        boolean same = false;
        for (int i = 0; i < labels.length; i++) {
            sim[i] = ClipEmbedder.dot(labels[i], query);
            same |= sim[i] >= SAME;
            if (first < 0 || sim[i] > sim[first]) { second = first; first = i; }
            else if (second < 0 || sim[i] > sim[second]) second = i;
        }
        // "receipts" vs the label "a receipt" (0.94), "dogs" vs "a dog" (0.90): a plural or other
        // form of one label is that label when it stands clearly apart from the next one.
        int alias = !same && first >= 0 && sim[first] >= ALIAS && (second < 0 || sim[first] - sim[second] >= ALIAS_GAP) ? first : -1;
        List<float[]> rivals = new ArrayList<>();
        for (int i = 0; i < labels.length; i++) if (sim[i] < SAME && i != alias) rivals.add(labels[i]);
        // Search with the label's own wording: "a photo of receipts" sits further from receipt photos than "a photo of a receipt".
        if (alias >= 0) query = labels[alias];
        float[] out = new float[photos.size()];
        for (int i = 0; i < photos.size(); i++) {
            float[] v = photos.get(i);
            if (v == null) { out[i] = -1; continue; }
            float sq = ClipEmbedder.dot(v, query), best = Float.NEGATIVE_INFINITY;
            float[] s = new float[rivals.size()];
            for (int j = 0; j < s.length; j++) { s[j] = ClipEmbedder.dot(v, rivals.get(j)); best = Math.max(best, s[j]); }
            float top = Math.max(sq, best);
            double sum = Math.exp(SCALE * (sq - top)), q = sum;
            for (float x : s) sum += Math.exp(SCALE * (x - top));
            float p = (float) (q / sum);
            boolean wins = sq >= best;
            out[i] = (wins && p >= MIN_WIN) || p >= MIN_ANY ? p : -1;
        }
        return out;
    }
}
