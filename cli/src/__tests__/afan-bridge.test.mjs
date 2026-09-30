// The afan host bridge (afan-bridge.js + afan-catalog.js) against a temp bundle folder, a fake aindrive
// server (drive owner check, members, handoffs) and a fake Ainize (registry + A2A agent), all on one
// loopback HTTP server. Spec: afan-soverign docs/AGENT_BRIDGE.md.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afanBridgeEnabled, createAfanBridge, parseConcept, conversationContextId, REQUEST_PATH_RE } from "../afan-bridge.js";
import { lookupHandoff } from "../handoffs.js";
import { startAfanBridge } from "../agent.js";

const DRIVE = "drv_test";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const OWNER_SESSION = `${b64({ alg: "HS256" })}.${b64({ sub: "usr_owner" })}.OWNERSESSIONSIGsecret`;
const MEMBER_SESSION = `${b64({ alg: "HS256" })}.${b64({ sub: "usr_member" })}.MEMBERSESSIONSIGsecret`;
const MCP_TOKEN = "aind_hg_SUPERSECRETgranttoken123";
const LINK_SECRET = "LINKSECRETabcdef123456";
const AINIZE_TOKEN = "AINIZE-BEARER-secret-777";

// ---------------------------------------------------------------- fake world
const state = {};
function resetState() {
  Object.assign(state, {
    a2aCalls: [], handoffPosts: [], revokes: [], registryCalls: 0, handoffsFileDuringCall: null,
    agentMode: "complete", // complete | slow | fail
    cancelCalls: [], members: [], taskPolls: 0, fetched: new Set(), links: [],
  });
}
resetState();

let server, base, handoffsFile;
const cookieSession = (req) => /aindrive_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? null;
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => r(s ? JSON.parse(s) : null)); });

async function handle(req, res) {
  const url = new URL(req.url, base);
  const session = cookieSession(req);
  // ---- aindrive server
  if (url.pathname === `/api/drives/${DRIVE}` && req.method === "GET") {
    return session === OWNER_SESSION ? json(res, 200, { id: DRIVE, name: "afan" }) : json(res, session ? 403 : 401, { error: "forbidden" });
  }
  if (url.pathname === `/api/drives/${DRIVE}/members` && req.method === "GET") {
    if (!session) return json(res, 401, { error: "unauthorized" });
    if (session !== OWNER_SESSION) return json(res, 403, { error: "forbidden" });
    return json(res, 200, { members: state.members, pending: [], myRole: "owner" });
  }
  if (url.pathname === "/api/handoffs" && req.method === "POST") {
    if (session !== OWNER_SESSION) return json(res, 403, { error: "not your drive" });
    const body = await readBody(req);
    state.handoffPosts.push(body);
    state.links = body.files.map((f, i) => ({ id: `h${i}`, url: `${base}/api/h/h${i}?k=${LINK_SECRET}${i}`, name: f.name, deviceKey: f.deviceKey, expiresAt: "2099-01-01T00:00:00Z" }));
    return json(res, 200, { links: state.links, mcp: { url: `${base}/mcp/h/grant1`, token: MCP_TOKEN, expiresAt: "2099-01-01T00:00:00Z" } });
  }
  if (url.pathname === "/api/handoffs" && req.method === "GET") {
    return json(res, 200, { handoffs: state.links.map((l) => ({ id: l.id, fetches: state.fetched.has(l.id) ? 1 : 0 })) });
  }
  if (url.pathname === "/api/handoffs" && req.method === "DELETE") {
    state.revokes.push(url.searchParams.get("audience"));
    return json(res, 200, { revoked: state.links.length });
  }
  // ---- Ainize registry
  if (url.pathname === "/api/shared-agents") {
    state.registryCalls += 1;
    const ref = (id, extra = {}) => ({
      contract: "1.0", registryIssuer: base, agentId: id, releaseId: "v3", ownerRef: { kind: "account", issuer: base, subject: "o" },
      visibility: "public", agentCardUrl: `${base}/a2a/${id}/card`, endpoint: `${base}/a2a/${id}`, supportedProtocolVersions: ["0.3"],
      skills: [{ id: "summarise", name: "Summarise a document" }], inputModes: ["text/plain"], outputModes: ["text/plain"], uiCapabilities: [],
      popJwk: { kty: "EC", crv: "P-256", x: "xx", y: "yy", d: "PRIVATE-MUST-NOT-LEAK" }, status: "active", displayName: `Agent ${id}`, updatedAt: "2026-09-29T00:00:00Z", ...extra,
    });
    return json(res, 200, { contract: "1.0", items: [{ ref: ref("guide"), canInvoke: true }, { ref: ref("stopped", { status: "stopped" }), canInvoke: false }] });
  }
  // ---- A2A agent
  if (url.pathname === "/a2a/guide" && req.method === "POST") {
    const rpc = await readBody(req);
    state.a2aCalls.push({ rpc, authorization: req.headers.authorization ?? null });
    if (rpc.method === "message/send") {
      const msg = rpc.params.message;
      // The agent "reads" the first granted file through the handoff (the server logs the fetch).
      const mcp = msg.parts.find((p) => p.metadata?.type === "ai.aindrive/handoff-mcp");
      if (mcp && state.links[0]) {
        state.fetched.add(state.links[0].id);
        state.handoffsFileDuringCall = lookupHandoff(state.links[0].deviceKey, handoffsFile, clock);
      }
      if (state.agentMode === "fail") return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { kind: "task", id: "task-f", contextId: msg.contextId, status: { state: "failed", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: "could not read" }] } } } });
      if (state.agentMode === "slow") return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { kind: "task", id: "task-slow", contextId: msg.contextId, status: { state: "working" } } });
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: {
        kind: "task", id: `task-${msg.messageId}`, contextId: msg.contextId, status: { state: "completed" },
        artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "The show has twelve works by Kim." }] }],
      } });
    }
    if (rpc.method === "tasks/get") { state.taskPolls += 1; return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { kind: "task", id: rpc.params.id, status: { state: "working" } } }); }
    if (rpc.method === "tasks/cancel") { state.cancelCalls.push(rpc.params.id); return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { kind: "task", id: rpc.params.id, status: { state: "canceled" } } }); }
  }
  return json(res, 404, { error: "not found" });
}

beforeAll(async () => {
  server = createServer((req, res) => { handle(req, res).catch((e) => json(res, 500, { error: String(e) })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

// ---------------------------------------------------------------- bundle helpers
let root, clock;
function mkBundle() {
  root = mkdtempSync(join(tmpdir(), "afan-bundle-"));
  handoffsFile = join(mkdtempSync(join(tmpdir(), "afan-handoffs-")), "handoffs.json");
  writeFileSync(join(root, "drive.md"), `---\n${stringifyYaml({ type: "afan Drive", title: "afan", owner: "haechan", members: ["mina"], updated: "2026-09-29T00:00:00Z" })}---\n# Members\n`);
  mkdirSync(join(root, "people/haechan/media"), { recursive: true });
  writeFileSync(join(root, "people/haechan/media/9f2a.txt"), "Twelve works by Kim.");
  mkdirSync(join(root, "exhibitions/2026-12"), { recursive: true });
  writeFileSync(join(root, "exhibitions/2026-12/guide.pdf"), "%PDF-1.4 fake");
}

function writeRequest(handle, id, over = {}) {
  const fm = {
    type: "afan Agent Request", request_id: id, author: handle,
    agent: { key: `${base}#guide` }, prompt_ref: "#prompt",
    file_refs: [{ bundle_path: `/people/${handle}/media/9f2a.txt` }],
    conversation: "conv-1", idempotency_key: `idem-${id}`,
    created: new Date(clock).toISOString(), expires: new Date(clock + 3600_000).toISOString(),
    status: "pending", canceled: false, options: { stream: false, visibility: "private" },
    generated: { by: `human:${handle}`, at: new Date(clock).toISOString() },
    ...over,
  };
  const rel = `people/${handle}/agent-requests/${id}.md`;
  mkdirSync(join(root, `people/${handle}/agent-requests`), { recursive: true });
  writeFileSync(join(root, rel), `---\n${stringifyYaml(fm)}---\n# Prompt\n\nSummarise this show for visitors in three lines.\n`);
  return rel;
}

function readResult(handle, id) {
  const p = join(root, `people/${handle}/agent-results/${id}.md`);
  if (!existsSync(p)) return null;
  const c = parseConcept(readFileSync(p, "utf8"));
  return c;
}

function makeBridge(over = {}) {
  return createAfanBridge({
    root, driveId: DRIVE, server: base, ainizeUrl: base, ainizeToken: AINIZE_TOKEN,
    getSession: async () => OWNER_SESSION, handoffsFile, now: () => clock,
    device: "test-mac", hostVersion: "0.0.0-test", pollMs: 20, debounceMs: 10,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...over,
  });
}

function allFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

function expectNoSecretsIn(dir) {
  for (const f of allFiles(dir)) {
    const text = readFileSync(f, "utf8");
    for (const s of [OWNER_SESSION, "OWNERSESSIONSIGsecret", MCP_TOKEN, "aind_hg_", LINK_SECRET, AINIZE_TOKEN, "PRIVATE-MUST-NOT-LEAK", "ain-rdlg"]) {
      expect(text.includes(s), `${f} contains ${s}`).toBe(false);
    }
    expect(text, `${f} carries a link credential`).not.toMatch(/[?&](k|token|sig|signature)=(?!\[redacted\])/);
  }
}

beforeEach(() => {
  resetState();
  clock = Date.parse("2026-09-30T09:00:00Z");
  mkBundle();
  state.members = [
    { id: "m1", path: "", role: "viewer", email: "mina@example.com", name: "Mina", isCreator: false },
    { id: "m2", path: "people/mina", role: "editor", email: "mina@example.com", name: "Mina", isCreator: false },
  ];
});

// ---------------------------------------------------------------- tests
describe("afanBridgeEnabled — opt-in, off by default", () => {
  it("is off without the flag or the env, and never without a drive", () => {
    expect(afanBridgeEnabled({ driveId: DRIVE }, {})).toBe(false);
    expect(afanBridgeEnabled({ driveId: DRIVE, afanBridge: "yes" }, {})).toBe(false);
    expect(afanBridgeEnabled({ driveId: DRIVE, afanBridge: true }, {})).toBe(true);
    expect(afanBridgeEnabled({ driveId: DRIVE }, { AINDRIVE_AFAN_BRIDGE: "1" })).toBe(true);
    expect(afanBridgeEnabled({ afanBridge: true }, { AINDRIVE_AFAN_BRIDGE: "1" })).toBe(false);
    expect(afanBridgeEnabled(null, { AINDRIVE_AFAN_BRIDGE: "1" })).toBe(false);
  });

  it("the device agent starts no bridge unless opted in", () => {
    expect(startAfanBridge({ root: "/nowhere", drive: { driveId: DRIVE }, server: "https://x" }, {})).toBeNull();
    const b = startAfanBridge({ root: mkdtempSync(join(tmpdir(), "afan-on-")), drive: { driveId: DRIVE, afanBridge: true }, server: "https://x" }, {});
    expect(typeof b?.notify).toBe("function");
    b.close();
  });
});

describe("watch filter", () => {
  it("acts on people/*/agent-requests/*.md only — never on temp files or results", async () => {
    expect(REQUEST_PATH_RE.test("people/haechan/agent-requests/r1.md")).toBe(true);
    expect(REQUEST_PATH_RE.test("people/haechan/agent-requests/r1.md.tmp")).toBe(false);
    expect(REQUEST_PATH_RE.test("people/haechan/agent-results/r1.md")).toBe(false);
    expect(REQUEST_PATH_RE.test("people/haechan/posts/2026/09/30/p.md")).toBe(false);
    const bridge = makeBridge();
    expect(bridge.notify("people/haechan/agent-requests/r1.md.tmp")).toBe(false);
    expect(bridge.notify("_catalog.md")).toBe(false);
    const rel = writeRequest("haechan", "r1");
    expect(bridge.notify(rel)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    await bridge.idle();
    expect(readResult("haechan", "r1").fm.status).toBe("completed");
  });
});

describe("happy path (owner request)", () => {
  it("verifies, grants the file, calls A2A and writes the result the afan core parses", async () => {
    const rel = writeRequest("haechan", "r1");
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();

    const r = readResult("haechan", "r1");
    expect(r.fm).toMatchObject({
      type: "afan Agent Result", request_id: "r1", author: "haechan", status: "completed",
      request: "/people/haechan/agent-requests/r1.md",
      agent: { key: `${base}#guide`, release_id: "v3", endpoint: `${base}/a2a/guide` },
      task_id: "task-idem-r1", sources: ["/people/haechan/media/9f2a.txt"], outputs: [],
      executed_by: { host: "aindrive-cli/0.0.0-test", device: "test-mac" },
      generated: { by: `agent:${base}#guide` },
    });
    expect(r.fm.verified).toEqual([{ by: `aindrive:${DRIVE}`, at: "2026-09-30T09:00:00Z", method: "grant-match" }]);
    expect(r.fm.error).toBeUndefined();
    expect(r.fm.context_id).toBe(conversationContextId({ account: "aindrive:usr_owner", product: "afan", room: DRIVE, conversation: "conv-1" }));
    expect(r.body).toMatch(/^# Answer\n\nThe show has twelve works by Kim\./);
    expect(r.body).toContain("# Sources");

    // A2A: messageId = idempotency key; the prompt text carries no credential; the grant rides the data part
    expect(state.a2aCalls).toHaveLength(1);
    const { rpc, authorization } = state.a2aCalls[0];
    expect(authorization).toBe(`Bearer ${AINIZE_TOKEN}`);
    expect(rpc.method).toBe("message/send");
    const msg = rpc.params.message;
    expect(msg.messageId).toBe("idem-r1");
    expect(msg.parts[0]).toEqual({ kind: "text", text: "Summarise this show for visitors in three lines." });
    const mcp = msg.parts.find((p) => p.metadata?.type === "ai.aindrive/handoff-mcp");
    expect(mcp.data.mcpServers[0]).toMatchObject({ url: `${base}/mcp/h/grant1`, transport: "streamable-http", headers: { Authorization: `Bearer ${MCP_TOKEN}` }, tools: ["list_files", "read_file"] });
    for (const p of msg.parts.filter((p) => p.kind === "text")) expect(p.text).not.toMatch(/aind_|Bearer|k=/);

    // handoff: owner-only POST with a registered device key, served while the call ran, revoked after
    expect(state.handoffPosts).toHaveLength(1);
    expect(state.handoffPosts[0]).toMatchObject({ driveId: DRIVE, ttlSeconds: 900, files: [{ name: "9f2a.txt", mime: "text/plain", size: 20 }] });
    expect(state.handoffsFileDuringCall?.path).toMatch(/9f2a\.txt$/);
    expect(state.revokes).toEqual([`afan:${base}#guide:r1`]);
    expect(lookupHandoff(state.handoffPosts[0].files[0].deviceKey, handoffsFile, clock)).toBeNull();

    // catalog at the bundle root (owner host)
    const cat = parseConcept(readFileSync(join(root, "_catalog.md"), "utf8"));
    expect(cat.fm.type).toBe("afan Agent Catalog");
    expect(cat.fm.as_of).toBe("2026-09-30T09:00:00Z");
    expect(cat.fm.agents.map((a) => [a.agent_key, a.can_invoke])).toEqual([[`${base}#guide`, true], [`${base}#stopped`, false]]);
    expect(cat.fm.agents[0].pop).toEqual({ kty: "EC", crv: "P-256", x: "xx", y: "yy" });

    // nothing temporary left behind, nothing secret written
    expect(allFiles(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expectNoSecretsIn(root);
  });

  it("a folder reference becomes a folder-context snapshot, not a grant; no sources ⇒ detail no-sources", async () => {
    const rel = writeRequest("haechan", "r2", { file_refs: [{ bundle_path: "/exhibitions/2026-12" }] });
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();
    expect(state.handoffPosts).toHaveLength(0);
    const folder = state.a2aCalls[0].rpc.params.message.parts.find((p) => p.metadata?.type === "ai.aindrive/folder-context");
    expect(folder.data.folder).toMatchObject({ path: "/exhibitions/2026-12", entries: [{ name: "guide.pdf", isDir: false, mime: "application/pdf" }] });
    const r = readResult("haechan", "r2");
    expect(r.fm).toMatchObject({ status: "completed", sources: [], detail: "no-sources" });
  });

  it("a file_key + legacy_path in this drive is granted; another drive's file is refused forbidden", async () => {
    const ok = writeRequest("haechan", "r3", { file_refs: [{ file_key: `${base}#${DRIVE}#p1:3c8f`, legacy_path: "/exhibitions/2026-12/guide.pdf", source_url: `${base}/d/${DRIVE}/exhibitions/2026-12/guide.pdf` }] });
    const other = writeRequest("haechan", "r4", { file_refs: [{ file_key: `${base}#drv_other#p1:1`, legacy_path: "/x.pdf" }] });
    const escape = writeRequest("haechan", "r5", { file_refs: [{ bundle_path: "/../../etc/passwd" }] });
    const bridge = makeBridge();
    await Promise.all([bridge.process(ok), bridge.process(other), bridge.process(escape)]);
    await bridge.idle();
    expect(readResult("haechan", "r3").fm).toMatchObject({ status: "completed", sources: [`${base}/d/${DRIVE}/exhibitions/2026-12/guide.pdf`] });
    expect(readResult("haechan", "r4").fm).toMatchObject({ status: "rejected", error: { code: "forbidden", detail: "cross-drive-file", retryable: false } });
    expect(readResult("haechan", "r5").fm).toMatchObject({ status: "rejected", error: { code: "forbidden", detail: "path-escape" } });
    expect(state.a2aCalls.filter((c) => c.rpc.method === "message/send")).toHaveLength(1);
    expectNoSecretsIn(root);
  });

  it("an agent's failed task is a failed result with the contract error shape", async () => {
    state.agentMode = "fail";
    const rel = writeRequest("haechan", "r6");
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();
    expect(readResult("haechan", "r6").fm).toMatchObject({ status: "failed", task_id: "task-f", error: { code: "temporary_failure", message: "could not read", retryable: true, detail: "task-failed" } });
    expect(state.revokes).toHaveLength(1);
  });

  it("a stopped or unknown agent is refused without a call", async () => {
    const a = writeRequest("haechan", "r7", { agent: { key: `${base}#stopped` } });
    const b = writeRequest("haechan", "r8", { agent: { key: `${base}#nope` } });
    const bridge = makeBridge();
    await bridge.process(a); await bridge.process(b);
    await bridge.idle();
    expect(readResult("haechan", "r7").fm).toMatchObject({ status: "rejected", error: { code: "agent_stopped" } });
    expect(readResult("haechan", "r8").fm).toMatchObject({ status: "rejected", error: { code: "resource_deleted", detail: "agent-not-found" } });
    expect(state.a2aCalls).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("canceled before start → canceled result, no grant, no call", async () => {
    const rel = writeRequest("haechan", "c1", { canceled: true });
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();
    expect(readResult("haechan", "c1").fm).toMatchObject({ status: "canceled", request_id: "c1", author: "haechan" });
    expect(state.a2aCalls).toHaveLength(0);
    expect(state.handoffPosts).toHaveLength(0);
  });

  it("canceled while the agent works → tasks/cancel, canceled result, grant revoked", async () => {
    state.agentMode = "slow";
    const rel = writeRequest("haechan", "c2");
    const bridge = makeBridge();
    const run = bridge.process(rel);
    for (let i = 0; i < 100 && state.taskPolls < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(readResult("haechan", "c2").fm.status).toBe("running");
    writeRequest("haechan", "c2", { canceled: true });
    await run;
    await bridge.idle();
    expect(state.cancelCalls).toEqual(["task-slow"]);
    expect(readResult("haechan", "c2").fm).toMatchObject({ status: "canceled", task_id: "task-slow" });
    expect(state.revokes).toHaveLength(1);
    expectNoSecretsIn(root);
  });
});

describe("expired", () => {
  it("a request first seen after `expires` is not started", async () => {
    const rel = writeRequest("haechan", "e1", { expires: new Date(clock - 1000).toISOString() });
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();
    expect(readResult("haechan", "e1").fm).toMatchObject({ status: "expired", error: { code: "temporary_failure", detail: "expired-before-start", retryable: true } });
    expect(state.a2aCalls).toHaveLength(0);
    expect(state.handoffPosts).toHaveLength(0);
  });

  it("an agent still working at `expires` is canceled and the result says expired", async () => {
    state.agentMode = "slow";
    const rel = writeRequest("haechan", "e2");
    const bridge = makeBridge();
    const run = bridge.process(rel);
    for (let i = 0; i < 100 && state.taskPolls < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
    clock += 3600_000;
    await run;
    expect(readResult("haechan", "e2").fm).toMatchObject({ status: "expired", error: { detail: "expired-while-running" } });
    expect(state.cancelCalls).toEqual(["task-slow"]);
  });
});

describe("unverified authors are never executed", () => {
  it("a handle no account holds editor on → rejected forbidden, no grant, no call", async () => {
    const rel = writeRequest("mallory", "u1");
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();
    const r = readResult("mallory", "u1").fm;
    expect(r).toMatchObject({ status: "rejected", author: "mallory", error: { code: "forbidden", detail: "author-unverified", retryable: false } });
    expect(r.verified).toBeUndefined();
    expect(state.a2aCalls).toHaveLength(0);
    expect(state.handoffPosts).toHaveLength(0);
  });

  it("author ≠ path handle → rejected author-path-mismatch", async () => {
    const rel = writeRequest("haechan", "u2", { author: "mina" });
    const bridge = makeBridge();
    await bridge.process(rel);
    expect(readResult("haechan", "u2").fm).toMatchObject({ status: "rejected", error: { code: "unsupported_input", detail: "author-path-mismatch" } });
    expect(state.a2aCalls).toHaveLength(0);
  });

  it("drive.md names the owner but this host's account does not own the drive → rejected", async () => {
    const rel = writeRequest("haechan", "u3");
    const bridge = makeBridge({ getSession: async () => MEMBER_SESSION });
    await bridge.process(rel);
    await bridge.idle();
    expect(readResult("haechan", "u3").fm).toMatchObject({ status: "rejected", error: { code: "forbidden", detail: "drive-owner-mismatch" } });
    expect(state.a2aCalls).toHaveLength(0);
    expect(existsSync(join(root, "_catalog.md"))).toBe(false); // catalog is owner-only
  });

  it("no session → rejected auth_required", async () => {
    const rel = writeRequest("haechan", "u4");
    const bridge = makeBridge({ getSession: async () => null });
    await bridge.process(rel);
    await bridge.idle();
    expect(readResult("haechan", "u4").fm).toMatchObject({ status: "rejected", error: { code: "auth_required", detail: "no-session" } });
    expect(state.a2aCalls).toHaveLength(0);
  });

  it("server unreachable → refused as failed/source_offline (retryable), never executed", async () => {
    const rel = writeRequest("haechan", "u7");
    const bridge = makeBridge({ server: "http://127.0.0.1:9" });
    await bridge.process(rel);
    await bridge.idle();
    expect(readResult("haechan", "u7").fm).toMatchObject({ status: "failed", error: { code: "source_offline", detail: "author-unverifiable", retryable: true } });
    expect(state.a2aCalls).toHaveLength(0);
  });

  it("two accounts holding editor on the same handle → ambiguous, refused", async () => {
    state.members.push({ id: "m3", path: "people/mina", role: "editor", email: "other@example.com" });
    const rel = writeRequest("mina", "u5");
    const bridge = makeBridge();
    await bridge.process(rel);
    expect(readResult("mina", "u5").fm).toMatchObject({ status: "rejected", error: { code: "forbidden", detail: "author-ambiguous" } });
  });

  it("a confirmed member is verified but refused forbidden: handoffs are owner-only and no delegation path exists", async () => {
    const rel = writeRequest("mina", "u6");
    const bridge = makeBridge();
    await bridge.process(rel);
    await bridge.idle();
    const r = readResult("mina", "u6").fm;
    expect(r).toMatchObject({ status: "rejected", error: { code: "forbidden", detail: "member-delegation-unavailable" } });
    expect(r.verified[0].method).toBe("grant-match");
    expect(state.a2aCalls).toHaveLength(0);
    expect(state.handoffPosts).toHaveLength(0);
  });
});

describe("idempotent re-run", () => {
  it("running the same request again never calls the agent twice", async () => {
    const rel = writeRequest("haechan", "i1");
    const bridge = makeBridge();
    await Promise.all([bridge.process(rel), bridge.process(rel)]);
    await bridge.process(rel);
    await makeBridge().process(rel); // a second host serving the same folder
    await bridge.idle();
    expect(state.a2aCalls.filter((c) => c.rpc.method === "message/send")).toHaveLength(1);
    expect(readResult("haechan", "i1").fm.status).toBe("completed");
  });

  it("a second request with the same idempotency_key reuses the completed answer", async () => {
    const first = writeRequest("haechan", "i2", { idempotency_key: "same-key" });
    const bridge = makeBridge();
    await bridge.process(first);
    const second = writeRequest("haechan", "i3", { idempotency_key: "same-key" });
    await bridge.process(second);
    await bridge.idle();
    expect(state.a2aCalls.filter((c) => c.rpc.method === "message/send")).toHaveLength(1);
    const r = readResult("haechan", "i3");
    expect(r.fm).toMatchObject({ status: "completed", request_id: "i3", task_id: "task-same-key" });
    expect(r.body).toContain("The show has twelve works by Kim.");
  });

  it("a `running` result this device left behind (crash) is resumed with the same messageId", async () => {
    const rel = writeRequest("haechan", "i4");
    mkdirSync(join(root, "people/haechan/agent-results"), { recursive: true });
    writeFileSync(join(root, "people/haechan/agent-results/i4.md"), `---\n${stringifyYaml({ type: "afan Agent Result", request_id: "i4", author: "haechan", status: "running", executed_by: { host: "aindrive-cli/x", device: "test-mac" } })}---\n# Answer\n\n(working…)\n`);
    // another device's running result is left alone
    const rel2 = writeRequest("haechan", "i5");
    writeFileSync(join(root, "people/haechan/agent-results/i5.md"), `---\n${stringifyYaml({ type: "afan Agent Result", request_id: "i5", author: "haechan", status: "running", executed_by: { device: "phone" } })}---\n`);
    const bridge = makeBridge();
    await bridge.scan();
    await bridge.idle();
    const sends = state.a2aCalls.filter((c) => c.rpc.method === "message/send");
    expect(sends.map((c) => c.rpc.params.message.messageId)).toEqual(["idem-i4"]);
    expect(readResult("haechan", "i4").fm.status).toBe("completed");
    expect(readResult("haechan", "i5").fm.status).toBe("running");
    expect(rel2).toBeTruthy();
  });
});

describe("_catalog.md cadence", () => {
  it("is refreshed at most every 10 minutes", async () => {
    const bridge = makeBridge();
    expect(await bridge.refreshCatalog()).toBe(true);
    const calls = state.registryCalls;
    clock += 5 * 60_000;
    expect(await bridge.refreshCatalog()).toBe(false);
    expect(state.registryCalls).toBe(calls);
    // a restarted host reads as_of from disk and keeps the cadence
    expect(await makeBridge().refreshCatalog()).toBe(false);
    clock += 6 * 60_000;
    expect(await bridge.refreshCatalog()).toBe(true);
    expect(parseYaml(readFileSync(join(root, "_catalog.md"), "utf8").split("---")[1]).as_of).toBe("2026-09-30T09:11:00Z");
    expectNoSecretsIn(root);
  });
});

describe("no token in written files", () => {
  it("scrubs a credential the agent echoes back into its answer", async () => {
    const rel = writeRequest("haechan", "s1");
    const bridge = makeBridge({
      fetchImpl: async (url, init) => {
        const res = await fetch(url, init);
        if (!String(url).endsWith("/a2a/guide")) return res;
        const body = await res.json();
        if (body.result?.artifacts) body.result.artifacts[0].parts[0].text = `leak ${MCP_TOKEN} and ${base}/api/h/h0?k=${LINK_SECRET}0 and ${AINIZE_TOKEN}`;
        return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
      },
    });
    await bridge.process(rel);
    await bridge.idle();
    const r = readResult("haechan", "s1");
    expect(r.fm.status).toBe("completed");
    expect(r.body).toContain("[redacted]");
    expectNoSecretsIn(root);
    expect(statSync(handoffsFile).mode & 0o077).toBe(0);
  });
});
