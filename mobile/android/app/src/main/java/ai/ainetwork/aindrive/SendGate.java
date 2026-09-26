package ai.ainetwork.aindrive;

import java.util.function.BooleanSupplier;

/**
 * Keeps one drive socket's outgoing queue bounded, so a big RPC response can't
 * make OkHttp tear the socket down.
 *
 * OkHttp's WebSocket.send() never blocks: it queues the message and, if the
 * queue would pass 16 MiB, closes the socket (code 1001) and returns false. A
 * few 8 MiB reads answered back to back on a slow uplink do exactly that, and
 * the drive drops offline mid-transfer. So every frame of a socket goes
 * through one gate that:
 *  - refuses a single message over {@link #MAX_MESSAGE_BYTES} (the caller
 *    answers with a short error instead),
 *  - waits, polling queueSize(), until the message fits under
 *    {@link #QUEUE_BUDGET_BYTES} — the RPC thread holding the response is the
 *    backpressure, and at most one message is being admitted at a time,
 *  - reports send()'s own return value instead of ignoring it.
 *
 * Pure (no Android or OkHttp types) so it is unit-tested on the JVM.
 */
final class SendGate {
    /** OkHttp closes a web socket whose queue would pass this (RealWebSocket.MAX_QUEUE_SIZE). */
    static final long OKHTTP_QUEUE_LIMIT = 16L * 1024 * 1024;
    /**
     * Admit a message only while queued + message stays under this; an empty queue always
     * admits one message (≤ MAX_MESSAGE_BYTES). 4 MiB below OkHttp's limit.
     */
    static final long QUEUE_BUDGET_BYTES = 12L * 1024 * 1024;
    /** The largest single frame: an 8 MiB read is ≈ 11.2 MB of base64 plus JSON, and fits. */
    static final long MAX_MESSAGE_BYTES = 12L * 1024 * 1024;

    interface Socket {
        /** Bytes queued but not yet written (OkHttp WebSocket.queueSize()). */
        long queueSize();
        /** False when the socket refused the message (closing, failed, or its queue overflowed). */
        boolean send(String text);
    }

    enum Result {
        SENT,
        /** The message alone is over MAX_MESSAGE_BYTES: nothing was sent. */
        TOO_LARGE,
        /** The queue did not drain in time: nothing was sent (the link is stalled). */
        TIMED_OUT,
        /** The socket was closed or replaced while waiting: nothing was sent. */
        CLOSED,
        /** send() returned false: the socket is closing; nothing was sent. */
        REFUSED,
    }

    private final Object lock = new Object();
    private final long pollMs;

    SendGate() { this(25); }

    SendGate(long pollMs) { this.pollMs = pollMs; }

    /** True when a message of `bytes` may join a queue holding `queued` bytes. */
    static boolean fits(long queued, long bytes) {
        return bytes <= MAX_MESSAGE_BYTES && (queued <= 0 || queued + bytes <= QUEUE_BUDGET_BYTES);
    }

    /**
     * Send `text` once there is room. Blocks the calling thread (an RPC worker) for up to
     * `timeoutMs` while the queue drains; `open` is polled so a dead socket isn't waited on.
     */
    Result send(Socket socket, String text, long timeoutMs, BooleanSupplier open) throws InterruptedException {
        long bytes = utf8Length(text);
        if (bytes > MAX_MESSAGE_BYTES) return Result.TOO_LARGE;
        synchronized (lock) {
            long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
            while (!fits(socket.queueSize(), bytes)) {
                if (!open.getAsBoolean()) return Result.CLOSED;
                if (System.nanoTime() - deadline >= 0) return Result.TIMED_OUT;
                Thread.sleep(pollMs);
            }
            if (!open.getAsBoolean()) return Result.CLOSED;
            return socket.send(text) ? Result.SENT : Result.REFUSED;
        }
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
