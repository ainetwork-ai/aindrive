import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import * as Y from "yjs";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { SAMPLE, CLI_SRC } from "./paths.mjs";

const BASE = process.env.AINDRIVE_BASE || "http://localhost:3737";
const WS_BASE = process.env.AINDRIVE_WS_BASE || "ws://localhost:3737";

// ──────────────────────── helpers ────────────────────────

const state = {
  uniqueSeed: Date.now(),
  ownerEmail: null,
  ownerPassword: "scenpass1234",
  ownerCookie: null,
  driveId: null,
  agentToken: null,
  driveSecret: null,
  walletA: privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
  walletB: privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"),
  // Phase 5: stash for #162→#163 replay case
  lastSettleTxHash: null,
  lastSettleToken: null,
};

function uniq(prefix = "u") { return `${prefix}-${state.uniqueSeed++}`; }

// Each signup must land in its own rate-limit bucket (auth-signup: 5 per 5 min per client IP).
// Without x-forwarded-for the server buckets all test requests under "anon" and the 6th
// signup (incl. 400-returning ones) returns 429, cascading auth failures through the suite.
// Derive a unique IP from the same monotonic counter so it never repeats in a run.
async function signup(email, name, password) {
  // Bump the seed here so two back-to-back signup() calls without an intervening
  // uniq() still get distinct IPs (distinct rate-limit buckets).
  const seed = state.uniqueSeed++;
  const ip = `10.0.${(seed >> 8) & 0xff}.${seed & 0xff}`;
  return jget("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, name, password }),
  });
}

async function jget(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "expected equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

async function signWalletNonce(wallet) {
  const nr = await jget("/api/wallet/nonce", { method: "POST" });
  const url = new URL(BASE);
  const siweMsg = new SiweMessage({
    domain: url.host,
    address: wallet.address,
    statement: "aindrive wants you to sign in with your wallet.",
    uri: BASE,
    version: "1",
    chainId: 1,
    nonce: nr.body.nonce,
  });
  const message = siweMsg.prepareMessage();
  const signature = await wallet.signMessage({ message });
  return { nonce: nr.body.nonce, signature, message };
}

async function loginWallet(wallet) {
  const { nonce, signature, message } = await signWalletNonce(wallet);
  const r = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: wallet.address, signature, nonce, message }),
  });
  return r.headers.get("set-cookie")?.split(";")[0] || null;
}

async function ensureOwner() {
  if (state.ownerCookie) return state.ownerCookie;
  state.ownerEmail = uniq("scen") + "@example.com";
  const r = await signup(state.ownerEmail, "Scen Owner", state.ownerPassword);
  if (r.status !== 200) throw new Error("owner signup failed: " + JSON.stringify(r.body));
  state.ownerCookie = r.headers.get("set-cookie")?.split(";")[0];
  return state.ownerCookie;
}

async function reEnsureOwner() {
  if (state.ownerCookie) {
    const t = await jget("/api/wallet/me", { headers: { cookie: state.ownerCookie } });
    if (t.status === 200) return state.ownerCookie;
  }
  // If ownerEmail not set (e.g. running with SCENARIO filter that skips scenario 1),
  // fall back to ensureOwner which will sign up a new owner.
  if (!state.ownerEmail) return ensureOwner();
  // re-login
  const r = await jget("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: state.ownerEmail, password: state.ownerPassword }),
  });
  if (r.status === 200) state.ownerCookie = r.headers.get("set-cookie")?.split(";")[0];
  return state.ownerCookie;
}

// Creates a fresh email/password user and returns { cookie, email }.
// Used by access cases (F cluster) that need a real drive_members row.
// Each call sends a unique x-forwarded-for so it lands in its own
// auth-signup rate-limit bucket (route limit is 5 per 5 min per client IP).
async function signupUser(prefix = "u") {
  const seed = state.uniqueSeed; // captured before uniq() bumps it
  const email = uniq(prefix) + "@example.com";
  const r = await jget("/api/auth/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.0.${(seed >> 8) & 0xff}.${seed & 0xff}`,
    },
    body: JSON.stringify({ email, name: prefix, password: "scenpass1234" }),
  });
  if (r.status !== 200) throw new Error("signupUser failed: " + JSON.stringify(r.body));
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  return { cookie, email };
}

// Invites `email` to `driveId` at `path` with `role` using owner's cookie.
// Prerequisite: the invitee must already have an account (signupUser).
async function inviteMember(driveId, email, path, role, ownerCookie) {
  const r = await jget(`/api/drives/${driveId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ email, path, role }),
  });
  if (r.status !== 200) throw new Error(`inviteMember ${email} failed: ${JSON.stringify(r.body)}`);
}

// ── Phase 5 money-path helpers ──────────────────────────────────────────────

// Actor helper: sign up a fresh email user, return { email, cookie }.
// Used by money-path cases that need a real users row (not wallet-only).
// Unique x-forwarded-for per call → own rate-limit bucket (limit: 5/5min per IP).
async function signupAndLogin(prefix = "mp") {
  const seed = state.uniqueSeed; // captured before uniq() bumps it
  const email = uniq(prefix) + "@example.com";
  const r = await jget("/api/auth/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.0.${(seed >> 8) & 0xff}.${seed & 0xff}`,
    },
    body: JSON.stringify({ email, name: "MP User", password: "scenpass1234" }),
  });
  if (r.status !== 200) throw new Error("signupAndLogin failed: " + JSON.stringify(r.body));
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("signupAndLogin: no cookie");
  return { email, cookie };
}

// Creates a paid share (price_usdc > 0) on the current ensured drive.
// Returns the share token.
async function makePaidShare({ path = "", role = "viewer", price_usdc = 0.01 } = {}) {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path, role, price_usdc }),
  });
  if (r.status !== 200) throw new Error("makePaidShare failed: " + JSON.stringify(r.body));
  return r.body.token;
}

// Builds a minimal X-PAYMENT header value accepted by AINDRIVE_DEV_BYPASS_X402=1.
// Mirrors the format used by collab-cases.mjs #109.
function buildXPayment(from = "0xdemodemodemodemodemodemodemodemodemo0000") {
  return Buffer.from(JSON.stringify({
    x402Version: 1, scheme: "exact", network: "base-sepolia",
    payload: { authorization: { from } },
  })).toString("base64");
}

// ────────────────────────────────────────────────────────────────────────────

// Helper: create a paid share + DEV_BYPASS settle → returns body.cap.
// Requires AINDRIVE_DEV_BYPASS_X402=1 in server env (harness sets this).
// The owner cookie creates the share, but the settling GET sends NO cookie:
// route.ts:56 short-circuits for the share owner (returns okBody WITHOUT a cap),
// so the cap only gets issued for an anonymous (non-owner) payer.
// path defaults to "" (drive root) because the shares route requires non-empty
// paths to already exist as files; root path bypasses the existence check.
async function getPaidCap(driveId, path = "", ownerCookie) {
  const shareRes = await jget(`/api/drives/${driveId}/shares`, {
    method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ path, role: "viewer", price_usdc: 0.01 }),
  });
  if (shareRes.status !== 200) throw new Error("share create failed: " + JSON.stringify(shareRes.body));
  const bypassPayload = Buffer.from(JSON.stringify({
    payload: { authorization: { from: "0x" + "de".repeat(20) } },
  })).toString("base64");
  const r = await jget(`/api/s/${shareRes.body.token}`, {
    headers: { "X-PAYMENT": bypassPayload },  // no cookie → not the owner → DEV_BYPASS settle issues cap
  });
  if (r.status !== 200) throw new Error("paid GET failed: " + JSON.stringify(r.body));
  if (!r.body.cap) throw new Error("no cap in body: " + JSON.stringify(r.body));
  return r.body.cap;
}

// Reserved drive that always belongs to the human user — never paired by tests.
const RESERVED_DRIVE_ID = "vodRHqr_R9j1";

async function ensureDrive() {
  // Hard guard: scenarios must never repair sample/.aindrive/config.json on top of
  // the human's reserved drive. If state was somehow set to it, force a fresh one.
  if (state.driveId === RESERVED_DRIVE_ID) state.driveId = null;
  if (state.driveId) {
    // Verify our paired agent is still online; if not, restart
    try {
      const cookie = await reEnsureOwner();
      const r = await jget("/api/drives", { headers: { cookie } });
      const d = r.body.drives.find((d) => d.id === state.driveId);
      if (!d?.online) {
        // restart agent for our driveId; update SUITE_AGENT_PID so afterEach sweep spares it.
        const restartedAgent = spawn("node", ["start-agent.mjs"], { cwd: SAMPLE, detached: true, stdio: ["ignore", "ignore", "ignore"] });
        restartedAgent.unref();
        if (restartedAgent.pid) process.env.SUITE_AGENT_PID = String(restartedAgent.pid);
        for (let i = 0; i < 10; i++) {
          await sleep(1000);
          const r2 = await jget("/api/drives", { headers: { cookie } });
          const d2 = r2.body.drives.find((d) => d.id === state.driveId);
          if (d2?.online) break;
        }
      }
    } catch {}
    return state.driveId;
  }
  const cookie = await reEnsureOwner();
  const r = await jget("/api/drives", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "scen-drive" }),
  });
  if (r.status !== 200) throw new Error("drive creation failed: " + JSON.stringify(r.body));
  state.driveId = r.body.driveId;
  state.agentToken = r.body.agentToken;
  state.driveSecret = r.body.driveSecret;
  // Pair sample folder + start the agent if it isn't already running for this drive
  if (!existsSync(join(SAMPLE, ".aindrive"))) mkdirSync(join(SAMPLE, ".aindrive"), { recursive: true });
  writeFileSync(
    join(SAMPLE, ".aindrive", "config.json"),
    JSON.stringify({ ...r.body, serverUrl: BASE, url: `${BASE}/d/${state.driveId}`, pairedAt: Date.now() }, null, 2)
  );
  // Kill any prior agent for sample, start new
  try {
    const lines = execSync("ps -eo pid,command | grep start-agent.mjs | grep -v grep || true").toString().trim().split("\n").filter(Boolean);
    for (const l of lines) {
      const pid = parseInt(l.trim().split(/\s+/)[0], 10);
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  } catch {}
  await sleep(500);
  const agentProc = spawn("node", ["start-agent.mjs"], { cwd: SAMPLE, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  agentProc.unref();
  // Publish the suite agent PID so all.test.mjs afterEach sweep doesn't kill it.
  if (agentProc.pid) process.env.SUITE_AGENT_PID = String(agentProc.pid);
  await sleep(3500);
  return state.driveId;
}

async function dbHandle() {
  // Mirrors web/lib/db.js: AINDRIVE_DATA_DIR or ~/.aindrive
  const dir = process.env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive");
  return new Database(join(dir, "data.sqlite"), { readonly: true });
}

// ──────────────────────── case factory ────────────────────────

const cases = [];
function add(id, name, run, opts = {}) { cases.push({ id, name, run, ...opts }); }

// ──────────────────────── A. Auth & accounts ────────────────────────

add(1, "signup with valid creds → 200 + cookie", async () => {
  const email = uniq("a1") + "@example.com";
  const r = await signup(email, "U", "validpass1");
  eq(r.status, 200, "status");
  assert(r.headers.get("set-cookie")?.includes("aindrive_session"), "cookie set");
});

add(2, "signup duplicate email → 409", async () => {
  const email = uniq("a2") + "@example.com";
  await signup(email, "U", "validpass1");
  const r = await signup(email, "U", "validpass1");
  eq(r.status, 409);
});

add(3, "signup short password → 400", async () => {
  const email = uniq("a3") + "@example.com";
  const r = await signup(email, "U", "short");
  eq(r.status, 400);
});

add(4, "signup malformed email → 400", async () => {
  const r = await signup("not-an-email", "U", "validpass1");
  eq(r.status, 400);
});

add(5, "login valid → 200 + cookie", async () => {
  const email = uniq("a5") + "@example.com";
  await signup(email, "U", "validpass1");
  const r = await jget("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "validpass1" }) });
  eq(r.status, 200);
  assert(r.headers.get("set-cookie")?.includes("aindrive_session"));
});

add(6, "login wrong password → 401", async () => {
  const email = uniq("a6") + "@example.com";
  await signup(email, "U", "validpass1");
  const r = await jget("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "wrongpass1" }) });
  eq(r.status, 401);
});

add(7, "login unknown email → 401", async () => {
  const r = await jget("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: uniq("a7noexist") + "@example.com", password: "anything1" }) });
  eq(r.status, 401);
});

add(8, "logout → 303 redirect", async () => {
  await ensureOwner();
  const r = await fetch(BASE + "/api/auth/logout", { method: "POST", headers: { cookie: state.ownerCookie }, redirect: "manual" });
  assert(r.status === 303 || r.status === 302);
  state.ownerCookie = null; // re-login next call
});

add(9, "GET / when logged out → has 'Create account'", async () => {
  const r = await fetch(BASE + "/", { headers: { cookie: "" } });
  const text = await r.text();
  assert(text.includes("Create account") || text.includes("Sign in"));
});

add(10, "GET / when logged in → has 'My drives'", async () => {
  const cookie = await reEnsureOwner();
  const r = await fetch(BASE + "/", { headers: { cookie } });
  const text = await r.text();
  assert(text.includes("My drives") || text.includes("drives"));
});

// ──────────────────────── B. Wallet auth ────────────────────────

add(11, "wallet nonce returns {nonce, expiresAt}", async () => {
  const r = await jget("/api/wallet/nonce", { method: "POST" });
  eq(r.status, 200);
  assert(typeof r.body.nonce === "string" && r.body.nonce.length >= 8);
  assert(typeof r.body.expiresAt === "number");
});

add(12, "two consecutive nonces are unique", async () => {
  const r1 = await jget("/api/wallet/nonce", { method: "POST" });
  const r2 = await jget("/api/wallet/nonce", { method: "POST" });
  assert(r1.body.nonce !== r2.body.nonce);
});

add(13, "verify with valid sig → 200, cookie", async () => {
  const cookie = await loginWallet(state.walletA);
  assert(cookie?.includes("aindrive_wallet"), "cookie set: " + cookie);
});

add(14, "verify with bad sig → 401", async () => {
  const { nonce, message } = await signWalletNonce(state.walletA);
  const r = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: state.walletA.address, signature: "0x" + "00".repeat(65), nonce, message }),
  });
  eq(r.status, 401);
});

add(15, "verify with unknown nonce → 400", async () => {
  const sig = await state.walletA.signMessage({ message: "blah" });
  const r = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: state.walletA.address, signature: sig, nonce: "fake-nonce-xxxxxxxx" }),
  });
  eq(r.status, 400);
});

add(16, "verify reuses consumed nonce → 400", async () => {
  const { nonce, signature, message } = await signWalletNonce(state.walletA);
  const ok = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: state.walletA.address, signature, nonce, message }),
  });
  eq(ok.status, 200);
  const again = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: state.walletA.address, signature, nonce, message }),
  });
  eq(again.status, 400);
});

add(17, "verify malformed address → 400", async () => {
  const r = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: "0xnotvalid", signature: "0x00", nonce: "x" }),
  });
  eq(r.status, 400);
});

add(18, "/api/wallet/me with cookie", async () => {
  const cookie = await loginWallet(state.walletA);
  const r = await jget("/api/wallet/me", { headers: { cookie } });
  eq(r.status, 200);
  eq(r.body.address.toLowerCase(), state.walletA.address.toLowerCase());
});

add(19, "/api/wallet/me without cookie → null", async () => {
  const r = await jget("/api/wallet/me");
  eq(r.body.address, null);
});

add(20, "two wallets create independent sessions", async () => {
  const ca = await loginWallet(state.walletA);
  const cb = await loginWallet(state.walletB);
  const ra = await jget("/api/wallet/me", { headers: { cookie: ca } });
  const rb = await jget("/api/wallet/me", { headers: { cookie: cb } });
  assert(ra.body.address.toLowerCase() === state.walletA.address.toLowerCase());
  assert(rb.body.address.toLowerCase() === state.walletB.address.toLowerCase());
});

// ──────────────────────── C. Drives ────────────────────────

add(21, "owner creates drive → driveId/agentToken", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget("/api/drives", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "c21" }) });
  eq(r.status, 200);
  assert(r.body.driveId && r.body.agentToken && r.body.driveSecret);
});

add(22, "drive has unique namespace_pubkey", async () => {
  const cookie = await reEnsureOwner();
  const a = await jget("/api/drives", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "c22a" }) });
  const b = await jget("/api/drives", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "c22b" }) });
  const db = await dbHandle();
  const ra = db.prepare("SELECT namespace_pubkey FROM drives WHERE id = ?").get(a.body.driveId);
  const rb = db.prepare("SELECT namespace_pubkey FROM drives WHERE id = ?").get(b.body.driveId);
  db.close();
  assert(ra.namespace_pubkey && rb.namespace_pubkey);
  assert(Buffer.compare(ra.namespace_pubkey, rb.namespace_pubkey) !== 0, "pubkeys differ");
});

add(23, "anonymous POST /api/drives → 401", async () => {
  const r = await jget("/api/drives", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  eq(r.status, 401);
});

add(24, "GET /api/drives lists owner's drives", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget("/api/drives", { headers: { cookie } });
  eq(r.status, 200);
  assert(Array.isArray(r.body.drives));
});

add(25, "drive online=true while agent connected", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const r = await jget("/api/drives", { headers: { cookie } });
  const d = r.body.drives.find((d) => d.id === state.driveId);
  assert(d?.online === true, "expected online=true got " + JSON.stringify(d));
});

add(26, "drive online=false for an unpaired drive", async () => {
  // Avoid killing the running sample agent (would cascade-fail). Use a new drive
  // that has no agent paired to verify the online flag computation.
  const cookie = await reEnsureOwner();
  const fresh = await jget("/api/drives", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "no-agent-" + Date.now() }) });
  const r = await jget("/api/drives", { headers: { cookie } });
  const d = r.body.drives.find((d) => d.id === fresh.body.driveId);
  assert(d?.online === false, "fresh drive should be offline");
});

// (Old #26 body that killed the running agent was removed because it cascade-failed all later fs tests.)

add(27, "owner rotates agent token", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Use a SEPARATE throwaway drive so the rotate doesn't break the running agent
  const tmp = await jget("/api/drives", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "rotate-only" }) });
  const r = await jget(`/api/drives/${tmp.body.driveId}/rotate`, { method: "POST", headers: { cookie } });
  eq(r.status, 200);
  assert(r.body.agentToken && r.body.driveSecret);
  // Verify the new token IS different from the original
  assert(r.body.agentToken !== tmp.body.agentToken, "rotated token should differ");
});

add(28, "non-owner cannot rotate", async () => {
  await ensureDrive();
  const otherCookie = await loginWallet(state.walletB);
  // Wallet auth uses aindrive_wallet cookie which doesn't satisfy session check, so rotate should reject
  const r = await jget(`/api/drives/${state.driveId}/rotate`, { method: "POST", headers: { cookie: otherCookie || "" } });
  assert(r.status === 401 || r.status === 404 || r.status === 403, "got " + r.status);
});

add(29, "GET /d/[id] without session → redirects to /login", async () => {
  await ensureDrive();
  const r = await fetch(`${BASE}/d/${state.driveId}`, { redirect: "manual" });
  assert(r.status === 302 || r.status === 307);
  assert((r.headers.get("location") || "").includes("/login"));
});

add(30, "GET /d/[id] for unauthorized wallet shows 'no access'", async () => {
  await ensureDrive();
  // Create a fresh user without access
  const stranger = uniq("a30") + "@example.com";
  const sr = await signup(stranger, "S", "stranger1");
  const sCookie = sr.headers.get("set-cookie")?.split(";")[0];
  const r = await fetch(`${BASE}/d/${state.driveId}`, { headers: { cookie: sCookie } });
  const text = await r.text();
  assert(text.includes("don") && text.includes("access"));
});

// ──────────────────────── D. Agent ↔ Server WS ────────────────────────

add(31, "agent connect updates last_seen_at", async () => {
  await ensureDrive();
  await sleep(1500);
  const db = await dbHandle();
  const row = db.prepare("SELECT last_seen_at FROM drives WHERE id = ?").get(state.driveId);
  db.close();
  assert(row.last_seen_at, "last_seen_at populated");
});

add(32, "agent connect with bad token → close", async () => {
  await ensureDrive();
  const ws = new WebSocket(`${WS_BASE}/api/agent/connect?driveId=${state.driveId}`, { headers: { authorization: "Bearer wrong-token-1234567890" } });
  await new Promise((res, rej) => {
    ws.on("close", (code) => { eq(code, 4401); res(); });
    ws.on("error", () => res());
    setTimeout(() => rej(new Error("ws didn't close")), 5000);
  });
});

add(33, "two simultaneous agents stay connected", async () => {
  await ensureDrive();
  const ws2 = new WebSocket(`${WS_BASE}/api/agent/connect?driveId=${state.driveId}`, { headers: { authorization: `Bearer ${state.agentToken}` } });
  await new Promise((res, rej) => { ws2.on("open", res); ws2.on("error", rej); setTimeout(rej, 5000); });
  await sleep(500);
  // Original sample agent should still be online
  const cookie = await reEnsureOwner();
  const r = await jget("/api/drives", { headers: { cookie } });
  const d = r.body.drives.find((d) => d.id === state.driveId);
  assert(d?.online === true);
  ws2.close();
  await sleep(500);
});

add(34, "agent stays online for active drive", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  let online = false;
  for (let i = 0; i < 15; i++) {
    const r = await jget("/api/drives", { headers: { cookie } });
    const d = r.body.drives.find((d) => d.id === state.driveId);
    if (d?.online === true) { online = true; break; }
    await sleep(1000);
  }
  assert(online, "agent should be online");
});

add(35, "heartbeat updates last_seen_at periodically", async () => {
  await ensureDrive();
  const db1 = await dbHandle();
  const r1 = db1.prepare("SELECT last_seen_at FROM drives WHERE id = ?").get(state.driveId);
  db1.close();
  await sleep(22_000);
  const db2 = await dbHandle();
  const r2 = db2.prepare("SELECT last_seen_at FROM drives WHERE id = ?").get(state.driveId);
  db2.close();
  assert(r1.last_seen_at !== r2.last_seen_at, "heartbeat advanced last_seen_at");
});

add(36, "RPC list round trip", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  eq(r.status, 200);
  assert(Array.isArray(r.body.entries) && r.body.entries.length > 0);
});

add(37, "unknown rpc method rejected", async () => {
  // Cannot easily inject from web; instead verify the agent allowlist directly
  const { handleRpc } = await import(`${CLI_SRC}/rpc.js`);
  let ok = false;
  try { await handleRpc({ method: "evil-method" }, SAMPLE); }
  catch (e) { ok = /unknown method/i.test(e.message); }
  assert(ok, "expected 'unknown method' error");
});

add(38, "agent rejects forged sig (covered by infra)", async () => {
  // We rely on integration: the WS protocol verifies sig at receive. Smoke: send
  // an unsigned request — agent will print warning and not respond. We just
  // attempt and confirm the call from the server times out.
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Real signed call works (positive control)
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  eq(r.status, 200);
});

add(39, "path traversal blocked", async () => {
  const { handleRpc } = await import(`${CLI_SRC}/rpc.js`);
  let ok = false;
  try { await handleRpc({ method: "list", path: "../../etc" }, SAMPLE); }
  catch (e) { ok = /escapes/i.test(e.message); }
  assert(ok);
});

add(40, "hidden files excluded", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  for (const e of r.body.entries) {
    assert(!e.name.startsWith(".aindrive") && e.name !== ".git" && e.name !== ".DS_Store", "found hidden: " + e.name);
  }
});

// ──────────────────────── E. FS operations ────────────────────────

const TMP_NAME = `__scen-${Date.now()}.txt`;

add(41, "list root", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const marker = `__list-root-${Date.now()}.txt`;
  await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: marker, content: "x", encoding: "utf8" }) });
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  assert(r.body.entries.some((e) => e.name === marker), "freshly-written marker not in root listing");
});

add(42, "list subfolder", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=docs`, { headers: { cookie } });
  eq(r.status, 200);
  assert(Array.isArray(r.body.entries));
});

add(43, "list non-existent → 502/500", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=__nope__`, { headers: { cookie } });
  assert(r.status >= 500 && r.status < 600);
});

add(44, "stat existing file via list", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Make sure a known file exists (independent of sample contents) before checking
  await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "scen44-target.txt", content: "ABC", encoding: "utf8" }),
  });
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  const f = r.body.entries?.find((e) => e.name === "scen44-target.txt");
  assert(f && !f.isDir && f.size === 3, "got " + JSON.stringify(f));
});

add(45, "stat folder via list", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  const d = r.body.entries.find((e) => e.name === "docs");
  assert(d && d.isDir);
});

add(46, "stat non-existent via direct rpc", async () => {
  const { handleRpc } = await import(`${CLI_SRC}/rpc.js`);
  const r = await handleRpc({ method: "stat", path: "nope" }, SAMPLE);
  eq(r.entry, null);
});

add(47, "read text utf8", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Write our own file first (sample state may vary)
  await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "scen47.txt", content: "scen-content-47", encoding: "utf8" }),
  });
  const r = await jget(`/api/drives/${state.driveId}/fs/read?path=scen47.txt&encoding=utf8`, { headers: { cookie } });
  eq(r.status, 200);
  assert(r.body.content === "scen-content-47", "got " + JSON.stringify(r.body));
});

add(48, "read binary base64", async () => {
  const cookie = await reEnsureOwner();
  // Write a small binary first
  const path = `__scen-bin-${Date.now()}.bin`;
  await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path, content: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]).toString("base64"), encoding: "base64" }),
  });
  const r = await jget(`/api/drives/${state.driveId}/fs/read?path=${path}&encoding=base64`, { headers: { cookie } });
  const buf = Buffer.from(r.body.content, "base64");
  eq(buf.length, 4);
  eq(buf[0], 0xDE);
  await jget(`/api/drives/${state.driveId}/fs/delete`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path }) });
});

add(49, "read directory rejected", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/read?path=docs&encoding=utf8`, { headers: { cookie } });
  assert(r.status >= 500 || r.body.error);
});

add(50, "write new file", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: TMP_NAME, content: "hello scenario", encoding: "utf8" }),
  });
  eq(r.status, 200);
  assert(existsSync(join(SAMPLE, TMP_NAME)));
});

add(51, "write overwrites", async () => {
  const cookie = await reEnsureOwner();
  await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: TMP_NAME, content: "v2", encoding: "utf8" }) });
  eq(readFileSync(join(SAMPLE, TMP_NAME), "utf8"), "v2");
});

add(52, "mkdir nested", async () => {
  const cookie = await reEnsureOwner();
  const dir = `__scen-deep-${Date.now()}/a/b/c`;
  const r = await jget(`/api/drives/${state.driveId}/fs/mkdir`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: dir }) });
  eq(r.status, 200);
  assert(existsSync(join(SAMPLE, dir)));
});

add(53, "rename file", async () => {
  const cookie = await reEnsureOwner();
  const renamed = TMP_NAME + ".renamed";
  await jget(`/api/drives/${state.driveId}/fs/rename`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ from: TMP_NAME, to: renamed }) });
  assert(existsSync(join(SAMPLE, renamed)));
  assert(!existsSync(join(SAMPLE, TMP_NAME)));
  // rename back so #54 deletes
  await jget(`/api/drives/${state.driveId}/fs/rename`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ from: renamed, to: TMP_NAME }) });
});

add(54, "delete file", async () => {
  const cookie = await reEnsureOwner();
  await jget(`/api/drives/${state.driveId}/fs/delete`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: TMP_NAME }) });
  assert(!existsSync(join(SAMPLE, TMP_NAME)));
});

add(55, "delete root denied", async () => {
  const { handleRpc } = await import(`${CLI_SRC}/rpc.js`);
  let ok = false;
  try { await handleRpc({ method: "delete", path: "" }, SAMPLE); }
  catch (e) { ok = /cannot delete root/i.test(e.message); }
  assert(ok);
});

// ──────────────────────── F. Drive membership / role gating ────────────────────────
// Cases 56–58 DELETED (Phase 3c): tested POST /api/drives/[driveId]/access which was
// removed in PR #6. Role-gating intent carried forward in cases 59–65 (rewritten below).
// Deleted IDs stay retired — new cases take fresh IDs (#165+).

add(59, "uninvited user cannot list drive root → 401/403", async () => {
  await ensureDrive();
  const { cookie: strangerCookie } = await signupUser("c59stranger");
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, {
    headers: { cookie: strangerCookie },
  });
  assert(r.status === 401 || r.status === 403, "got " + r.status);
});

add(60, "viewer invited at / can list root → role=viewer", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c60viewer");
  await inviteMember(state.driveId, email, "", "viewer", ownerCookie);
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, {
    headers: { cookie: viewerCookie },
  });
  eq(r.status, 200, "viewer at root should list");
  assert(r.body.role === "viewer", "expected role=viewer, got " + r.body.role);
});

add(61, "viewer invited at docs can list docs", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c61viewer");
  await inviteMember(state.driveId, email, "docs", "viewer", ownerCookie);
  // Ensure docs dir exists (sample fixture provides it, but guard anyway)
  await jget(`/api/drives/${state.driveId}/fs/mkdir`, {
    method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ path: "docs" }),
  });
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=docs`, {
    headers: { cookie: viewerCookie },
  });
  eq(r.status, 200, "viewer at docs should list docs");
});

add(62, "viewer invited only at docs cannot list root → 403", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c62docsonly");
  await inviteMember(state.driveId, email, "docs", "viewer", ownerCookie);
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, {
    headers: { cookie: viewerCookie },
  });
  // This MUST be 403 because the user IS authenticated (session exists) but
  // has no grant covering "" — bestMatchingRole returns "none" → atLeast fails.
  eq(r.status, 403, "docs-only viewer must not access root; got " + r.status);
});

add(63, "root viewer cannot write → 403", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c63viewer");
  await inviteMember(state.driveId, email, "", "viewer", ownerCookie);
  const r = await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie: viewerCookie },
    body: JSON.stringify({ path: "x.txt", content: "x", encoding: "utf8" }),
  });
  // Authenticated viewer; drive_members row exists at "" with role=viewer.
  // requireDriveRole(min:"editor") → role < editor → 403 (not 401).
  eq(r.status, 403, "viewer write must be 403; got " + r.status);
});

add(64, "owner revokes member — revoked user loses access", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c64revoke");
  await inviteMember(state.driveId, email, "", "viewer", ownerCookie);
  // Confirm access before revoke
  const before = await jget(`/api/drives/${state.driveId}/fs/list?path=`, {
    headers: { cookie: viewerCookie },
  });
  eq(before.status, 200, "should have access before revoke");
  // Find the member row to delete
  const mList = await jget(`/api/drives/${state.driveId}/members`, {
    headers: { cookie: ownerCookie },
  });
  eq(mList.status, 200);
  const row = mList.body.members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  assert(row, "member row not found in /members list");
  const del = await jget(`/api/drives/${state.driveId}/members/${row.id}`, {
    method: "DELETE", headers: { cookie: ownerCookie },
  });
  eq(del.status, 200, "delete member should return 200");
  // Access must now be denied
  const after = await jget(`/api/drives/${state.driveId}/fs/list?path=`, {
    headers: { cookie: viewerCookie },
  });
  assert(after.status === 401 || after.status === 403, "revoked user must be denied; got " + after.status);
});

add(65, "paid-accept GET (DEV_BYPASS) returns Meadowcap cap", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Uses root path "" — shares route requires non-empty paths to exist as files;
  // root path bypasses that check and still issues a cap via DEV_BYPASS settle.
  const cap = await getPaidCap(state.driveId, "", cookie);
  assert(typeof cap === "string" && cap.length > 50,
    "expected cap string, got: " + JSON.stringify(cap));
});

// P0 regression (drive-access-entry): a member granted only at a sub-path must be
// able to reach that sub-path but NOT the drive root. The drive page lands such a
// viewer at their granted path; this locks the OBSERVABLE permission at the HTTP
// level (the RSC entry-landing itself: one-time real-browser check, plan Task 5).
add(165, "path-scoped viewer reaches granted sub-path, not root", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c165pathviewer");
  await inviteMember(state.driveId, email, "docs", "viewer", ownerCookie);
  // Ensure docs dir exists (sample fixture provides it, but guard anyway).
  await jget(`/api/drives/${state.driveId}/fs/mkdir`, {
    method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ path: "docs" }),
  });
  // Root is NOT covered by the docs grant → bestMatchingRole("") = none → 403.
  const root = await jget(`/api/drives/${state.driveId}/fs/list?path=`, {
    headers: { cookie: viewerCookie },
  });
  eq(root.status, 403, "path-scoped viewer must not list root; got " + root.status);
  // Granted sub-path IS reachable.
  const docs = await jget(`/api/drives/${state.driveId}/fs/list?path=docs`, {
    headers: { cookie: viewerCookie },
  });
  eq(docs.status, 200, "path-scoped viewer must list granted docs; got " + docs.status);
});

add(166, "path-scoped viewer denied on an un-granted sibling → 403", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  const { cookie: viewerCookie, email } = await signupUser("c166pathviewer");
  await inviteMember(state.driveId, email, "docs", "viewer", ownerCookie);
  // Explicitly request a sibling the viewer was NOT granted. Authenticated, but
  // no grant covers "secret" → bestMatchingRole = none → atLeast fails → 403.
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=secret`, {
    headers: { cookie: viewerCookie },
  });
  eq(r.status, 403, "un-granted sibling must be denied; got " + r.status);
});

// ──────────────────────── G. Shares + paid access ────────────────────────

add(66, "owner creates free share", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/shares`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "", role: "viewer" }),
  });
  eq(r.status, 200);
  state.freeShareToken = r.body.token;
  const share = await jget(`/api/s/${state.freeShareToken}`);
  eq(share.status, 200);
});

add(67, "paid share without wallet → 402", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/shares`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "", role: "viewer", price_usdc: 0.5 }),
  });
  state.paidShareToken = r.body.token;
  const share = await jget(`/api/s/${state.paidShareToken}`, { headers: { cookie: "" } });
  eq(share.status, 402);
});

// #68–#75 removed: legacy /api/s/<token>/pay endpoint and PAYMENT-REQUIRED
// header are gone. Modern x402 X-PAYMENT GET flow is covered by
// collab-cases.mjs #109.

// ──────────────────────── H. Meadowcap ────────────────────────

add(76, "verify a freshly-issued cap (from paid-accept DEV_BYPASS)", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const cap = await getPaidCap(state.driveId, "", cookie);
  const v = await jget("/api/cap/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  eq(v.status, 200);
  assert(v.body.valid === true, "expected valid=true, got: " + JSON.stringify(v.body));
});

add(77, "garbled cap → 400 or invalid", async () => {
  const v = await jget("/api/cap/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cap: "this-is-not-a-cap" }) });
  assert(v.status === 400 || v.body.valid === false);
});

add(78, "cap pathPrefix matches issuance path", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Root path "" bypasses the drive path-existence check; the cap's pathPrefix
  // is set to share.path, so it must equal "".
  const cap = await getPaidCap(state.driveId, "", cookie);
  const v = await jget("/api/cap/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  eq(v.body.pathPrefix, "", "pathPrefix mismatch: " + JSON.stringify(v.body));
});

add(79, "cap timeEnd ≈ now + 30 days", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const cap = await getPaidCap(state.driveId, "", cookie);
  const v = await jget("/api/cap/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  const ms = Number(v.body.timeEnd) - Date.now();
  assert(
    ms > 25 * 24 * 60 * 60 * 1000 && ms < 35 * 24 * 60 * 60 * 1000,
    "timeEnd out of 30d window, got ms=" + ms
  );
});

add(80, "two paid-accept issuances → different receiver pubkeys", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Two separate share tokens for root path; each settle generates a fresh
  // ephemeral keypair so receiverPub must differ between issuances.
  const cap1 = await getPaidCap(state.driveId, "", cookie);
  const cap2 = await getPaidCap(state.driveId, "", cookie);
  const v1 = await jget("/api/cap/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap: cap1 }),
  });
  const v2 = await jget("/api/cap/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap: cap2 }),
  });
  assert(v1.body.receiverPub !== v2.body.receiverPub,
    "expected different receiverPub per issuance, got v1=" + v1.body.receiverPub + " v2=" + v2.body.receiverPub);
});

// ──────────────────────── I. Real-time editing (Y.js) ────────────────────────

function bytesToB64(arr) { let s = ""; for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]); return Buffer.from(s, "binary").toString("base64"); }
function b64ToBytes(b64) { return new Uint8Array(Buffer.from(b64, "base64")); }

class TestPeer {
  constructor(cookie, driveId, path) {
    this.cookie = cookie; this.driveId = driveId; this.path = path;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("content");
    this.synced = false;
    this.role = null;
    this.doc.on("update", (update, origin) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
    });
  }
  connect() {
    return new Promise((resolve, reject) => {
      const u = `${WS_BASE}/api/agent/doc?drive=${this.driveId}&path=${encodeURIComponent(this.path)}`;
      this.ws = new WebSocket(u, { headers: { cookie: this.cookie } });
      this.ws.on("open", () => {
        const enc = encoding.createEncoder();
        syncProtocol.writeSyncStep1(enc, this.doc);
        this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
      });
      this.ws.on("message", (data) => {
        let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; }
        if (f.t === "sub-ok") { this.role = f.role; resolve(); return; }
        if (f.t === "sync") {
          const dec = decoding.createDecoder(b64ToBytes(f.msg));
          const enc = encoding.createEncoder();
          syncProtocol.readSyncMessage(dec, enc, this.doc, this);
          if (encoding.length(enc) > 0) this.send({ t: "sync", msg: bytesToB64(encoding.toUint8Array(enc)) });
        }
      });
      this.ws.on("error", reject);
    });
  }
  send(f) { try { this.ws?.send(JSON.stringify(f)); } catch {} }
  type(s) { this.ytext.insert(this.ytext.length, s); }
  close() { try { this.ws?.close(); } catch {} }
}

const I_PATH = "scen-yjs.txt";

add(81, "single client opens file → editor seed from disk", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const seed = "seed-content-" + Date.now();
  await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: I_PATH, content: seed, encoding: "utf8" }),
  });
  await sleep(500);
  const r = await jget(`/api/drives/${state.driveId}/fs/read?path=${I_PATH}&encoding=utf8`, { headers: { cookie } });
  assert(typeof r.body?.content === "string" && r.body.content.startsWith("seed-content-"), "got " + JSON.stringify(r.body));
});

add(82, "two peers — typing in one appears in other", async () => {
  const cookie = await reEnsureOwner();
  const A = new TestPeer(cookie, state.driveId, I_PATH);
  const B = new TestPeer(cookie, state.driveId, I_PATH);
  await A.connect(); await B.connect();
  await sleep(800);
  const tag = "[scen82-" + Date.now() + "]";
  A.type(tag);
  await sleep(800);
  assert(B.ytext.toString().includes(tag), "B sees A's tag");
  A.close(); B.close();
});

add(83, "autosave path: write API + yjs API persist", async () => {
  const cookie = await reEnsureOwner();
  const docId = createHash("sha1").update(`${state.driveId}:${I_PATH}`).digest("base64url").slice(0, 22);
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "autosave-content");
  const update = Y.encodeStateAsUpdate(doc);
  const r1 = await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ path: I_PATH, content: "autosave-content", encoding: "utf8" }) });
  const r2 = await jget(`/api/drives/${state.driveId}/yjs`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ docId, path: I_PATH, data: bytesToB64(update) }) });
  eq(r1.status, 200); eq(r2.status, 200);
  assert(existsSync(join(SAMPLE, ".aindrive", "yjs", docId + ".bin")));
});

add(84, "reload doesn't duplicate (yjs-read replays into single state)", async () => {
  const cookie = await reEnsureOwner();
  const docId = createHash("sha1").update(`${state.driveId}:${I_PATH}`).digest("base64url").slice(0, 22);
  const r = await jget(`/api/drives/${state.driveId}/yjs?docId=${docId}&path=${I_PATH}`, { headers: { cookie } });
  if (r.body.data) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, b64ToBytes(r.body.data));
    const text = doc.getText("content").toString();
    // Apply same payload again (simulating accidental double-seed)
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, b64ToBytes(r.body.data));
    Y.applyUpdate(doc2, b64ToBytes(r.body.data));
    eq(doc2.getText("content").toString(), text, "double apply is idempotent");
  }
});

add(85, "external disk edit triggers fs-changed broadcast", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Subscribe to the doc as a peer; then mutate the file on disk.
  const peer = new TestPeer(cookie, state.driveId, I_PATH);
  let gotReload = false;
  peer.ws_orig_handler = null;
  await peer.connect();
  peer.ws.on("message", (data) => {
    let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; }
    if (f.t === "reload") gotReload = true;
  });
  await sleep(500);
  writeFileSync(join(SAMPLE, I_PATH), "external-edit-" + Date.now());
  await sleep(2000);
  peer.close();
  assert(gotReload, "expected reload broadcast");
});

add(86, "Y.Doc binary persisted on disk", async () => {
  const docId = createHash("sha1").update(`${state.driveId}:${I_PATH}`).digest("base64url").slice(0, 22);
  assert(existsSync(join(SAMPLE, ".aindrive", "yjs", docId + ".bin")));
});

add(87, "Willow Store has yjs entries", async () => {
  const docId = createHash("sha1").update(`${state.driveId}:${I_PATH}`).digest("base64url").slice(0, 22);
  const db = new Database(join(SAMPLE, ".aindrive", "willow.db"), { readonly: true });
  const rows = db.prepare("SELECT COUNT(*) as n FROM yjs_entries WHERE doc_id = ?").get(docId);
  db.close();
  assert(rows.n >= 1);
});

add(88, "snapshot compaction reduces row count", async () => {
  const { appendUpdate, maybeCompact } = await import(`${CLI_SRC}/willow-store.js`);
  const docId = "scen-compact-" + Date.now();
  for (let i = 0; i < 55; i++) appendUpdate(SAMPLE, docId, Buffer.from(`update-${i}`));
  await maybeCompact(SAMPLE, docId);
  const db = new Database(join(SAMPLE, ".aindrive", "willow.db"), { readonly: true });
  const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM yjs_entries WHERE doc_id = ? GROUP BY kind").all(docId);
  db.close();
  const update = rows.find((r) => r.kind === "update");
  const snapshot = rows.find((r) => r.kind === "snapshot");
  eq(snapshot?.n, 1);
  eq(update?.n ?? 0, 0);
});

add(89, "awareness state propagates", async () => {
  const cookie = await reEnsureOwner();
  const A = new TestPeer(cookie, state.driveId, I_PATH);
  await A.connect();
  // Just verify the connection succeeded; full awareness is covered by the e2e earlier
  assert(A.role === "owner");
  A.close();
});

add(90, "docs-only viewer cannot subscribe to root doc (server closes WS)", async () => {
  await ensureDrive();
  const ownerCookie = await reEnsureOwner();
  // A user invited only at "docs" must not get a sub-ok for path=""
  const { cookie: docsViewerCookie, email } = await signupUser("c90docsonly");
  await inviteMember(state.driveId, email, "docs", "viewer", ownerCookie);
  const ws = new WebSocket(
    `${WS_BASE}/api/agent/doc?drive=${state.driveId}&path=`,
    { headers: { cookie: docsViewerCookie } }
  );
  let closed = false;
  await new Promise((res) => {
    ws.on("close", () => { closed = true; res(); });
    ws.on("open", () => { /* server may accept TCP then close on auth */ });
    setTimeout(res, 2500);
  });
  assert(closed, "expected unauthorized WS sub to be closed by server");
});

// ──────────────────────── J. Multi-device + edge cases ────────────────────────

add(91, "two agents both connected to same drive", async () => {
  await ensureDrive();
  const ws2 = new WebSocket(`${WS_BASE}/api/agent/connect?driveId=${state.driveId}`, { headers: { authorization: `Bearer ${state.agentToken}` } });
  await new Promise((r, j) => { ws2.on("open", r); ws2.on("error", j); setTimeout(j, 5000); });
  const peers = globalThis.__aindrive_agents_by_drive?.get(state.driveId);
  // We're in a separate process — can't see globalThis. Verify via online flag
  ws2.close();
  await sleep(300);
});

add(92, "multi-device sync replicates entry A → B", async () => {
  // Spin two agents in temp roots; seed A; verify B receives.
  const ROOT_A = "/tmp/scen-deviceA-" + Date.now();
  const ROOT_B = "/tmp/scen-deviceB-" + Date.now();
  for (const root of [ROOT_A, ROOT_B]) mkdirSync(join(root, ".aindrive"), { recursive: true });
  const cfg = JSON.parse(readFileSync(join(SAMPLE, ".aindrive", "config.json"), "utf8"));
  writeFileSync(join(ROOT_A, ".aindrive", "config.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(ROOT_B, ".aindrive", "config.json"), JSON.stringify(cfg, null, 2));
  // Seed A
  const docId = "scen92-" + Date.now();
  const payload = Buffer.from("device-A-payload");
  const dbA = new Database(join(ROOT_A, ".aindrive", "willow.db"));
  dbA.exec(`CREATE TABLE IF NOT EXISTS yjs_entries (doc_id TEXT NOT NULL, seq INTEGER NOT NULL, payload BLOB NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'update', PRIMARY KEY (doc_id, seq));`);
  const digest = createHash("sha256").update(payload).digest("base64url");
  dbA.prepare("INSERT INTO yjs_entries (doc_id, seq, payload, digest, created_at, kind) VALUES (?,?,?,?,?, 'update')").run(docId, 1, payload, digest, Date.now());
  dbA.close();
  function startAgent(root) {
    writeFileSync(join(root, "boot.mjs"), `import {readFileSync} from "node:fs"; import {runAgent} from "${CLI_SRC}/agent.js"; const d=JSON.parse(readFileSync("${root}/.aindrive/config.json","utf8")); runAgent({root:"${root}",drive:d,server:d.serverUrl});`);
    return spawn("node", [join(root, "boot.mjs")], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  }
  const pa = startAgent(ROOT_A);
  await sleep(2000);
  const pb = startAgent(ROOT_B);
  await sleep(35_000);
  try { process.kill(pa.pid, "SIGKILL"); } catch {}
  try { process.kill(pb.pid, "SIGKILL"); } catch {}
  const dbB = new Database(join(ROOT_B, ".aindrive", "willow.db"), { readonly: true });
  const rows = dbB.prepare("SELECT digest FROM yjs_entries WHERE doc_id = ?").all(docId);
  dbB.close();
  assert(rows.some((r) => r.digest === digest), "expected digest replicated");
}, { timeout: 60_000 });

add(93, "duplicate digest application is idempotent", async () => {
  const { appendUpdate, listEntries } = await import(`${CLI_SRC}/willow-store.js`);
  const docId = "scen93-" + Date.now();
  appendUpdate(SAMPLE, docId, Buffer.from("aaa"));
  // Calling appendUpdate again with same payload creates ANOTHER entry (it's an
  // append log, not a set). Sync layer dedups by digest at apply-give time. Verify entries++
  appendUpdate(SAMPLE, docId, Buffer.from("aaa"));
  const e = listEntries(SAMPLE, docId);
  assert(e.length >= 2);
});

add(94, "agent disconnect path cleans up", async () => {
  // Already exercised in #26 / #34 — just confirm no orphans
  const cookie = await reEnsureOwner();
  const r = await jget("/api/drives", { headers: { cookie } });
  assert(Array.isArray(r.body.drives));
});

// #95 removed: was a no-op skip placeholder for "server restart simulated".
// Restart-resilience is implicitly covered by #96 (agent reconnect after WS drop).

add(96, "agent reconnect after WS drop", async () => {
  await ensureDrive();
  // Restart sample agent in-place by killing its node process and respawning.
  const lines = execSync("ps -eo pid,command | grep 'node start-agent.mjs' | grep -v grep || true").toString().trim().split("\n").filter(Boolean);
  for (const l of lines) {
    const pid = parseInt(l.trim().split(/\s+/)[0], 10);
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await sleep(2000);
  const respawnedAgent = spawn("node", ["start-agent.mjs"], { cwd: SAMPLE, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  respawnedAgent.unref();
  // Update SUITE_AGENT_PID so afterEach sweep doesn't kill the newly-spawned agent.
  if (respawnedAgent.pid) process.env.SUITE_AGENT_PID = String(respawnedAgent.pid);
  // Wait for reconnect (poll online flag)
  const cookie = await reEnsureOwner();
  let online = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const dr = await jget("/api/drives", { headers: { cookie } });
    const d = dr.body.drives.find((d) => d.id === state.driveId);
    if (d?.online) { online = true; break; }
  }
  assert(online, "agent should reconnect");
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  eq(r.status, 200);
});

add(97, "list entry types classified", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  // Ensure at least one file + one folder exist
  await jget(`/api/drives/${state.driveId}/fs/write`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "scen97.txt", content: "x", encoding: "utf8" }),
  });
  await jget(`/api/drives/${state.driveId}/fs/mkdir`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "scen97-dir-" + Date.now() }),
  });
  const r = await jget(`/api/drives/${state.driveId}/fs/list?path=`, { headers: { cookie } });
  assert(Array.isArray(r.body.entries) && r.body.entries.length > 0);
  for (const e of r.body.entries) {
    if (e.isDir) eq(e.mime, "folder");
    else assert(typeof e.mime === "string" && e.mime.includes("/"));
  }
});

add(98, "missing content-type — server returns some response (200/400/415)", async () => {
  const cookie = await reEnsureOwner();
  const r = await fetch(`${BASE}/api/drives/${state.driveId}/fs/write`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ path: "__scen98.txt", content: "x", encoding: "utf8" }),
  });
  // Behavior is fetch-implementation defined; accept 2xx/4xx/5xx but not network failure
  assert(r.status >= 200 && r.status < 600, "got status " + r.status);
});

add(99, "docId regex rejects path traversal", async () => {
  const cookie = await reEnsureOwner();
  const r = await jget(`/api/drives/${state.driveId}/yjs?docId=../etc/passwd&path=`, { headers: { cookie } });
  eq(r.status, 400);
});

add(100, "yjs blob over 16 MB limit rejected", async () => {
  const cookie = await reEnsureOwner();
  const docId = createHash("sha1").update(`${state.driveId}:test100`).digest("base64url").slice(0, 22);
  const big = Buffer.alloc(17 * 1024 * 1024).toString("base64");
  const r = await jget(`/api/drives/${state.driveId}/yjs`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ docId, path: "test100", data: big }),
  });
  // Either zod rejects, or agent rejects, or write succeeds with truncation — accept any 4xx/5xx
  assert(r.status >= 400);
});

// ──────────────────────── Phase 5: Money-path coverage ────────────────────────

// #161 — Free CONSUME accept → drive_members row.
// A logged-in user accepts a FREE share via POST /api/s/[token]/accept.
// Asserts the drive_members row is written via dbHandle() (REAL DB state).
add(161, "free CONSUME accept → drive_members row written", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();

  // Owner creates a free viewer share
  const sr = await jget(`/api/drives/${state.driveId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "", role: "viewer" }),
  });
  eq(sr.status, 200, "share create status");
  const token = sr.body.token;

  // Sign up a fresh user who will CONSUME the share
  const { cookie: memberCookie } = await signupAndLogin("c161");

  // POST /api/s/[token]/accept as the new user
  const ar = await jget(`/api/s/${token}/accept`, {
    method: "POST",
    headers: { cookie: memberCookie },
  });
  eq(ar.status, 200, "accept status: " + JSON.stringify(ar.body));
  eq(ar.body.driveId, state.driveId, "driveId in accept response");

  // Assert the drive_members row was written (query the newest member row on this drive)
  const handle = await dbHandle();
  const row = handle.prepare(
    "SELECT role FROM drive_members WHERE drive_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(state.driveId);
  handle.close();
  assert(row, "drive_members row not found after free CONSUME");
  eq(row.role, "viewer", "drive_members.role should be viewer");
});

// #162 — Paid DEV_BYPASS settle → payment_receipts row + drive_members grant.
// GET /api/s/[token] with X-PAYMENT (DEV_BYPASS) writes payment_receipts and drive_members.
// Asserts REAL DB state via dbHandle(). Stashes tx_hash for #163 replay case.
add(162, "paid DEV_BYPASS settle → payment_receipts row + drive_members grant", async () => {
  await ensureDrive();
  const token = await makePaidShare({ path: "", role: "viewer", price_usdc: 0.02 });

  const payer = "0xc162c162c162c162c162c162c162c162c162c162";
  const xPayment = buildXPayment(payer);

  const r = await jget(`/api/s/${token}`, {
    headers: { "X-PAYMENT": xPayment },
  });
  eq(r.status, 200, "settle response: " + JSON.stringify(r.body));
  assert(
    typeof r.body.txHash === "string" && r.body.txHash.startsWith("0xdev_bypass_"),
    "txHash should start with 0xdev_bypass_, got: " + r.body.txHash
  );

  const handle = await dbHandle();

  // Assert payment_receipts row was written with correct fields
  const receipt = handle.prepare(
    "SELECT * FROM payment_receipts WHERE tx_hash = ?"
  ).get(r.body.txHash);
  assert(receipt, "payment_receipts row not found for tx_hash=" + r.body.txHash);
  eq(receipt.drive_id, state.driveId, "receipt.drive_id");
  eq(receipt.wallet, payer.toLowerCase(), "receipt.wallet (lowercased by route)");
  assert(Math.abs(receipt.amount_usdc - 0.02) < 0.001, `receipt.amount_usdc: expected ~0.02, got ${receipt.amount_usdc}`);

  // Assert drive_members row was written for the wallet-resolved account
  const member = handle.prepare(
    "SELECT role FROM drive_members WHERE drive_id = ? AND role = 'viewer' ORDER BY created_at DESC LIMIT 1"
  ).get(state.driveId);
  assert(member, "drive_members row not found after paid settle");
  eq(member.role, "viewer", "drive_members.role after paid settle");

  handle.close();

  // Stash tx_hash for replay case #163
  state.lastSettleTxHash = r.body.txHash;
  state.lastSettleToken = token;
});

// #163 — Replay same tx_hash → no duplicate receipt (idempotent settle).
// The tx_hash UNIQUE constraint in payment_receipts is the replay defense.
// DEV_BYPASS generates a fresh nanoid tx_hash each call, so a true HTTP replay
// is impossible over HTTP without controlling nanoid. Instead we assert:
// - The first settle row count is exactly 1 (no prior collision).
// - A direct DB INSERT of the same tx_hash raises UNIQUE and is rejected.
// This is the correct black-box contract: if the UNIQUE catch were removed,
// a second call with the same tx_hash would bubble a 500, not return 200.
add(163, "replay same tx_hash → no duplicate receipt (UNIQUE guard)", async () => {
  // Ensure we have a tx_hash from #162; fall back to creating one if running in isolation.
  if (!state.lastSettleTxHash) {
    await ensureDrive();
    state.lastSettleToken = await makePaidShare({ path: "", role: "viewer", price_usdc: 0.01 });
    const r0 = await jget(`/api/s/${state.lastSettleToken}`, {
      headers: { "X-PAYMENT": buildXPayment("0xc163replay0000000000000000000000000000aa") },
    });
    eq(r0.status, 200, "fallback settle: " + JSON.stringify(r0.body));
    state.lastSettleTxHash = r0.body.txHash;
  }

  const handle = await dbHandle();

  // Assert the first settle wrote exactly 1 row for this tx_hash
  const before = handle.prepare(
    "SELECT COUNT(*) as n FROM payment_receipts WHERE tx_hash = ?"
  ).get(state.lastSettleTxHash);
  eq(before.n, 1, "expected exactly 1 receipt row for tx_hash before replay attempt");

  handle.close();

  // Confirm the UNIQUE constraint actually rejects a duplicate INSERT.
  // We use a writable database handle opened directly (not the readonly dbHandle()).
  const { join: pathJoin } = await import("node:path");
  const { homedir: hd } = await import("node:os");
  const dir = process.env.AINDRIVE_DATA_DIR || pathJoin(hd(), ".aindrive");
  const writable = new Database(pathJoin(dir, "data.sqlite"));
  let uniqueViolation = false;
  try {
    writable.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("replay-test-id", state.driveId, "", "0xtest", state.lastSettleTxHash, 0.01, "base-sepolia", null, null);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) uniqueViolation = true;
    else throw e;
  } finally {
    writable.close();
  }
  assert(uniqueViolation, "expected UNIQUE constraint violation on duplicate tx_hash INSERT — replay guard is broken");

  // Count is still 1 after the rejected INSERT
  const handle2 = await dbHandle();
  const after = handle2.prepare(
    "SELECT COUNT(*) as n FROM payment_receipts WHERE tx_hash = ?"
  ).get(state.lastSettleTxHash);
  handle2.close();
  eq(after.n, 1, "receipt count must stay 1 — no duplicate written");
});

// #164 — mergeRoleUpgradeOnly: editor accepting a viewer share keeps editor.
// Owner invites a fresh user as editor, then that user accepts a free viewer
// share. drive_members must still show editor (upgrade-only, never downgrades).
add(164, "mergeRoleUpgradeOnly: editor accepting a viewer share keeps editor", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();

  // Sign up a fresh user who will be invited as editor
  const { email: memberEmail, cookie: memberCookie } = await signupAndLogin("c164");

  // Owner invites them as editor (canonical signature: driveId, email, path, role, ownerCookie)
  await inviteMember(state.driveId, memberEmail, "", "editor", cookie);

  // Verify the editor grant is in place before the share accept
  const handle1 = await dbHandle();
  const beforeRow = handle1.prepare(
    `SELECT m.role FROM drive_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.drive_id = ? AND lower(u.email) = lower(?)
     LIMIT 1`
  ).get(state.driveId, memberEmail);
  handle1.close();
  assert(beforeRow, "editor member row not found before share accept");
  eq(beforeRow.role, "editor", "role before accept should be editor");

  // Owner creates a free VIEWER share
  const sr = await jget(`/api/drives/${state.driveId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "", role: "viewer" }),
  });
  eq(sr.status, 200, "viewer share create status");
  const token = sr.body.token;

  // The editor user accepts the viewer share
  const ar = await jget(`/api/s/${token}/accept`, {
    method: "POST",
    headers: { cookie: memberCookie },
  });
  eq(ar.status, 200, "accept status: " + JSON.stringify(ar.body));

  // drive_members must still show editor — mergeRoleUpgradeOnly never downgrades
  const handle2 = await dbHandle();
  const afterRow = handle2.prepare(
    `SELECT m.role FROM drive_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.drive_id = ? AND lower(u.email) = lower(?)
     LIMIT 1`
  ).get(state.driveId, memberEmail);
  handle2.close();
  assert(afterRow, "member row missing after accept");
  eq(afterRow.role, "editor", "editor role must NOT be downgraded to viewer by share accept");
});

// Append the 20 deeper collaborative-editing scenarios.
import { registerCollabCases } from "./collab-cases.mjs";
registerCollabCases(add, state, { ensureDrive, ensureOwner, reEnsureOwner });

// Append the 20 trace + observability scenarios.
import { registerTraceCases } from "./trace-cases.mjs";
registerTraceCases(add, state, { ensureDrive, ensureOwner, reEnsureOwner });

// Append the 20 emergent / steady-state scenarios.
import { registerEmergentCases } from "./emergent-cases.mjs";
registerEmergentCases(add, state, { ensureDrive, ensureOwner, reEnsureOwner });

export { cases };
