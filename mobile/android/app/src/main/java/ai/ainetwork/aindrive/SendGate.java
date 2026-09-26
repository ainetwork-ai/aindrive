package ai.ainetwork.aindrive;

import java.util.function.BooleanSupplier;

/**
 * Keeps one drive socket's outgoing queue bounded, so a big RPC response can't
 * make OkHttp tear the socket down, and keeps a reply from going out after the
 * server has stopped waiting for it.
 *
 * OkHttp's WebSocket.send() never blocks: it queues the message and, if the
 * queue would pass 16 MiB, closes the socket (code 1001) and returns false. A
 * few 8 MiB reads answered back to back on a slow uplink do exactly that, and
 * the drive drops offline mid-transfer. So every response of a socket goes
 * through one gate that:
 *  - refuses a single message over {@link #MAX_MESSAGE_BYTES} (the caller
 *    answers with a short error instead);
 *  - admits a message only while the queue has room: a big one while queued +
 *    message stays under {@link #QUEUE_BUDGET_BYTES}, a small one (a list, a
 *    stat, an error — up to {@link #SMALL_MESSAGE_BYTES}) up to
 *    {@link #SMALL_BUDGET_BYTES}, so small replies never wait for a big read
 *    to drain (they still leave after it: the socket is one FIFO); an empty
 *    queue always admits one message;
 *  - waits OUTSIDE its lock: the lock covers only the check and the send, so a
 *    message that fits goes out at once, however many others are waiting;
 *  - gives up at `deadlineNanos`, which the caller fixes when the request
 *    ARRIVED (see {@link RpcBudget}), so time spent queued for a worker and
 *    time spent waiting here both count;
 *  - once it has timed how fast this socket drains, also gives up early (LATE)
 *    on a message that would still be leaving the phone after the deadline even
 *    were the link {@link #LATE_RATE_SLACK}× faster than measured — the uplink
 *    is better spent on replies the server still wants, but a measurement that
 *    came out low must not cost a reply that would have made it;
 *  - reports send()'s own return value instead of ignoring it.
 *
 * The agent-hello is the one frame sent around the gate: it is the first frame
 * on a fresh socket, whose queue is empty.
 *
 * Pure (no Android or OkHttp types) so it is unit-tested on the JVM.
 */
final class SendGate {
    /** OkHttp closes a web socket whose queue would pass this (RealWebSocket.MAX_QUEUE_SIZE). */
    static final long OKHTTP_QUEUE_LIMIT = 16L * 1024 * 1024;
    /**
     * A big message is admitted only while queued + message stays under this; an empty queue
     * always admits one message (≤ MAX_MESSAGE_BYTES).
     */
    static final long QUEUE_BUDGET_BYTES = 12L * 1024 * 1024;
    /** A message this small is a reply like list/stat/an error: it may use the headroom above the budget. */
    static final long SMALL_MESSAGE_BYTES = 1024 * 1024;
    /** Small messages are admitted up to this — still 1 MiB under OkHttp's limit. */
    static final long SMALL_BUDGET_BYTES = 15L * 1024 * 1024;
    /** The largest single frame: an 8 MiB read is ≈ 11.2 MB of base64 plus JSON, and fits. */
    static final long MAX_MESSAGE_BYTES = 12L * 1024 * 1024;

    /** A drain is timed only when it lasted at least this long (shorter spans are mostly polling noise)… */
    static final long RATE_MIN_SPAN_NS = 500_000_000L;
    /** …and was watched by senders polling at least this often (otherwise when it happened is unknown). */
    static final long WATCH_GAP_NS = 200_000_000L;
    /** A drain rate older than this is not used: the phone may have changed networks. */
    static final long RATE_FRESH_NS = 60_000_000_000L;
    /**
     * A message is written off as LATE only if it would still be leaving after the deadline at
     * this multiple of the measured rate. The measurement can come out low: a drain is noticed
     * up to {@link #WATCH_GAP_NS} after it happened (up to ~30% slow on the shortest timed span),
     * the kernel's send buffer hides where a message really is, and links vary. A wrong LATE
     * drops a reply the server still wants; a wrong send only spends some uplink, and the
     * deadline still bounds how long anything waits for room.
     */
    static final double LATE_RATE_SLACK = 1.5;

    interface Socket {
        /** Bytes queued but not yet written (OkHttp WebSocket.queueSize()). */
        long queueSize();
        /** False when the socket refused the message (closing, failed, or its queue overflowed). */
        boolean send(String text);
    }

    /** Time and sleep, replaceable in tests. */
    interface Clock {
        long nanoTime();
        void sleepMs(long ms) throws InterruptedException;
    }

    static final Clock SYSTEM_CLOCK = new Clock() {
        @Override public long nanoTime() { return System.nanoTime(); }
        @Override public void sleepMs(long ms) throws InterruptedException { Thread.sleep(ms); }
    };

    enum Result {
        SENT,
        /** The message alone is over MAX_MESSAGE_BYTES: nothing was sent. */
        TOO_LARGE,
        /** The deadline passed before there was room: nothing was sent (the link is stalled or busy). */
        TIMED_OUT,
        /** At the measured drain rate it would still be leaving after the deadline: nothing was sent. */
        LATE,
        /** The socket was closed or replaced while waiting: nothing was sent. */
        CLOSED,
        /** send() returned false: the socket is closing; nothing was sent. */
        REFUSED,
    }

    private final Object lock = new Object();
    private final long pollMs;
    private final Clock clock;

    // How fast the queue drains, timed from what the senders see (all guarded by `lock`).
    /** Queue size after the last look or send. */
    private long lastQueued;
    /** When the queue was last looked at (0 = never). */
    private long lastLookNs;
    /** True while the writer is known to have been busy since drainStartNs. */
    private boolean timing;
    private long drainStartNs;
    private long drainedBytes;
    /** Measured drain rate (EWMA of bytes/ns); 0 = not measured. */
    private double bytesPerNs;
    private long rateAtNs;

    SendGate() { this(25, SYSTEM_CLOCK); }

    SendGate(long pollMs) { this(pollMs, SYSTEM_CLOCK); }

    SendGate(long pollMs, Clock clock) {
        this.pollMs = pollMs;
        this.clock = clock;
    }

    /** True when a message of `bytes` may join a queue holding `queued` bytes. */
    static boolean fits(long queued, long bytes) {
        if (bytes > MAX_MESSAGE_BYTES) return false;
        if (queued <= 0) return true;
        return queued + bytes <= (bytes <= SMALL_MESSAGE_BYTES ? SMALL_BUDGET_BYTES : QUEUE_BUDGET_BYTES);
    }

    /**
     * Send `text` once there is room, before `deadlineNanos` (a {@link Clock#nanoTime()} value).
     * Blocks the calling thread (one of this drive's RPC workers) while the queue drains, without
     * holding the lock; `open` is checked on every look so a dead socket isn't waited on.
     */
    Result send(Socket socket, String text, long deadlineNanos, BooleanSupplier open) throws InterruptedException {
        long bytes = utf8Length(text);
        if (bytes > MAX_MESSAGE_BYTES) return Result.TOO_LARGE;
        while (true) {
            synchronized (lock) {
                if (!open.getAsBoolean()) return Result.CLOSED;
                long now = clock.nanoTime();
                long queued = look(socket.queueSize(), now);
                if (now - deadlineNanos >= 0) return Result.TIMED_OUT;
                if (lateAt(now, queued, bytes, deadlineNanos)) return Result.LATE;
                if (fits(queued, bytes)) {
                    if (!socket.send(text)) return Result.REFUSED;
                    sent(queued, bytes, now);
                    return Result.SENT;
                }
            }
            clock.sleepMs(pollMs);
        }
    }

    /** A new socket starts with an empty queue: forget the last one's (a different network, maybe). */
    void reset() {
        synchronized (lock) {
            lastQueued = 0;
            lastLookNs = 0;
            timing = false;
            bytesPerNs = 0;
        }
    }

    /** The measured drain rate in bytes per second, or 0 when there is none (tests, logs). */
    double bytesPerSecond() {
        synchronized (lock) { return fresh(clock.nanoTime()) ? bytesPerNs * 1e9 : 0; }
    }

    // ------------------------------------------------------------ drain timing

    /**
     * Record one look at the queue. OkHttp takes a message off the queue only when it has been
     * written out whole, so a drop in the size marks the end of a message; with the writer busy
     * the whole time and someone looking often enough, bytes drained ÷ time is the uplink's rate.
     */
    private long look(long queued, long now) {
        boolean watched = lastLookNs != 0 && now - lastLookNs <= WATCH_GAP_NS;
        if (queued < lastQueued) {
            if (timing && watched) {
                drainedBytes += lastQueued - queued;
                long span = now - drainStartNs;
                if (span >= RATE_MIN_SPAN_NS) {
                    double r = (double) drainedBytes / span;
                    bytesPerNs = fresh(now) ? (bytesPerNs + r) / 2 : r;
                    rateAtNs = now;
                    drainStartNs = now;         // the next message started as this one ended
                    drainedBytes = 0;
                }
            } else {
                // Nobody was watching when it happened: time from here, the start of the next message.
                timing = true;
                drainStartNs = now;
                drainedBytes = 0;
            }
        }
        if (queued <= 0) timing = false;          // idle writer: nothing to time until the next send
        lastQueued = queued;
        lastLookNs = now;
        return queued;
    }

    private void sent(long queuedBefore, long bytes, long now) {
        if (queuedBefore <= 0) {                 // the writer starts on it now
            timing = true;
            drainStartNs = now;
            drainedBytes = 0;
        }
        lastQueued = queuedBefore + bytes;
        lastLookNs = now;
    }

    private boolean fresh(long now) { return bytesPerNs > 0 && now - rateAtNs <= RATE_FRESH_NS; }

    /**
     * With a measured rate: would the queue ahead plus this message still be leaving at the
     * deadline, even at {@link #LATE_RATE_SLACK} times that rate?
     */
    private boolean lateAt(long now, long queued, long bytes, long deadlineNanos) {
        if (!fresh(now)) return false;
        double leaves = now + (Math.max(0, queued) + bytes) / (bytesPerNs * LATE_RATE_SLACK);
        return leaves > deadlineNanos;
    }

    /**
     * UTF-8 size of `s` without encoding it. Never under-counts: an unpaired surrogate counts
     * as 3 bytes (OkHttp writes it as a 1-byte '?').
     */
    static long utf8Length(String s) {
        long n = 0;
        for (int i = 0, len = s.length(); i < len; i++) {
            char c = s.charAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (Character.isHighSurrogate(c) && i + 1 < len && Character.isLowSurrogate(s.charAt(i + 1))) { n += 4; i++; }
            else n += 3;
        }
        return n;
    }
}
