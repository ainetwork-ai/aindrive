package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.Test;

/** The send gate keeps a socket's queue under OkHttp's 16 MiB close-on-overflow limit. */
public class SendGateTest {
    /** A socket whose queue drains by `drainPerPoll` bytes each time it is asked. */
    static final class FakeSocket implements SendGate.Socket {
        final AtomicLong queued = new AtomicLong();
        final long drainPerPoll;
        final List<String> sent = new ArrayList<>();
        boolean accept = true;
        long peak;

        FakeSocket(long queued, long drainPerPoll) { this.queued.set(queued); this.drainPerPoll = drainPerPoll; }

        @Override public long queueSize() { return queued.getAndUpdate(q -> Math.max(0, q - drainPerPoll)); }

        @Override public boolean send(String text) {
            if (!accept) return false;
            long now = queued.addAndGet(text.getBytes(StandardCharsets.UTF_8).length);
            peak = Math.max(peak, now);
            // What OkHttp does: over the limit the socket is closed and the message refused.
            assertTrue("queue passed OkHttp's limit: " + now, now <= SendGate.OKHTTP_QUEUE_LIMIT);
            sent.add(text);
            return true;
        }
    }

    private static String ascii(long bytes) {
        StringBuilder sb = new StringBuilder((int) bytes);
        for (long i = 0; i < bytes; i++) sb.append('a');
        return sb.toString();
    }

    @Test
    public void sendsAtOnceWhenThereIsRoom() throws Exception {
        FakeSocket s = new FakeSocket(0, 0);
        assertEquals(SendGate.Result.SENT, new SendGate(1).send(s, "{\"ok\":true}", 1000, () -> true));
        assertEquals(1, s.sent.size());
    }

    @Test
    public void refusesOneMessageTooLargeForTheSocket() throws Exception {
        FakeSocket s = new FakeSocket(0, 0);
        String big = ascii(SendGate.MAX_MESSAGE_BYTES + 1);
        assertEquals(SendGate.Result.TOO_LARGE, new SendGate(1).send(s, big, 1000, () -> true));
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void anEightMebibyteReadFitsInOneFrame() {
        // read's cap is 8 MiB of bytes → base64 (4/3) plus the JSON around it.
        long frame = (8L * 1024 * 1024 + 2) / 3 * 4 + 512;
        assertTrue(SendGate.fits(0, frame));
    }

    @Test
    public void waitsForTheQueueToDrainInsteadOfOverflowingIt() throws Exception {
        // 10 MiB still queued; another 5 MiB would make 15 MiB: over budget, so it waits.
        FakeSocket s = new FakeSocket(10L * 1024 * 1024, 1024 * 1024);
        String five = ascii(5L * 1024 * 1024);
        assertEquals(SendGate.Result.SENT, new SendGate(1).send(s, five, 5000, () -> true));
        assertTrue(s.peak <= SendGate.QUEUE_BUDGET_BYTES);
    }

    @Test
    public void backToBackBigResponsesNeverPassTheLimit() throws Exception {
        // Four 8 MiB reads answered at once on a slow link: without the gate, the second one
        // would already have closed the socket.
        FakeSocket s = new FakeSocket(0, 2L * 1024 * 1024);
        SendGate gate = new SendGate(1);
        String eleven = ascii(11L * 1024 * 1024);
        for (int i = 0; i < 4; i++) assertEquals(SendGate.Result.SENT, gate.send(s, eleven, 5000, () -> true));
        assertEquals(4, s.sent.size());
        assertTrue(s.peak <= SendGate.OKHTTP_QUEUE_LIMIT);
    }

    @Test
    public void givesUpWhenTheLinkStalls() throws Exception {
        FakeSocket s = new FakeSocket(12L * 1024 * 1024, 0);
        long t0 = System.nanoTime();
        assertEquals(SendGate.Result.TIMED_OUT, new SendGate(5).send(s, ascii(1024 * 1024), 60, () -> true));
        assertTrue((System.nanoTime() - t0) / 1_000_000 >= 60);
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void stopsWaitingOnADeadSocket() throws Exception {
        FakeSocket s = new FakeSocket(12L * 1024 * 1024, 0);
        assertEquals(SendGate.Result.CLOSED, new SendGate(1).send(s, ascii(1024 * 1024), 60_000, () -> false));
        assertTrue(s.sent.isEmpty());
    }

    @Test
    public void reportsARefusedSend() throws Exception {
        FakeSocket s = new FakeSocket(0, 0);
        s.accept = false;
        assertEquals(SendGate.Result.REFUSED, new SendGate(1).send(s, "x", 1000, () -> true));
    }

    @Test
    public void fitsAdmitsOneMaximalMessageIntoAnEmptyQueue() {
        assertTrue(SendGate.fits(0, SendGate.MAX_MESSAGE_BYTES));
        assertFalse(SendGate.fits(0, SendGate.MAX_MESSAGE_BYTES + 1));
        assertTrue(SendGate.fits(SendGate.QUEUE_BUDGET_BYTES - 10, 10));
        assertFalse(SendGate.fits(SendGate.QUEUE_BUDGET_BYTES - 10, 11));
        assertTrue(SendGate.QUEUE_BUDGET_BYTES <= SendGate.OKHTTP_QUEUE_LIMIT);
        assertTrue(SendGate.MAX_MESSAGE_BYTES <= SendGate.OKHTTP_QUEUE_LIMIT);
    }

    @Test
    public void utf8LengthMatchesTheEncoderAndNeverUndercounts() {
        for (String s : new String[]{"", "ascii", "é", "사진", "📷 photo", "a\u0000b", "{\"answer\":\"도쿄에서 찍은 사진 3장\"}"}) {
            assertEquals(s, s.getBytes(StandardCharsets.UTF_8).length, SendGate.utf8Length(s));
        }
        String lone = "x\uD83D";   // an unpaired high surrogate: the encoder writes '?' (1 byte)
        assertTrue(SendGate.utf8Length(lone) >= lone.getBytes(StandardCharsets.UTF_8).length);
    }
}
