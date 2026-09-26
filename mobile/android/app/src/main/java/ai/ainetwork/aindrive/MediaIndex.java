package ai.ainetwork.aindrive;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

/**
 * A file's chunk hash list for the server's verifying media cache (web
 * docs/superpowers/specs/2026-09-26-p2p-media-streaming-design.md, M2): 1 MiB
 * leaves, SHA-256 each, read chunk by chunk so a long video never sits in memory.
 * Same algorithm as web/shared/media/chunks.ts; web/shared/media/chunk-vectors.json
 * pins it across TypeScript, Java and Swift.
 */
final class MediaIndex {
    static final int CHUNK = 1 << 20;

    interface Reader {
        /** Up to `length` bytes at `offset`; fewer only at the end of the file. */
        byte[] read(long offset, int length) throws IOException;
    }

    static List<String> leaves(Reader reader, long size) throws IOException {
        MessageDigest sha;
        try { sha = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IOException("SHA-256 unavailable", e); }
        List<String> out = new ArrayList<>();
        byte[] chunk = new byte[CHUNK];
        long offset = 0;
        while (offset < size) {
            int want = (int) Math.min(CHUNK, size - offset);
            int fill = 0;
            while (fill < want) { // a reader may return less than asked: keep reading this chunk
                byte[] part = reader.read(offset + fill, want - fill);
                if (part.length == 0) throw new IOException("file shrank while indexing");
                System.arraycopy(part, 0, chunk, fill, part.length);
                fill += part.length;
            }
            sha.update(chunk, 0, fill);
            out.add(hex(sha.digest()));
            offset += fill;
        }
        return out;
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return s.toString();
    }
}
