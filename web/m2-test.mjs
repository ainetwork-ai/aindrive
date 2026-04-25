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
  console.log("  ✓", typeof out === "object" ? JSON.stringify(out).slice(0, 200) : out);
  return out;
}

const owner = `owner-${Date.now()}@example.com`;

// 1. Owner signup
const signup = await step("owner signup", async () => {
  const r = await jget("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: owner, name: "Owner", password: "ownerpass123" }),
  });
  if (r.status !== 200) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
  return { ok: true, cookie: r.headers.get("set-cookie")?.split(";")[0] };
});
const ownerCookie = signup.cookie;

// 2. Create drive
const drive = await step("create drive", async () => {
  const r = await jget("/api/drives", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ name: "m2-test-drive" }),
  });
  if (r.status !== 200) throw new Error(`drive create failed: ${JSON.stringify(r.body)}`);
  return r.body;
});

// 3. Write drive config to sample folder + start agent
mkdirSync("/mnt/newdata/git/aindrive/sample/.aindrive", { recursive: true });
const cfg = { ...drive, serverUrl: BASE, url: `${BASE}/d/${drive.driveId}`, pairedAt: Date.now() };
writeFileSync("/mnt/newdata/git/aindrive/sample/.aindrive/config.json", JSON.stringify(cfg, null, 2));
const agent = spawn("node", ["start-agent.mjs"], {
  cwd: "/mnt/newdata/git/aindrive/sample",
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
agent.unref();
console.log("  agent pid", agent.pid);
await sleep(4000);

// 4. Create wallet, ensure it's NOT in allowlist yet
const visitor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
console.log(`\nvisitor wallet: ${visitor.address}`);

// 5. Visitor: sign in with wallet
const visitorCookie = await step("visitor wallet sign-in", async () => {
  const nr = await jget("/api/wallet/nonce", { method: "POST" });
  const message = `aindrive wants you to sign in with your wallet.\n\nAddress: ${visitor.address.toLowerCase()}\nNonce: ${nr.body.nonce}`;
  const sig = await visitor.signMessage({ message });
  const vr = await jget("/api/wallet/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: visitor.address, signature: sig, nonce: nr.body.nonce }),
  });
  if (vr.status !== 200) throw new Error("wallet verify failed");
  return vr.headers.get("set-cookie")?.split(";")[0];
});

// 6. Visitor tries to list drive (should fail — not in allowlist)
await step("BEFORE allowlist: visitor list (expect 401/403)", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/fs/list?path=`, {
    headers: { cookie: visitorCookie },
  });
  if (r.status === 200) throw new Error("UNEXPECTED: visitor got access without allowlist");
  return { status: r.status, error: r.body.error };
});

// 7. Owner adds visitor wallet to allowlist
await step("owner adds visitor wallet to allowlist", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/access`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ wallet_address: visitor.address, path: "" }),
  });
  if (r.status !== 200) throw new Error(`add access failed: ${JSON.stringify(r.body)}`);
  return r.body;
});

// 8. Visitor lists again — should now succeed
await step("AFTER allowlist: visitor list (expect 200 + entries)", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/fs/list?path=`, {
    headers: { cookie: visitorCookie },
  });
  if (r.status !== 200) throw new Error(`UNEXPECTED status ${r.status}: ${JSON.stringify(r.body)}`);
  if (!r.body.entries?.length) throw new Error("UNEXPECTED: empty entries");
  return { count: r.body.entries.length, role: r.body.role, names: r.body.entries.map(e => e.name) };
});

// 9. Owner revokes
await step("owner revokes wallet", async () => {
  const list = await jget(`/api/drives/${drive.driveId}/access`, { headers: { cookie: ownerCookie } });
  const id = list.body.access[0].id;
  const r = await jget(`/api/drives/${drive.driveId}/access/${id}`, {
    method: "DELETE",
    headers: { cookie: ownerCookie },
  });
  if (r.status !== 200) throw new Error("revoke failed");
  return r.body;
});

// 10. Visitor lists again — should fail
await step("AFTER revoke: visitor list (expect 401/403)", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/fs/list?path=`, {
    headers: { cookie: visitorCookie },
  });
  if (r.status === 200) throw new Error("UNEXPECTED: visitor still has access after revoke");
  return { status: r.status };
});

console.log("\n🎉 M2.3 wallet-allowlist roundtrip PASSED");
process.kill(agent.pid, "SIGTERM");
