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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

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
        // A bulk request that can't get a slot by its deadline is skipped: only safe if it changes nothing.
        for (String m : RpcHandler.methods()) if (RpcBudget.bulk(m)) assertTrue(m + " is bulk but not read-only", RpcBudget.readOnly(m));
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

        // Every call site gives its method at most the phone's budget for that method.
        List<String> checked = new ArrayList<>();
        List<String> drift = TimeoutScan.drift(WEB, checked);
        assertTrue("server timeouts the phone would not wait for: " + drift, drift.isEmpty());
        assertTrue("the scan found the web's RPC timeouts: " + checked, checked.size() >= 3);
    }

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private void write(Path root, String rel, String src) throws IOException {
        Path f = root.resolve(rel);
        Files.createDirectories(f.getParent());
        Files.write(f, src.getBytes(StandardCharsets.UTF_8));
    }

    /** The scan catches a timeout that drifts for ONE method, not only one past the longest budget. */
    @Test
    public void theTimeoutScanCatchesPerMethodDrift() throws Exception {
        Path web = tmp.newFolder("web").toPath();
        // Too long for its method (read: 25 s), though under the longest budget.
        write(web, "lib/a.ts", "export async function a() {\n  await callAgent(d, s, { method: \"read\", path }, { timeoutMs: 60_000 });\n}\n");
        // Fine: a constant from this file, a comment that names another method, a multi-line call.
        write(web, "lib/b.ts", "const T = 120_000;\nawait callAgent(d, s, {\n  // method: \"read\" is not this call's method\n  method: \"upload-chunk\", path: \"a)b\",\n  data,\n}, { timeoutMs: T });\n");
        // A constant from another file, too long for `write`.
        write(web, "lib/c.ts", "export const LONG_MS = 60_000;\n");
        write(web, "lib/d.ts", "import { LONG_MS } from \"./c\";\nsendRpc(id, { method: 'write', path }, { timeoutMs: LONG_MS });\n");
        // No method literal: only the default (which every method's budget covers) is safe.
        write(web, "lib/e.ts", "callAgent(d, s, params, { timeoutMs: 60_000 });\ncallAgent(d, s, params, { timeoutMs: 3000 });\n");
        // Fine, and a value the scan can't read.
        write(web, "lib/f.ts", "callAgent(d, s, { method: \"agent-ask\", query }, { timeoutMs: 90_000 });\ncallAgent(d, s, { method: \"stat\", path }, { timeoutMs: pick() });\n");
        // A wrapper's own definition (a typed `timeoutMs?:`) is not a call with a timeout.
        write(web, "lib/rpc.ts", "export async function callAgent<M extends P[\"method\"]>(id: string, params: Extract<P, { method: M }>, opts: { timeoutMs?: number } = {}) {\n  return sendRpc(id, params, opts);\n}\n");
        // Not an RPC: only a value past the longest budget counts.
        write(web, "lib/g.ts", "pollUntil(ok, { intervalMs: 500, timeoutMs: 60_000 });\nwait({ timeoutMs: 300_000 });\n");

        List<String> checked = new ArrayList<>();
        List<String> drift = TimeoutScan.drift(web, checked);
        String all = String.join("\n", drift);
        assertEquals(all, 5, drift.size());
        assertTrue(all, all.contains("lib/a.ts: read gets 60000 ms"));
        assertTrue(all, all.contains("lib/d.ts: write gets 60000 ms"));
        assertTrue(all, all.contains("lib/e.ts: an RPC whose method is not a literal gets 60000 ms"));
        assertTrue(all, all.contains("lib/f.ts: stat: can't read timeoutMs"));
        assertTrue(all, all.contains("lib/g.ts: 300000 ms"));
        assertTrue(checked.toString(), checked.contains("lib/b.ts: upload-chunk 120000"));
        assertTrue(checked.toString(), checked.contains("lib/f.ts: agent-ask 90000"));
    }

    /**
     * Reads the web's RPC call sites (`callAgent(` / `sendRpc(`) without a JS parser: each call's
     * argument text (strings and comments skipped), its first `method: "…"` literal, and its
     * `timeoutMs` — a number or a constant defined anywhere in web/. A call past its method's
     * budget, a timeout it can't read, or a call with no method literal given more than the
     * default is reported; so is a `timeoutMs:` outside such a call past the longest budget (a
     * wrapper's caller). A timeout passed in a variable `opts` object is not seen.
     */
    static final class TimeoutScan {
        private static final Pattern CALL = Pattern.compile("\\b(?:callAgent|sendRpc)\\s*(?:<[^()]*?>)?\\s*\\(");
        private static final Pattern METHOD = Pattern.compile("[\"']?\\bmethod[\"']?\\s*:\\s*[\"']([^\"']+)[\"']");
        /** `timeoutMs: <value>`, or a bare `timeoutMs` (shorthand: a variable) — not a type's `timeoutMs?:`. */
        private static final Pattern TIMEOUT = Pattern.compile("\\btimeoutMs\\b(?!\\s*\\?)(\\s*:\\s*([^,}\\)]+))?");
        private static final Pattern CONSTANT = Pattern.compile("\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*number\\s*)?=\\s*([0-9][0-9_]*)\\s*[;,\\n]");

        static List<String> drift(Path web, List<String> checked) throws IOException {
            Map<Path, String> code = new HashMap<>();
            Files.walkFileTree(web, new SimpleFileVisitor<Path>() {
                @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    String n = dir.getFileName().toString();
                    return n.equals("node_modules") || n.startsWith(".next") || n.equals("__tests__") ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult visitFile(Path f, BasicFileAttributes attrs) throws IOException {
                    String n = f.getFileName().toString();
                    if (n.contains(".test.") || n.endsWith(".d.ts")) return FileVisitResult.CONTINUE;
                    if (n.endsWith(".ts") || n.endsWith(".tsx") || n.endsWith(".js") || n.endsWith(".mjs") || n.endsWith(".cjs"))
                        code.put(f, withoutComments(new String(Files.readAllBytes(f), StandardCharsets.UTF_8)));
                    return FileVisitResult.CONTINUE;
                }
            });
            Map<String, TreeSet<Long>> global = new HashMap<>();
            for (String src : code.values()) constants(src, global);

            List<String> drift = new ArrayList<>();
            for (Map.Entry<Path, String> e : code.entrySet()) {
                String rel = web.relativize(e.getKey()).toString().replace('\\', '/'), src = e.getValue();
                Map<String, TreeSet<Long>> local = new HashMap<>();
                constants(src, local);
                List<int[]> calls = new ArrayList<>();
                Matcher c = CALL.matcher(src);
                while (c.find()) {
                    int close = closeParen(src, c.end() - 1);
                    if (close < 0) continue;
                    calls.add(new int[]{c.end(), close});
                    String args = src.substring(c.end(), close);
                    Matcher t = TIMEOUT.matcher(args);
                    if (!t.find()) continue;                         // the default: within every budget
                    Matcher m = METHOD.matcher(args);
                    String method = m.find() ? m.group(1) : null;
                    Long ms = t.group(2) == null ? null : value(t.group(2).trim(), local, global);
                    if (ms == null) { drift.add(rel + ": " + (method == null ? "an RPC" : method) + ": can't read timeoutMs"); continue; }
                    if (method == null) {
                        if (ms > RpcBudget.SERVER_DEFAULT_MS) drift.add(rel + ": an RPC whose method is not a literal gets " + ms + " ms");
                        continue;
                    }
                    checked.add(rel + ": " + method + " " + ms);
                    if (ms > RpcBudget.serverTimeoutMs(method))
                        drift.add(rel + ": " + method + " gets " + ms + " ms, the phone waits " + RpcBudget.serverTimeoutMs(method) + " ms");
                }
                // Outside those calls (a wrapper's caller): nothing past the longest budget.
                Matcher t = TIMEOUT.matcher(src);
                while (t.find()) {
                    if (t.group(2) == null || inside(calls, t.start())) continue;
                    Long ms = value(t.group(2).trim(), local, global);
                    if (ms != null && ms > RpcBudget.SERVER_TRANSFER_MS) drift.add(rel + ": " + ms + " ms, past every budget");
                }
            }
            java.util.Collections.sort(drift);
            java.util.Collections.sort(checked);
            return drift;
        }

        private static boolean inside(List<int[]> spans, int at) {
            for (int[] s : spans) if (at >= s[0] && at < s[1]) return true;
            return false;
        }

        private static void constants(String src, Map<String, TreeSet<Long>> into) {
            Matcher m = CONSTANT.matcher(src);
            while (m.find()) into.computeIfAbsent(m.group(1), k -> new TreeSet<>()).add(Long.parseLong(m.group(2).replace("_", "")));
        }

        /** A number, or a constant (this file's first, else any file's; the largest when defined twice). */
        private static Long value(String v, Map<String, TreeSet<Long>> local, Map<String, TreeSet<Long>> global) {
            if (v.matches("[0-9][0-9_]*")) return Long.parseLong(v.replace("_", ""));
            if (!v.matches("[A-Za-z_$][\\w$]*")) return null;
            TreeSet<Long> s = local.containsKey(v) ? local.get(v) : global.get(v);
            return s == null ? null : s.last();
        }

        /** Index of the `)` closing the `(` at `open`, skipping strings; -1 when unbalanced. */
        static int closeParen(String src, int open) {
            int depth = 0;
            for (int i = open; i < src.length(); i++) {
                char ch = src.charAt(i);
                if (ch == '"' || ch == '\'' || ch == '`') { i = endOfString(src, i); if (i < 0) return -1; continue; }
                if (ch == '(' || ch == '[' || ch == '{') depth++;
                else if (ch == ')' || ch == ']' || ch == '}') { if (--depth == 0) return ch == ')' ? i : -1; }
            }
            return -1;
        }

        private static int endOfString(String src, int start) {
            char q = src.charAt(start);
            for (int i = start + 1; i < src.length(); i++) {
                char ch = src.charAt(i);
                if (ch == '\\') { i++; continue; }
                if (ch == q) return i;
                if (ch == '\n' && q != '`') return i;              // an unterminated quote ends with its line
            }
            return -1;
        }

        /** The source with every comment blanked out (same length, newlines kept); strings untouched. */
        static String withoutComments(String src) {
            StringBuilder out = new StringBuilder(src);
            for (int i = 0; i < src.length(); i++) {
                char ch = src.charAt(i);
                if (ch == '"' || ch == '\'' || ch == '`') { int end = endOfString(src, i); if (end < 0) break; i = end; continue; }
                if (ch == '/' && i + 1 < src.length() && src.charAt(i + 1) == '/') {
                    int end = src.indexOf('\n', i);
                    if (end < 0) end = src.length();
                    for (int k = i; k < end; k++) out.setCharAt(k, ' ');
                    i = end;
                } else if (ch == '/' && i + 1 < src.length() && src.charAt(i + 1) == '*') {
                    int end = src.indexOf("*/", i + 2);
                    end = end < 0 ? src.length() : end + 2;
                    for (int k = i; k < end; k++) if (src.charAt(k) != '\n') out.setCharAt(k, ' ');
                    i = end - 1;
                }
            }
            return out.toString();
        }
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
            return answer(method, reply, deadlineMs, null, 0, null, null);
        }

        /**
         * The same with the phone's bulk slots: a bulk request takes one before it reads (here:
         * holds `readMs`, counted in `inFlight`/`peak`) and keeps it until its reply is sent.
         * -1 when the reply was not sent, -2 when no slot came before the deadline.
         */
        Future<Long> answer(String method, String reply, long deadlineMs, Semaphore slots, long readMs, AtomicInteger inFlight, AtomicInteger peak) {
            long arrived = System.nanoTime();
            long deadline = arrived + deadlineMs * 1_000_000L;
            return (RpcBudget.bulk(method) ? bulk : control).submit(() -> {
                boolean slot = slots != null && RpcBudget.bulk(method);
                if (slot && !RpcBudget.takeSlot(slots, deadline)) return -2L;
                try {
                    if (inFlight != null) { int n = inFlight.incrementAndGet(); peak.accumulateAndGet(n, Math::max); }
                    try {
                        if (readMs > 0) Thread.sleep(readMs);
                        SendGate.Result r = gate.send(link, reply, deadline, () -> true);
                        return r == SendGate.Result.SENT ? (System.nanoTime() - arrived) / 1_000_000L : -1L;
                    } finally { if (inFlight != null) inFlight.decrementAndGet(); }
                } finally { if (slot) slots.release(); }
            });
        }

        void stop() { bulk.shutdownNow(); control.shutdownNow(); }
    }

    /** How many bulk replies were in memory at once: three drives, each reading on both its bulk workers. */
    private static int peakBulkInFlight(Semaphore slots) throws Exception {
        List<Drive> drives = new ArrayList<>();
        for (int i = 0; i < 3; i++) drives.add(new Drive("d" + i, 50_000_000));
        AtomicInteger inFlight = new AtomicInteger(), peak = new AtomicInteger();
        try {
            List<Future<Long>> reads = new ArrayList<>();
            for (Drive d : drives) for (int i = 0; i < 4; i++) reads.add(d.answer("read", rep('x', 100_000), 20_000, slots, 150, inFlight, peak));
            for (Future<Long> f : reads) assertTrue(f.get(20, TimeUnit.SECONDS) >= 0);
            return peak.get();
        } finally {
            for (Drive d : drives) d.stop();
        }
    }

    @Test
    public void bigRepliesInFlightAreCappedAcrossDrives() throws Exception {
        // Without a shared cap the lanes alone let 3 drives × 2 bulk workers read at once…
        assertEquals(3 * RpcBudget.BULK_WORKERS, peakBulkInFlight(new Semaphore(100)));
        // …with the phone's bulk slots, never more than the old process-wide pool.
        int peak = peakBulkInFlight(RpcBudget.bulkSlots());
        assertTrue("peak " + peak, peak <= RpcBudget.MAX_BULK_IN_FLIGHT && peak >= 2);
    }

    @Test
    public void aBulkRequestWithNoSlotByItsDeadlineIsSkipped() throws Exception {
        Semaphore slots = RpcBudget.bulkSlots();
        slots.acquire(RpcBudget.MAX_BULK_IN_FLIGHT);                 // four big replies elsewhere
        Drive d = new Drive("d", 50_000_000);
        try {
            long t0 = System.nanoTime();
            assertEquals(-2L, (long) d.answer("read", "{}", 200, slots, 0, null, null).get(5, TimeUnit.SECONDS));
            long waited = (System.nanoTime() - t0) / 1_000_000L;
            assertTrue("waited " + waited + " ms", waited >= 150 && waited < 2_000);
            // A list is not bulk: it never waits for a slot.
            assertTrue(d.answer("list", "{}", 200, slots, 0, null, null).get(5, TimeUnit.SECONDS) >= 0);
            // One slot frees up: the next read gets it.
            slots.release();
            assertTrue(d.answer("read", "{}", 2_000, slots, 0, null, null).get(5, TimeUnit.SECONDS) >= 0);
            assertFalse("a past deadline takes no slot", RpcBudget.takeSlot(slots, System.nanoTime() - 1));
        } finally {
            d.stop();
        }
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
