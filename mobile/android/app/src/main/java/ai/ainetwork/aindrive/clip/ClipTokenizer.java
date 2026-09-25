package ai.ainetwork.aindrive.clip;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CLIP's byte-level BPE tokenizer, ported from open_clip's SimpleTokenizer so
 * the text encoder sees exactly the ids it was trained with. Pinned against
 * vectors produced by the reference HF `tokenizers` implementation
 * (src/test/resources/clip-tokenizer-vectors.tsv) — regenerate them from
 * Python rather than editing them to match new output.
 *
 * Assets: clip/vocab.txt (one token per line, line number = id) and
 * clip/merges.txt (one "a b" pair per line, in priority order).
 */
public final class ClipTokenizer {
    public static final int CONTEXT = 77;
    public static final int BOS = 49406, EOS = 49407, PAD = 0;

    private static final Pattern PAT = Pattern.compile(
            "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+",
            Pattern.CASE_INSENSITIVE);

    private final Map<String, Integer> encoder = new HashMap<>();
    private final Map<String, Integer> ranks = new HashMap<>();
    private final String[] byteEncoder = new String[256];

    public ClipTokenizer(InputStream vocab, InputStream merges) throws IOException {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(vocab, StandardCharsets.UTF_8))) {
            String line; int id = 0;
            while ((line = r.readLine()) != null) encoder.put(line, id++);
        }
        try (BufferedReader r = new BufferedReader(new InputStreamReader(merges, StandardCharsets.UTF_8))) {
            String line; int rank = 0;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty() || line.startsWith("#version")) continue;
                ranks.put(line, rank++);
            }
        }
        // GPT-2 bytes_to_unicode: printable bytes map to themselves, the rest to U+0100+.
        List<Integer> bs = new ArrayList<>();
        for (int b = '!'; b <= '~'; b++) bs.add(b);
        for (int b = 0xA1; b <= 0xAC; b++) bs.add(b);
        for (int b = 0xAE; b <= 0xFF; b++) bs.add(b);
        Set<Integer> have = new HashSet<>(bs);
        int n = 0;
        for (int b = 0; b < 256; b++) {
            if (have.contains(b)) byteEncoder[b] = new String(Character.toChars(b));
            else byteEncoder[b] = new String(Character.toChars(256 + n++));
        }
    }

    /** BOS + tokens + EOS, padded with PAD to CONTEXT (truncated to keep EOS last). */
    public long[] encode(String text) {
        List<Integer> ids = new ArrayList<>();
        ids.add(BOS);
        String clean = Normalizer.normalize(text, Normalizer.Form.NFC).replaceAll("\\s+", " ").trim().toLowerCase(Locale.ROOT);
        Matcher m = PAT.matcher(clean);
        while (m.find()) {
            StringBuilder sb = new StringBuilder();
            for (byte b : m.group().getBytes(StandardCharsets.UTF_8)) sb.append(byteEncoder[b & 0xFF]);
            for (String piece : bpe(sb.toString()).split(" ")) {
                Integer id = encoder.get(piece);
                if (id != null) ids.add(id);
            }
        }
        if (ids.size() > CONTEXT - 1) ids = new ArrayList<>(ids.subList(0, CONTEXT - 1));
        ids.add(EOS);
        long[] out = new long[CONTEXT];
        Arrays.fill(out, PAD);
        for (int i = 0; i < ids.size(); i++) out[i] = ids.get(i);
        return out;
    }

    private final Map<String, String> cache = new HashMap<>();

    private String bpe(String token) {
        String hit = cache.get(token);
        if (hit != null) return hit;
        List<String> word = new ArrayList<>();
        int[] cps = token.codePoints().toArray();
        for (int i = 0; i < cps.length; i++) {
            String c = new String(Character.toChars(cps[i]));
            word.add(i == cps.length - 1 ? c + "</w>" : c);
        }
        while (word.size() > 1) {
            String best = null; int bestRank = Integer.MAX_VALUE;
            for (int i = 0; i < word.size() - 1; i++) {
                Integer r = ranks.get(word.get(i) + " " + word.get(i + 1));
                if (r != null && r < bestRank) { bestRank = r; best = word.get(i) + " " + word.get(i + 1); }
            }
            if (best == null) break;
            String first = best.substring(0, best.indexOf(' ')), second = best.substring(best.indexOf(' ') + 1);
            List<String> merged = new ArrayList<>();
            for (int i = 0; i < word.size(); ) {
                if (i < word.size() - 1 && word.get(i).equals(first) && word.get(i + 1).equals(second)) { merged.add(first + second); i += 2; }
                else { merged.add(word.get(i)); i++; }
            }
            word = merged;
        }
        String out = String.join(" ", word);
        cache.put(token, out);
        return out;
    }
}
