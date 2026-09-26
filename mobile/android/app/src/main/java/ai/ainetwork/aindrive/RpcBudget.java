package ai.ainetwork.aindrive;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
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
 * requests; and within a drive three lanes ({@link #laneOf}): the methods whose reply can be
 * megabytes (a whole file in base64) or that decode an image, so a thumbnail grid can't take
 * the workers a list or stat needs; `agent-ask`, which can run for a minute (a photo
 * question may load the ~400 MB image model) and which anyone with read access to the
 * folder can now send, so questions can't take them either; and everything else. Across
 * drives, at most {@link #MAX_BULK_IN_FLIGHT} bulk replies are in memory at once
 * ({@link #bulkSlots}), and at most {@link #MAX_BIG_FRAMES_IN_FLIGHT} big incoming frames
 * (an upload chunk, a write) are being parsed and applied at once ({@link #bigFrameSlots}).
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

    /**
     * Questions (`agent-ask`) answered at once per drive, on their own workers: two, so one slow
     * question (an owner's call report can run for minutes) doesn't hold every other one, and a
     * burst of questions never holds the drive's list/stat. More would only compete for the same
     * CPU and image model.
     */
    static final int ASK_WORKERS = 2;

    /** Which of a drive's worker lanes runs a method. */
    enum Lane { BULK, ASK, CONTROL }

    static Lane laneOf(String method) {
        if (bulk(method)) return Lane.BULK;
        if ("agent-ask".equals(method)) return Lane.ASK;
        return Lane.CONTROL;
    }

    /** The lane for the request in `frame` (see {@link #methodOf}). */
    static Lane laneOfFrame(String frame) { return laneOf(methodOf(frame)); }

    /**
     * An incoming frame this long (UTF-16 chars) is big: an upload chunk (~5.6 MB of base64), a
     * `write` or a `yjs-write`. While one is parsed and applied it costs the frame text, its parsed
     * copy and the decoded bytes — tens of MB.
     */
    static final int BIG_FRAME_CHARS = 1024 * 1024;

    /**
     * Big incoming frames parsed and applied at once, on the whole phone: the ceiling the one
     * process-wide pool of 4 RPC workers gave before every drive had lanes of its own. A frame
     * waits for a slot (writes are never skipped); with one drive and the web's one PATCH in
     * flight per upload, it never does.
     */
    static final int MAX_BIG_FRAMES_IN_FLIGHT = 4;

    /** The phone's big-frame slots, first come first served. */
    static Semaphore bigFrameSlots() { return new Semaphore(MAX_BIG_FRAMES_IN_FLIGHT, true); }

    /** True when `frame` takes a big-frame slot while it is parsed and applied. */
    static boolean bigFrame(String frame) { return frame != null && frame.length() >= BIG_FRAME_CHARS; }

    /**
     * Bulk replies being built or waiting to be sent, on the whole phone: each holds an 8 MiB
     * read, its ≈ 11 MB of base64 and the signed frame (tens of MB at peak) until the send gate
     * lets it go, and the app has no large heap. 4 is the ceiling the one process-wide pool of
     * 4 RPC workers gave before drives had lanes of their own; with one or two drives the lanes
     * (2 bulk workers each) never reach it.
     */
    static final int MAX_BULK_IN_FLIGHT = 4;

    /** The phone's bulk slots: one per bulk reply in flight, first come first served. */
    static Semaphore bulkSlots() { return new Semaphore(MAX_BULK_IN_FLIGHT, true); }

    /**
     * Take a bulk slot, waiting until `deadlineNanos` at the latest. False when the deadline came
     * first: the server has given up on the request, so it is skipped ({@link #bulk} methods are
     * all {@link #readOnly}).
     */
    static boolean takeSlot(Semaphore slots, long deadlineNanos) throws InterruptedException {
        long wait = deadlineNanos - System.nanoTime();
        return wait > 0 && slots.tryAcquire(wait, TimeUnit.NANOSECONDS);
    }

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

    /**
     * Methods whose reply can be megabytes, or that decode an image (`thumbnail`: a small reply,
     * but a camera original decoded, down-sampled, into a bitmap): they run in the drive's bulk
     * lane and take a bulk slot.
     */
    static boolean bulk(String method) {
        switch (method == null ? "" : method) {
            case "read":
            case "download-chunk":
            case "handoff-read":
            case "yjs-read":
            case "thumbnail":
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
            case "thumbnail":          // writes only the app's own thumbnail cache, never the folder
            case "yjs-read":
            case "yjs-stats":
                return true;
            default:
                return false;
        }
    }

    /**
     * Requests skipped when still queued at their deadline: every {@link #readOnly} method, and
     * `agent-ask`. A question the server has stopped waiting for is not answered late: in read
     * mode that is work (maybe the image model loaded) nobody reads, and in act mode it would collect or move files
     * for an owner who was already told the question timed out.
     */
    static boolean skipWhenExpired(String method) {
        return readOnly(method) || "agent-ask".equals(method);
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
