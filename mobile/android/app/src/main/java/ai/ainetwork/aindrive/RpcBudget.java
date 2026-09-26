package ai.ainetwork.aindrive;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * How long the server waits for each RPC, and which of a drive's worker lanes runs it.
 *
 * The server fails an RPC it has not heard back on after its timeout (web/lib/agents.js
 * sendRpc); a reply after that is thrown away but still costs the phone's uplink. So a
 * request's deadline is fixed when it ARRIVES here — arrival + the server's timeout for
 * its method, less a margin for the network — and it bounds both the wait for a worker
 * and the wait for room in the socket's queue ({@link SendGate}).
 *
 * The timeouts are the LONGEST any server call site gives the method (a shorter one only
 * means a reply may arrive after that one call gave up — the old behaviour); keep them in
 * step with the web:
 *  - 25 s: agents.js DEFAULT_TIMEOUT_MS — list, stat, read, write, delete, mkdir, yjs-*,
 *    handoff-read and everything else that passes no timeoutMs;
 *  - 120 s: upload-chunk and rename (fs/upload, upload-sessions, upload-pipeline) and
 *    download-chunk (agent-stream STREAM_CHUNK_TIMEOUT_MS);
 *  - 90 s: agent-ask (the `ask` skill of phone protocol v2; the owner's /ask route gives 60).
 *
 * Lanes: every drive has its own workers, so one drive's traffic never holds another's
 * requests; and within a drive, the methods whose reply can be megabytes (a whole file in
 * base64) have a lane of their own, so a thumbnail grid pulling whole photos can't take
 * the workers a list or stat needs.
 *
 * Pure (no Android types) so it is unit-tested on the JVM.
 */
final class RpcBudget {
    private RpcBudget() {}

    static final long SERVER_DEFAULT_MS = 25_000;
    static final long SERVER_TRANSFER_MS = 120_000;
    static final long SERVER_ASK_MS = 90_000;
    /** For the request to have reached the phone and the reply to reach the server. */
    static final long MARGIN_MS = 2_000;

    /** Workers per drive for bulk replies (read, download-chunk, …) and for everything else. */
    static final int BULK_WORKERS = 2, CONTROL_WORKERS = 4;

    /** The longest the server waits for `method`. */
    static long serverTimeoutMs(String method) {
        switch (method == null ? "" : method) {
            case "upload-chunk":
            case "download-chunk":
            case "rename":
                return SERVER_TRANSFER_MS;
            case "agent-ask":
                return SERVER_ASK_MS;
            default:
                return SERVER_DEFAULT_MS;
        }
    }

    /** The {@link SendGate} deadline for a request of `method` that arrived at `arrivedNanos`. */
    static long deadlineNanos(String method, long arrivedNanos) {
        return arrivedNanos + (serverTimeoutMs(method) - MARGIN_MS) * 1_000_000L;
    }

    /** A drive's worker lane: `n` threads, none kept while the drive is idle. */
    static ExecutorService lane(String name, int n) {
        AtomicInteger seq = new AtomicInteger();
        ThreadPoolExecutor pool = new ThreadPoolExecutor(n, n, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(),
                r -> new Thread(r, name + "-" + seq.incrementAndGet()));
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }

    /** True when the request in `frame` runs in the bulk lane (see {@link #methodOf}). */
    static boolean bulkFrame(String frame) { return bulk(methodOf(frame)); }

    /** Methods whose reply can be megabytes: they run in the drive's bulk lane. */
    static boolean bulk(String method) {
        switch (method == null ? "" : method) {
            case "read":
            case "download-chunk":
            case "handoff-read":
            case "yjs-read":
                return true;
            default:
                return false;
        }
    }

    /**
     * Methods that change nothing: when one is still queued for a worker at its deadline, the
     * server has given up on it and it is skipped instead of read and dropped. Anything that
     * writes still runs, as before (an upload session re-reads the temp file's size with `stat`
     * after a failed part, web/lib/upload-sessions.ts statAgentTempBytes).
     */
    static boolean readOnly(String method) {
        switch (method == null ? "" : method) {
            case "list":
            case "stat":
            case "read":
            case "download-chunk":
            case "handoff-read":
            case "yjs-read":
            case "yjs-stats":
                return true;
            default:
                return false;
        }
    }

    /** How far into a frame the method is looked for: it sits right after the frame's envelope. */
    static final int METHOD_SCAN_CHARS = 8192;

    /**
     * The request's method, read from the frame text without parsing it — only to pick a lane
     * on the socket's reader thread (a 4 MiB upload-chunk frame is not parsed there). The worker
     * parses and verifies the frame and uses its real method for everything else; a wrong guess
     * here only puts a request in the other lane. "" when not found.
     */
    static String methodOf(String frame) {
        if (frame == null) return "";
        String head = frame.length() > METHOD_SCAN_CHARS ? frame.substring(0, METHOD_SCAN_CHARS) : frame;
        String key = "\"method\":\"";
        int at = head.indexOf(key);
        if (at < 0) return "";
        int from = at + key.length();
        int end = head.indexOf('"', from);
        if (end < 0 || end - from > 64) return "";
        return head.substring(from, end);
    }
}
