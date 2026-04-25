import { privateKeyToAccount } from "viem/accounts";

const BASE = "http://localhost:3737";
async function jget(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function step(name, fn) {
  console.log(`\n— ${name}`);
  const out = await fn();
  console.log("  ✓", typeof out === "object" ? JSON.stringify(out).slice(0, 300) : out);
  return out;
}

const owner = `cap-${Date.now()}@example.com`;
const r1 = await jget("/api/auth/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: owner, name: "Cap Owner", password: "ownerpass123" }),
});
const ownerCookie = r1.headers.get("set-cookie")?.split(";")[0];

const drive = (await jget("/api/drives", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: ownerCookie },
  body: JSON.stringify({ name: "cap-drive" }),
})).body;
console.log("driveId:", drive.driveId);

const visitor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

// Add visitor wallet — should also issue a cap
const addRes = await step("owner adds wallet (expect cap issued)", async () => {
  const r = await jget(`/api/drives/${drive.driveId}/access`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ wallet_address: visitor.address, path: "research" }),
  });
  if (!r.body.cap) throw new Error("no cap returned");
  return { hasCap: true, capLen: r.body.cap.length };
});

// Verify cap via /api/cap/verify
await step("decode + verify cap", async () => {
  const accessList = await jget(`/api/drives/${drive.driveId}/access`, { headers: { cookie: ownerCookie } });
  const addRow = accessList.body.access[0];
  // Re-add to get a fresh cap (since first add already returned one we have)
  const cap = (await jget(`/api/drives/${drive.driveId}/access`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ wallet_address: visitor.address, path: "fresh-test-" + Date.now() }),
  })).body.cap;

  const verify = await jget("/api/cap/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  if (!verify.body.valid) throw new Error("cap not valid");
  return verify.body;
});

console.log("\n🎉 M4 Meadowcap cap issuance + verify PASSED");
