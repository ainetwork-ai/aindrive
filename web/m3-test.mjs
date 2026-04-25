import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "http://localhost:3737";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function step(name, fn) {
  console.log(`\n— ${name}`);
  const out = await fn();
  console.log("  ✓", typeof out === "object" ? JSON.stringify(out).slice(0, 220) : out);
  return out;
}

const owner = `owner-${Date.now()}@example.com`;

// Owner setup
const r1 = await jget("/api/auth/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: owner, name: "Owner", password: "ownerpass123" }),
});
const ownerCookie = r1.headers.get("set-cookie")?.split(";")[0];

const r2 = await jget("/api/drives", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: ownerCookie },
  body: JSON.stringify({ name: "m3-test-drive" }),
});
const drive = r2.body;
console.log("driveId:", drive.driveId);

// Pair sample folder + start agent
mkdirSync("/mnt/newdata/git/aindrive/sample/.aindrive", { recursive: true });
writeFileSync("/mnt/newdata/git/aindrive/sample/.aindrive/config.json",
  JSON.stringify({ ...drive, serverUrl: BASE, url: `${BASE}/d/${drive.driveId}`, pairedAt: Date.now() }, null, 2));
const agent = spawn("node", ["start-agent.mjs"], {
  cwd: "/mnt/newdata/git/aindrive/sample", stdio: ["ignore", "pipe", "pipe"], detached: true,
});
agent.unref();
await sleep(4000);

// Create PAID share
const shareRes = await step("owner creates paid share ($0.50)", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ path: "", role: "viewer", price_usdc: 0.5 }),
  });
  if (r.status !== 200) throw new Error(`share failed: ${JSON.stringify(r.body)}`);
  return r.body;
});
const token = shareRes.token;

// Visitor wallet sign-in
const visitor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const visitorCookie = await step("visitor wallet sign-in", async () => {
  const nr = await jget("/api/wallet/nonce", { method: "POST" });
  const message = `aindrive wants you to sign in with your wallet.\n\nAddress: ${visitor.address.toLowerCase()}\nNonce: ${nr.body.nonce}`;
  const sig = await visitor.signMessage({ message });
  const vr = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: visitor.address, signature: sig, nonce: nr.body.nonce }),
  });
  return vr.headers.get("set-cookie")?.split(";")[0];
});

// Visitor hits share endpoint — expect 402
await step("BEFORE pay: GET /api/s/[token] (expect 402)", async () => {
  const r = await jget(`/api/s/${token}`, { headers: { cookie: visitorCookie } });
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
  if (!r.headers.get("PAYMENT-REQUIRED")) throw new Error("missing PAYMENT-REQUIRED header");
  return { status: r.status, requirements: r.body.paymentRequirements };
});

// Visitor pays (DEV BYPASS — fake tx hash)
await step("visitor pays", async () => {
  const r = await jget(`/api/s/${token}/pay`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: visitorCookie },
    body: JSON.stringify({ txHash: "0xDEADBEEF12345678" }),
  });
  if (r.status !== 200) throw new Error(`pay failed: ${JSON.stringify(r.body)}`);
  return r.body;
});

// AFTER pay: GET should succeed
await step("AFTER pay: GET /api/s/[token] (expect 200)", async () => {
  const r = await jget(`/api/s/${token}`, { headers: { cookie: visitorCookie } });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
});

// AND: visitor can now list files
await step("visitor lists drive contents", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/fs/list?path=`, { headers: { cookie: visitorCookie } });
  if (r.status !== 200) throw new Error(`list failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { count: r.body.entries.length, role: r.body.role };
});

// Owner sees the paid wallet in access list (added_by='payment')
await step("owner sees payment-added wallet", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/access`, { headers: { cookie: ownerCookie } });
  const paymentRow = r.body.access.find(a => a.added_by === "payment");
  if (!paymentRow) throw new Error("no payment-added row");
  if (paymentRow.payment_tx !== "0xDEADBEEF12345678") throw new Error("tx hash mismatch");
  return paymentRow;
});

console.log("\n🎉 M3.3 paywall + auto-grant flow PASSED");
process.kill(agent.pid, "SIGTERM");
