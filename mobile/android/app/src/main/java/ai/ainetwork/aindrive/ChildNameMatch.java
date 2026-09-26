package ai.ainetwork.aindrive;

import java.text.Normalizer;

/**
 * Picks a folder's child by name, one row at a time. The server names paths in NFC; a file a Mac
 * wrote keeps its NFD name on the phone's byte-exact storage, so an exact match wins and otherwise
 * the first child whose name is equal under NFC is taken. Mirrors cli/src/rpc.js matchSpelling.
 */
final class ChildNameMatch {
    private final String want;
    private final String wantNfc;
    private String exact;
    private String loose;

    ChildNameMatch(String want) {
        this.want = want;
        this.wantNfc = Normalizer.normalize(want, Normalizer.Form.NFC);
    }

    /** Considers one child; returns true on the exact name, when the scan can stop. */
    boolean offer(String id, String name) {
        if (want.equals(name)) { exact = id; return true; }
        if (loose == null && name != null && wantNfc.equals(Normalizer.normalize(name, Normalizer.Form.NFC))) loose = id;
        return false;
    }

    /** The exact child's id, else the NFC-equal one's, else null. */
    String result() {
        return exact != null ? exact : loose;
    }
}
