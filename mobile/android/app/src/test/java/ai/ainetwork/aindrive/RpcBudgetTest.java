package ai.ainetwork.aindrive;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.FileVisitResult;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * Per-request deadlines under the server's timeouts, and per-drive lanes: one drive answering
 * big reads over a slow uplink holds neither another drive's requests nor its own list/stat.
 */
public class RpcBudgetTest {
    static final long MIB = 1024 * 1024;

    @Test
    public void everyDeadlineIsUnderTheServersTimeout() {
        String[] methods = {"list", "stat", "read", "write", "mkdir", "rename", "delete", "upload-chunk", "download-chunk",
                "yjs-write", "yjs-read", "yjs-stats", "agent-ask", "handoff-read", "no-such-method", "", null};
        for (String m : methods) {
            long budgetMs = (RpcBudget.deadlineNanos(m, 0) / 1_000_000L);
            assertTrue(m, budgetMs < RpcBudget.serverTimeoutMs(m));
            assertTrue(m, budgetMs >= RpcBudget.serverTimeoutMs(m) - 5_000);
        }
        assertEquals(23_000, RpcBudget.deadlineNanos("read", 0) / 1_000_000L);
        assertEquals(23_000, RpcBudget.deadlineNanos("list", 0) / 1_000_000L);
        assertEquals(118_000, RpcBudget.deadlineNanos("upload-chunk", 0) / 1_000_000L);
        assertEquals(118_000, RpcBudget.deadlineNanos("download-chunk", 0) / 1_000_000L);
        assertEquals(88_000, RpcBudget.deadlineNanos("agent-ask", 0) / 1_000_000L);
        // Counted from when the request arrived, not from when a worker got to it.
        assertEquals(5_000_000_000L + 23_000_000_000L, RpcBudget.deadlineNanos("read", 5_000_000_000L));
    }

    @Test
    public void lanesAndSkippableMethods() {
        for (String m : new String[]{"read", "download-chunk", "handoff-read", "yjs-read"}) assertTrue(m, RpcBudget.bulk(m));
        for (String m : new String[]{"list", "stat", "write", "upload-chunk", "rename", "delete", "agent-ask", "", null}) assertFalse(String.valueOf(m), RpcBudget.bulk(m));
        for (String m : new String[]{"list", "stat", "read", "download-chunk", "handoff-read", "yjs-read", "yjs-stats"}) assertTrue(m, RpcBudget.readOnly(m));
        // Anything that may change the folder always runs, as before.
        for (String m : new String[]{"write", "upload-chunk", "rename", "delete", "mkdir", "yjs-write", "agent-ask", "", null})
            assertFalse(String.valueOf(m), RpcBudget.readOnly(m));
    }

    private static String rep(char c, int n) {
        char[] a = new char[n];
        java.util.Arrays.fill(a, c);
        return new String(a);
    }

    /** A request frame exactly as web/lib/agents.js sendRpc serialises it. */
    private static String frame(String paramsJson) {
        return "{\"type\":\"request\",\"v\":1,\"reqId\":\"3f2a9c0e1b7d4a55\",\"driveId\":\"drv_abc\",\"issuedAt\":1790000000000,"
                + "\"params\":" + paramsJson + ",\"sig\":\"" + rep('0', 64) + "\"}";
    }

    @Test
    public void theMethodIsReadOffTheFrameWithoutParsingIt() {
        assertEquals("read", RpcBudget.methodOf(frame("{\"method\":\"read\",\"path\":\"Camera/a.jpg\",\"encoding\":\"base64\"}")));
        assertEquals("list", RpcBudget.methodOf(frame("{\"method\":\"list\",\"path\":\"\"}")));
        assertTrue(RpcBudget.bulkFrame(frame("{\"method\":\"download-chunk\",\"path\":\"v.mp4\",\"offset\":0,\"length\":4194304}")));
        assertFalse(RpcBudget.bulkFrame(frame("{\"method\":\"stat\",\"path\":\"a\"}")));
        // A path spelling "method" can't fool it: inside a string every quote is escaped.
        assertEquals("stat", RpcBudget.methodOf(frame("{\"method\":\"stat\",\"path\":\"x\\\"method\\\":\\\"read\"}")));
        assertEquals("", RpcBudget.methodOf("{\"type\":\"hello\"}"));
        assertEquals("", RpcBudget.methodOf(null));
        // A 4 MiB upload-chunk frame: found at the start, the base64 is never scanned.
        StringBuilder data = new StringBuilder();
        for (int i = 0; i < 4 * MIB / 4; i++) data.append("QUJD");
        assertEquals("upload-chunk", RpcBudget.methodOf(frame("{\"method\":\"upload-chunk\",\"path\":\".aindrive/uploads/x.part\",\"chunkId\":1,\"total\":-1,\"data\":\"" + data + "\"}")));
        // Not in the head of the frame: the control lane (a wrong guess only picks the other lane).
        assertEquals("", RpcBudget.methodOf("{\"pad\":\"" + rep('x', RpcBudget.METHOD_SCAN_CHARS) + "\",\"params\":{\"method\":\"read\"}}"));
    }

    // ------------------------------------------------------------ the server's timeouts

    private static final Path WEB = new File("../../../web").toPath();

    private static String read(String rel) throws IOException {
        return new String(Files.readAllBytes(WEB.resolve(rel)), StandardCharsets.UTF_8);
    }

    private static long constant(String src, String name) {
        Matcher m = Pattern.compile(name + "\\s*=\\s*([0-9_]+)").matcher(src);
        assertTrue(name, m.find());
        return Long.parseLong(m.group(1).replace("_", ""));
    }

    /** The table in RpcBudget follows the web: a drifted timeout fails here, not on a phone. */
    @Test
    public void theTimeoutsMatchTheWeb() throws Exception {
        assumeTrue("the web tree is next to mobile/", Files.isDirectory(WEB.resolve("lib")));
        assertEquals(RpcBudget.SERVER_DEFAULT_MS, constant(read("lib/agents.js"), "DEFAULT_TIMEOUT_MS"));
        assertEquals(RpcBudget.SERVER_TRANSFER_MS, constant(read("lib/agent-stream.ts"), "STREAM_CHUNK_TIMEOUT_MS"));

        // No call site gives any RPC longer than the longest budget, and only the transfer
        // methods and agent-ask get more than the default.
        Pattern literal = Pattern.compile("timeoutMs:\\s*([0-9_]+)");
        List<String> over = new ArrayList<>();
        int[] scanned = {0};
        Files.walkFileTree(WEB, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                String n = dir.getFileName().toString();
                return n.equals("node_modules") || n.startsWith(".next") || n.equals("__tests__") ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFile(Path f, BasicFileAttributes attrs) throws IOException {
                String n = f.getFileName().toString();
                if (!(n.endsWith(".ts") || n.endsWith(".tsx") || n.endsWith(".js")) || n.contains(".test.")) return FileVisitResult.CONTINUE;
                scanned[0]++;
                Matcher m = literal.matcher(new String(Files.readAllBytes(f), StandardCharsets.UTF_8));
                while (m.find()) {
                    long ms = Long.parseLong(m.group(1).replace("_", ""));
                    if (ms > RpcBudget.SERVER_TRANSFER_MS) over.add(WEB.relativize(f) + ": " + ms);
                }
                return FileVisitResult.CONTINUE;
            }
        });
        assertTrue(scanned[0] > 50);
        assertTrue("server timeouts longer than the phone's budget: " + over, over.isEmpty());
    }

    // ------------------------------------------------------------ lanes

    /** A real-time link: one writer at `bytesPerSecond`, messages leave whole and in order. */
    static final class Link implements SendGate.Socket {
        final double bytesPerNs;
        final List<long[]> messages = new ArrayList<>();
        long writerFreeAt;

        Link(double bytesPerSecond) { this.bytesPerNs = bytesPerSecond / 1e9; }

        @Override public synchronized long queueSize() {
            long now = System.nanoTime(), q = 0;
            for (long[] m : messages) if (m[1] > now) q += m[0];
            return q;
        }

        @Override public synchronized boolean send(String text) {
            long start = Math.max(System.nanoTime(), writerFreeAt);
            writerFreeAt = start + (long) (text.length() / bytesPerNs);
            messages.add(new long[]{text.length(), writerFreeAt});
            assertTrue(queueSize() <= SendGate.OKHTTP_QUEUE_LIMIT);
            return true;
        }
    }

    /** One drive: its gate, its socket and its two lanes, as AgentService.Conn has them. */
    static final class Drive {
        final SendGate gate = new SendGate();
        final Link link;
        final ExecutorService bulk, control;

        Drive(String name, double bytesPerSecond) {
            link = new Link(bytesPerSecond);
            bulk = RpcBudget.lane(name + "-bulk", RpcBudget.BULK_WORKERS);
            control = RpcBudget.lane(name, RpcBudget.CONTROL_WORKERS);
        }

        /** What onMessage + onFrame do: pick the lane by method, then send the reply with the arrival deadline. */
        Future<Long> answer(String method, String reply, long deadlineMs) {
            long arrived = System.nanoTime();
            long deadline = arrived + deadlineMs * 1_000_000L;
            return (RpcBudget.bulk(method) ? bulk : control).submit(() -> {
                SendGate.Result r = gate.send(link, reply, deadline, () -> true);
                return r == SendGate.Result.SENT ? (System.nanoTime() - arrived) / 1_000_000L : -1L;
            });
        }

        void stop() { bulk.shutdownNow(); control.shutdownNow(); }
    }

    @Test
    public void aSlowDrivesBigReadsHoldNeitherAnotherDriveNorItsOwnList() throws Exception {
        // The verifier's starvation probe: six 11 MB reads on drive A over a 0.5 MB/s uplink.
        Drive a = new Drive("a", 500_000), b = new Drive("b", 50_000_000);
        try {
            String eleven = rep('x', 11_000_000);
            List<Future<Long>> reads = new ArrayList<>();
            for (int i = 0; i < 6; i++) reads.add(a.answer("read", eleven, 3_000));
            Thread.sleep(200);                                     // A's bulk workers are all parked now

            long other = b.answer("list", "{\"entries\":[]}", 3_000).get(2, TimeUnit.SECONDS);
            assertTrue("drive B's list waited " + other + " ms", other >= 0 && other < 300);
            long own = a.answer("list", "{\"entries\":[]}", 3_000).get(2, TimeUnit.SECONDS);
            assertTrue("drive A's own list waited " + own + " ms", own >= 0 && own < 300);

            // Only the first read fitted; the rest gave up by their deadline instead of queueing for minutes.
            int sent = 0;
            for (Future<Long> f : reads) if (f.get(10, TimeUnit.SECONDS) >= 0) sent++;
            assertEquals(1, sent);
        } finally {
            a.stop();
            b.stop();
        }
    }
}
