package ai.ainetwork.aindrive;

import java.util.List;

/**
 * The drive's .aindrive/ subtree is off-limits over RPC except the two parts the web server drives
 * itself: agents/ (agent JSON) and uploads/ (upload temp parts). Compared ignoring case: phone
 * storage and a Mac-formatted card can ignore it, so ".AINDRIVE/config.json" is the same file.
 * Mirrors cli/src/rpc.js isReservedRpcPath, as a second layer behind the web's own gate.
 */
final class ReservedPath {
    private ReservedPath() {}

    static boolean isReserved(List<String> segs) {
        if (segs.isEmpty() || !segs.get(0).equalsIgnoreCase(".aindrive")) return false;
        return segs.size() < 2 || !(segs.get(1).equalsIgnoreCase("agents") || segs.get(1).equalsIgnoreCase("uploads"));
    }
}
