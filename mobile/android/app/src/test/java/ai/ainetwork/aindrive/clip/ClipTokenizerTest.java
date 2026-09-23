package ai.ainetwork.aindrive.clip;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** The Java BPE must produce the same ids as HF `tokenizers` on the reference vectors. */
public class ClipTokenizerTest {
    @Test
    public void matchesReferenceVectors() throws Exception {
        ClipTokenizer t = new ClipTokenizer(new FileInputStream("src/main/assets/clip/vocab.txt"), new FileInputStream("src/main/assets/clip/merges.txt"));
        List<String> failures = new ArrayList<>();
        int n = 0;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/clip-tokenizer-vectors.tsv"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty()) continue;
                String[] c = line.split("\t");
                long[] got = t.encode(c[0]);
                StringBuilder sb = new StringBuilder();
                for (long id : got) { if (id == ClipTokenizer.PAD && sb.length() > 0) break; sb.append(sb.length() > 0 ? " " : "").append(id); }
                if (!sb.toString().equals(c[1])) failures.add(c[0] + "\n   want " + c[1] + "\n   got  " + sb);
                n++;
            }
        }
        assertEquals("vectors", 10, n);
        if (!failures.isEmpty()) throw new AssertionError(String.join("\n", failures));
        assertEquals(77, t.encode("x").length);
    }
}
