package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.Test;

/**
 * The send gate keeps a socket's queue under OkHttp's 16 MiB close-on-overflow limit, never
 * holds its lock while waiting, and never admits a reply after its deadline.
 */
public class SendGateTest {
    static final long MIB = 1024 * 1024;

    /** A socket whose queue drains by `drainPerPoll` bytes each time it is asked. */
    static final class FakeSocket implements SendGate.Socket {
        final AtomicLong queued = new AtomicLong();
        final long drainPerPoll;
        final List<String> sent = Collections.synchronizedList(new ArrayList<>());
        volatile boolean accept = true;
        volatile long peak;

        FakeSocket(long queued, long drainPerPoll) { this.queued.set(queued); this.drainPerPoll = drainPerPoll; }

        @Override public long queueSize() { return queued.getAndUpdate(q -> Math.max(0, q - drainPerPoll)); }

        @Override public synchronized boolean send(String text) {
            if (!accept) return false;
            long now = queued.addAndGet(text.getBytes(StandardCharsets.UTF_8).length);
            peak = Math.max(peak, now);
            // What OkHttp does: over the limit the socket is closed and the message refused.
            assertTrue("queue passed OkHttp's limit: " + now, now <= SendGate.OKHTTP_QUEUE_LIMIT);
            sent.add(text);
            return true;
        }
    }

    /** Time that moves only when the gate sleeps (or the test says so). */
    static final class FakeClock implements SendGate.Clock {
        long now = 1_000_000_000L;
        @Override public long nanoTime() { return now; }
        @Override public void sleepMs(long ms) { now += ms * 1_000_000L; }
        void advanceMs(long ms) { now += ms * 1_000_000L; }
        long in(long ms) { return now + ms * 1_000_000L; }
    }

    /**
     * OkHttp's queue on a link of `bytesPerSecond`: one writer, messages leave whole and in
     * order, and a message is off the queue only once its last byte is written.
     */
    static final class LinkSocket implements SendGate.Socket {
        final FakeClock clock;
        final double bytesPerNs;
        final List<long[]> messages = new ArrayList<>();   // {bytes, doneAtNs}
        long writerFreeAt;
        long peak;

        LinkSocket(FakeClock clock, double bytesPerSecond) { this.clock = clock; this.bytesPerNs = bytesPerSecond / 1e9; }

        @Override public long queueSize() {
            long q = 0;
            for (long[] m : messages) if (m[1] > clock.now) q += m[0];
            return q;
        }

        @Override public boolean send(String text) {
            long bytes = text.length();                     // ASCII in these tests
            long start = Math.max(clock.now, writerFreeAt);
            writerFreeAt = start + (long) (bytes / bytesPerNs);
            messages.add(new long[]{bytes, writerFreeAt});
            peak = Math.max(peak, queueSize());
            assertTrue(queueSize() <= SendGate.OKHTTP_QUEUE_LIMIT);
            return true;
        }

        /** When the last byte of message `i` leaves the phone. */
        long doneAt(int i) { return messages.get(i)[1]; }
    }

    private static String ascii(long bytes) {
        char[] c = new char[(int) bytes];
        java.util.Arrays.fill(c, 'a');
        return new String(c);
    }

    private static long in(long ms) { return System.nanoTime() + ms * 1_000_000L; }

    private static long msSince(long t0) { return (System.nanoTime() - t0) / 1_000_000L; }

    // ------------------------------------------------------------ room in the queue

    @Test
    public void sendsAtOnceWhenThereIsRoom() throws Exception {
        FakeSocket s = new FakeSocket(0, 0);
        assertEquals(SendGate.Result.SENT, new SendGate(1).send(s, "{\"ok\":true}", in(1000), () -> true));
        assertEquals(1, s.sent.size());
    }

    @Test
    public void refusesOneMessageTooLargeForTheSocket() throws Exception {
        FakeSocket s = new FakeSocket(0, 0);
        String big = ascii(SendGate.MAX_MESSAGE_BYTES + 1);
        assertEquals(SendGate.Result.TOO_LARGE, new SendGate(1).send(s, big, in(1000), () -> true));
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void anEightMebibyteReadFitsInOneFrame() {
        // read's cap is 8 MiB of bytes → base64 (4/3) plus the JSON around it.
        long frame = (8L * MIB + 2) / 3 * 4 + 512;
        assertTrue(SendGate.fits(0, frame));
    }

    @Test
    public void waitsForTheQueueToDrainInsteadOfOverflowingIt() throws Exception {
        // 10 MiB still queued; another 5 MiB would make 15 MiB: over budget, so it waits.
        FakeSocket s = new FakeSocket(10L * MIB, MIB);
        assertEquals(SendGate.Result.SENT, new SendGate(1).send(s, ascii(5L * MIB), in(5000), () -> true));
        assertTrue(s.peak <= SendGate.QUEUE_BUDGET_BYTES);
    }

    @Test
    public void backToBackBigResponsesNeverPassTheLimit() throws Exception {
        // Four 8 MiB reads answered at once on a slow link: without the gate, the second one
        // would already have closed the socket.
        FakeSocket s = new FakeSocket(0, 2L * MIB);
        SendGate gate = new SendGate(1);
        String eleven = ascii(11L * MIB);
        for (int i = 0; i < 4; i++) assertEquals(SendGate.Result.SENT, gate.send(s, eleven, in(5000), () -> true));
        assertEquals(4, s.sent.size());
        assertTrue(s.peak <= SendGate.QUEUE_BUDGET_BYTES);
    }

    @Test
    public void smallRepliesUseTheHeadroomAboveTheBigBudget() {
        long big = SendGate.QUEUE_BUDGET_BYTES;
        assertTrue(SendGate.fits(big, 1024));                          // a list behind a full queue of reads
        assertFalse(SendGate.fits(big, 2 * MIB));                      // another read is not
        assertTrue(SendGate.fits(SendGate.SMALL_BUDGET_BYTES - 10, 10));
        assertFalse(SendGate.fits(SendGate.SMALL_BUDGET_BYTES - 10, 11));
        assertTrue(SendGate.fits(0, SendGate.MAX_MESSAGE_BYTES));
        assertFalse(SendGate.fits(0, SendGate.MAX_MESSAGE_BYTES + 1));
        assertTrue(SendGate.fits(SendGate.QUEUE_BUDGET_BYTES - 2 * MIB, 2 * MIB));
        assertFalse(SendGate.fits(SendGate.QUEUE_BUDGET_BYTES - 2 * MIB, 2 * MIB + 1));
        // Whatever mix is admitted, the queue stays under OkHttp's limit.
        assertTrue(SendGate.SMALL_BUDGET_BYTES < SendGate.OKHTTP_QUEUE_LIMIT);
        assertTrue(SendGate.QUEUE_BUDGET_BYTES + SendGate.SMALL_MESSAGE_BYTES <= SendGate.SMALL_BUDGET_BYTES);
        assertTrue(SendGate.MAX_MESSAGE_BYTES <= SendGate.QUEUE_BUDGET_BYTES);
    }

    @Test
    public void manyConcurrentSendersNeverPassTheBudget() throws Exception {
        FakeSocket s = new FakeSocket(0, 256 * 1024);
        SendGate gate = new SendGate(1);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        List<Future<SendGate.Result>> out = new ArrayList<>();
        String five = ascii(5L * MIB), small = ascii(900 * 1024);
        long deadline = in(20_000);
        for (int i = 0; i < 24; i++) {
            String msg = i % 3 == 0 ? small : five;
            out.add(pool.submit(() -> gate.send(s, msg, deadline, () -> true)));
        }
        for (Future<SendGate.Result> f : out) assertEquals(SendGate.Result.SENT, f.get(30, TimeUnit.SECONDS));
        pool.shutdownNow();
        assertTrue(s.peak <= SendGate.SMALL_BUDGET_BYTES);
    }

    // ------------------------------------------------------------ waiting without the lock

    @Test
    public void aSmallReplyGoesOutWhileABigOneWaits() throws Exception {
        FakeSocket s = new FakeSocket(11L * MIB, 0);          // stalled with one big read queued
        SendGate gate = new SendGate(5);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        Future<SendGate.Result> big = pool.submit(() -> gate.send(s, ascii(5L * MIB), in(1500), () -> true));
        Thread.sleep(100);                                      // the big one is waiting now
        long t0 = System.nanoTime();
        assertEquals(SendGate.Result.SENT, gate.send(s, "{\"method\":\"list\"}", in(1500), () -> true));
        assertTrue("a small reply waited " + msSince(t0) + " ms behind a big one", msSince(t0) < 200);
        assertFalse(big.isDone());
        assertEquals(SendGate.Result.TIMED_OUT, big.get(5, TimeUnit.SECONDS));
        pool.shutdownNow();
    }

    @Test
    public void concurrentSendersShareTheirDeadlineInsteadOfQueueingForTheLock() throws Exception {
        // Nothing fits: every sender must give up at ITS deadline, not one after another.
        FakeSocket s = new FakeSocket(SendGate.SMALL_BUDGET_BYTES, 0);
        SendGate gate = new SendGate(5);
        ExecutorService pool = Executors.newFixedThreadPool(3);
        long t0 = System.nanoTime(), deadline = in(300);
        List<Future<Long>> elapsed = new ArrayList<>();
        for (int i = 0; i < 3; i++) elapsed.add(pool.submit(() -> {
            assertEquals(SendGate.Result.TIMED_OUT, gate.send(s, ascii(MIB), deadline, () -> true));
            return msSince(t0);
        }));
        for (Future<Long> f : elapsed) {
            long ms = f.get(5, TimeUnit.SECONDS);
            assertTrue("gave up after " + ms + " ms", ms >= 290 && ms < 600);
        }
        pool.shutdownNow();
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void theDeadlineCountsTimeBeforeTheCall() throws Exception {
        // A request that waited for a worker until its deadline is not sent, even into an empty queue.
        FakeSocket s = new FakeSocket(0, 0);
        assertEquals(SendGate.Result.TIMED_OUT, new SendGate(1).send(s, "{}", System.nanoTime() - 1, () -> true));
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void givesUpWhenTheLinkStalls() throws Exception {
        FakeSocket s = new FakeSocket(12L * MIB, 0);
        long t0 = System.nanoTime();
        assertEquals(SendGate.Result.TIMED_OUT, new SendGate(5).send(s, ascii(MIB + 1), in(60), () -> true));
        assertTrue(msSince(t0) >= 59);
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void stopsWaitingOnADeadSocket() throws Exception {
        FakeSocket s = new FakeSocket(12L * MIB, 0);
        assertEquals(SendGate.Result.CLOSED, new SendGate(1).send(s, ascii(MIB + 1), in(60_000), () -> false));
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void reportsARefusedSend() throws Exception {
        FakeSocket s = new FakeSocket(0, 0);
        s.accept = false;
        assertEquals(SendGate.Result.REFUSED, new SendGate(1).send(s, "x", in(1000), () -> true));
    }

    // ------------------------------------------------------------ drain rate

    @Test
    public void aReplyThatWouldArriveAfterTheDeadlineIsDroppedOnceTheRateIsKnown() throws Exception {
        FakeClock clock = new FakeClock();
        LinkSocket link = new LinkSocket(clock, 500_000);           // 0.5 MB/s uplink
        SendGate gate = new SendGate(25, clock);
        String eleven = ascii(11_000_000);
        long deadline = clock.in(23_000);                          // a 25 s server timeout, less the margin

        // Unknown rate: the first read goes out at once (and does reach the server in 22 s).
        assertEquals(SendGate.Result.SENT, gate.send(link, eleven, deadline, () -> true));
        assertTrue(link.doneAt(0) <= deadline);
        // The second waits for room; when the first has drained (22 s) the rate is known, and at
        // 0.5 MB/s it would finish at 44 s — long after the server gave up — so it is dropped.
        assertEquals(SendGate.Result.LATE, gate.send(link, eleven, deadline, () -> true));
        assertEquals(1, link.messages.size());
        assertEquals(500_000, gate.bytesPerSecond(), 5_000);
        // A third, same deadline: dropped at once, not after waiting.
        long before = clock.now;
        assertEquals(SendGate.Result.LATE, gate.send(link, eleven, deadline, () -> true));
        assertEquals(before, clock.now);
        // A small reply still makes it.
        assertEquals(SendGate.Result.SENT, gate.send(link, "{\"method\":\"list\"}", clock.in(23_000), () -> true));
    }

    @Test
    public void aRateMeasuredLowDoesNotDropAReplyThatWouldMakeIt() throws Exception {
        FakeClock clock = new FakeClock();
        SendGate gate = new SendGate(25, clock);
        // Time the link at 0.5 MB/s: a second 7 MB reply waits for the first to drain.
        LinkSocket slow = new LinkSocket(clock, 500_000);
        String seven = ascii(7_000_000);
        assertEquals(SendGate.Result.SENT, gate.send(slow, seven, clock.in(60_000), () -> true));
        assertEquals(SendGate.Result.SENT, gate.send(slow, seven, clock.in(60_000), () -> true));
        assertEquals(500_000, gate.bytesPerSecond(), 5_000);

        // The link is really 0.7 MB/s (the measurement came out ~30% low). An 11 MB reply due in
        // 18 s would take 22 s at the measured rate, but leaves in under 16 s: it is sent, and
        // it is out before its deadline.
        LinkSocket fast = new LinkSocket(clock, 700_000);
        long deadline = clock.in(18_000);
        assertEquals(SendGate.Result.SENT, gate.send(fast, ascii(11_000_000), deadline, () -> true));
        assertTrue(fast.doneAt(0) <= deadline);

        // Past the slack it is still dropped: 11 MB due in 10 s needs 1.5 × the measured rate and more.
        LinkSocket other = new LinkSocket(clock, 700_000);
        assertEquals(SendGate.Result.LATE, gate.send(other, ascii(11_000_000), clock.in(10_000), () -> true));
        assertTrue(other.messages.isEmpty());
    }

    /**
     * A slow patch is timed, then the link recovers while the socket sits idle. Only big messages
     * are timed and a LATE one is never sent, so without the idle rule the old rate would drop
     * every big reply for the rest of its minute. Within RATE_IDLE_FRESH_NS it still counts; after
     * it the reply goes out (and makes its deadline), timing the link again. With a backlog
     * queued the full window still applies.
     */
    @Test
    public void anIdleSocketRetimesAStaleLowRate() throws Exception {
        FakeClock clock = new FakeClock();
        SendGate gate = new SendGate(25, clock);
        LinkSocket slow = new LinkSocket(clock, 200_000);            // a slow patch: 0.2 MB/s
        String seven = ascii(7_000_000);
        assertEquals(SendGate.Result.SENT, gate.send(slow, seven, clock.in(120_000), () -> true));
        assertEquals(SendGate.Result.SENT, gate.send(slow, seven, clock.in(120_000), () -> true));
        assertEquals(200_000, gate.bytesPerSecond(), 2_000);

        // The same uplink, recovered to 5 MB/s, idle 5 s after the measurement: still trusted
        // (11 MB due in 23 s needs more than 1.5 × 0.2 MB/s).
        LinkSocket fast = new LinkSocket(clock, 5_000_000);
        clock.advanceMs(5_000);
        String eleven = ascii(11_000_000);
        assertEquals(SendGate.Result.LATE, gate.send(fast, eleven, clock.in(23_000), () -> true));
        assertTrue(fast.messages.isEmpty());

        // Idle past RATE_IDLE_FRESH_NS (the rate is still inside its 60 s): sent, and in time.
        clock.advanceMs(SendGate.RATE_IDLE_FRESH_NS / 1_000_000);
        assertTrue("still fresh by the 60 s rule", gate.bytesPerSecond() > 0);
        long deadline = clock.in(23_000);
        assertEquals(SendGate.Result.SENT, gate.send(fast, eleven, deadline, () -> true));
        assertTrue(fast.doneAt(0) <= deadline);

        // A second one right behind it: the queue is not idle, so the measured rate still decides.
        long before = clock.now;
        assertEquals(SendGate.Result.LATE, gate.send(fast, eleven, clock.in(23_000), () -> true));
        assertEquals("written off at once, not after waiting", before, clock.now);
        assertEquals(1, fast.messages.size());
    }

    @Test
    public void withoutAMeasuredRateOnlyTheDeadlineCounts() throws Exception {
        FakeClock clock = new FakeClock();
        LinkSocket link = new LinkSocket(clock, 500_000);
        SendGate gate = new SendGate(25, clock);
        // Would take 22 s, deadline in 5 s: with nothing measured yet it is sent, as before.
        assertEquals(SendGate.Result.SENT, gate.send(link, ascii(11_000_000), clock.in(5_000), () -> true));
        assertEquals(0, gate.bytesPerSecond(), 0);
    }

    @Test
    public void aDrainNobodyWatchedIsNotTimed() throws Exception {
        FakeClock clock = new FakeClock();
        LinkSocket link = new LinkSocket(clock, 500_000);
        SendGate gate = new SendGate(25, clock);
        assertEquals(SendGate.Result.SENT, gate.send(link, ascii(11_000_000), clock.in(30_000), () -> true));
        clock.advanceMs(40_000);                                   // it drained at 22 s; nobody looked
        assertEquals(SendGate.Result.SENT, gate.send(link, ascii(11_000_000), clock.in(5_000), () -> true));
        assertEquals("a drain seen only afterwards says nothing about the rate", 0, gate.bytesPerSecond(), 0);
    }

    @Test
    public void shortDrainsAreNotTimed() throws Exception {
        FakeClock clock = new FakeClock();
        LinkSocket link = new LinkSocket(clock, 50_000_000);        // fast: 1 MB leaves in 20 ms
        SendGate gate = new SendGate(25, clock);
        for (int i = 0; i < 3; i++) assertEquals(SendGate.Result.SENT, gate.send(link, ascii(1_000_000), clock.in(23_000), () -> true));
        // Watched closely while all three drain (60 ms): too short a span to say anything.
        for (int i = 0; i < 8; i++) {
            clock.advanceMs(15);
            assertEquals(SendGate.Result.SENT, gate.send(link, "{}", clock.in(23_000), () -> true));
        }
        assertTrue(link.doneAt(2) <= clock.now);                    // all three drained while watched
        assertEquals(0, gate.bytesPerSecond(), 0);
    }

    @Test
    public void aStaleRateIsForgottenAndResetForgetsTheSocket() throws Exception {
        FakeClock clock = new FakeClock();
        LinkSocket link = new LinkSocket(clock, 500_000);
        SendGate gate = new SendGate(25, clock);
        String seven = ascii(7_000_000);
        assertEquals(SendGate.Result.SENT, gate.send(link, seven, clock.in(60_000), () -> true));
        // No room for a second 7 MB: it waits 14 s for the first to drain, which times the link.
        assertEquals(SendGate.Result.SENT, gate.send(link, seven, clock.in(60_000), () -> true));
        assertEquals(500_000, gate.bytesPerSecond(), 5_000);
        clock.advanceMs(SendGate.RATE_FRESH_NS / 1_000_000 + 1_000);
        assertEquals(0, gate.bytesPerSecond(), 0);

        assertEquals(SendGate.Result.SENT, gate.send(link, seven, clock.in(60_000), () -> true));
        assertEquals(SendGate.Result.SENT, gate.send(link, seven, clock.in(60_000), () -> true));
        assertTrue(gate.bytesPerSecond() > 0);
        gate.reset();
        assertEquals(0, gate.bytesPerSecond(), 0);
    }

    // ------------------------------------------------------------ sizes

    @Test
    public void utf8LengthMatchesTheEncoderAndNeverUndercounts() {
        for (String s : new String[]{"", "ascii", "é", "사진", "📷 photo", "a\u0000b", "{\"answer\":\"도쿄에서 찍은 사진 3장\"}"}) {
            assertEquals(s, s.getBytes(StandardCharsets.UTF_8).length, SendGate.utf8Length(s));
        }
        String lone = "x\uD83D";   // an unpaired high surrogate: the encoder writes '?' (1 byte)
        assertTrue(SendGate.utf8Length(lone) >= lone.getBytes(StandardCharsets.UTF_8).length);
    }
}
