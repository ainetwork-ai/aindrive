// Account grant drives:write / drives:sell: scope parsing, which tools
// /mcp/d/[driveId] lists per scope, the creator-only sale tools, and the
// checkout relay crediting a bearer account on /api/s/[token].
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-sale-tools-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";
process.env.AINDRIVE_DEV_BYPASS_X402 = "1";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

// The CLI agent: `art/red.png` exists; `agent.online = false` mimics
// lib/agents.js when no agent is connected.
const agent = { online: true };
vi.mock("../rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  return {
    AgentError,
    callAgent: async (_d: string, _s: string, req: { method: string; path: string }) => {
      if (!agent.online) throw new AgentError("agent offline", 504);
      if (req.method === "stat") return req.path === "art/red.png" ? { entry: { name: "red.png", isDir: false, size: 3 } } : {};
      if (req.method === "list") return { entries: req.path === "art" ? [{ name: "red.png", isDir: false }] : [] };
      return { ok: true };
    },
  };
});

const { db } = await import("../db.js");
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const { TOKEN_PRESETS } = await import("../payment-tokens");
const { runSkill } = await import("../../shared/agent-skills");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");
const shareRoute = await import("../../app/api/s/[token]/route.js");
const asMetaRoute = await import("../../app/.well-known/oauth-authorization-server/route.js");

const PAYOUT = "0x1111111111111111111111111111111111111111";
const FANCO = "0x187e30921D687583E5E35f3Dc6474F59A6e6FE5B";
const READ_TOOLS = ["list_files", "read_file", "stat", "search"];
const SALE_TOOLS = [
  "list_shares", "create_share", "update_share", "delete_share",
  "get_sale_settings", "set_payout_wallet", "set_token_policy", "list_receipts",
];
let clientId = "";

const issue = (userId: string, scope: string) =>
  acct.issueAccountTokens({ userId, clientId, clientName: "Afan", scopes: oauth.parseAccountScopes(scope) }).access_token;

function rpc(driveId: string, token: string, body: unknown) {
  return mcpRoute.POST(
    new Request(`http://drive.test/mcp/d/${driveId}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ driveId }) },
  );
}

async function rpcResult(res: Response): Promise<any> {
  const text = await res.text();
  const data = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

async function toolNames(driveId: string, token: string): Promise<string[]> {
  const list = await rpcResult(await rpc(driveId, token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
  return list.result.tools.map((t: { name: string }) => t.name);
}

/** tools/call → the MCP result ({ isError?, content, structuredContent }). */
async function call(driveId: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await rpc(driveId, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  expect(res.status).toBe(200);
  return (await rpcResult(res)).result;
}

const errText = (r: any): string => (r.isError ? r.content[0].text : "");

let ownerSell = "";

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("coowner1", "co@example.com", "Co-owner", "x");
  u.run("viewer1", "v@example.com", "Viewer", "x");
  u.run("stranger", "s@example.com", "Stranger", "x");
  u.run("buyer1", "b@example.com", "Buyer", "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("d1", "owner1", "D1", "h", "s");
  d.run("dnowallet", "owner1", "No wallet", "h", "s");
  const m = db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)");
  m.run("m1", "d1", "coowner1", "", "owner");
  m.run("m2", "d1", "viewer1", "", "viewer");
  clientId = oauth.registerClient("Afan", ["https://afan.example/cb"]).client_id;
  ownerSell = issue("owner1", "drives:read drives:sell");
});

describe("account scopes drives:write / drives:sell", () => {
  it("parses known scopes in canonical order and drops unknown ones", () => {
    expect(oauth.parseAccountScopes("drives:sell bogus profile drives:write")).toEqual(["profile", "drives:write", "drives:sell"]);
    expect(oauth.accountScopeString(["drives:sell", "drives:read", "profile"])).toBe("profile drives:read drives:sell");
  });

  it("validateAuthorize accepts the new scopes and still rejects mixed / unknown requests", () => {
    const params = (scope: string) => ({
      response_type: "code", client_id: clientId, redirect_uri: "https://afan.example/cb",
      code_challenge: "c".repeat(43), code_challenge_method: "S256", scope, state: null, resource: null,
    });
    const ok = oauth.validateAuthorize(params("drives:sell drives:write profile drives:read"));
    expect(ok.ok && ok.value.driveId === null && ok.value.accountScopes)
      .toEqual(["profile", "drives:read", "drives:write", "drives:sell"]);
    const sellOnly = oauth.validateAuthorize(params("drives:sell"));
    expect(sellOnly.ok && sellOnly.value.driveId === null && sellOnly.value.accountScopes).toEqual(["drives:sell"]);
    const err = (scope: string) => { const v = oauth.validateAuthorize(params(scope)); return v.ok ? null : v.error; };
    expect(err("drives:sell drive:write")).toMatch(/can't be combined/);
    expect(err("drives:sell drives:admin")).toMatch(/Unknown scope: drives:admin/);
  });

  it("the token keeps the granted set and the AS metadata advertises it", async () => {
    const pair = acct.issueAccountTokens({ userId: "owner1", clientId, clientName: "Afan", scopes: ["drives:sell", "profile", "drives:write"] });
    expect(pair.scope).toBe("profile drives:write drives:sell");
    expect(acct.verifyAccountToken(pair.access_token)?.scopes).toEqual(["profile", "drives:write", "drives:sell"]);
    const meta = await asMetaRoute.GET().json();
    expect(meta.scopes_supported).toEqual(["drive:read", "drive:write", "profile", "drives:read", "drives:write", "drives:sell"]);
  });
});

describe("/mcp/d/[driveId] tools per account scope", () => {
  it("each drives:* scope adds exactly its tools", async () => {
    // a2ui_action (app-only, for the MCP Apps view) rides along whenever a read tool exists.
    expect(await toolNames("d1", issue("owner1", "drives:read"))).toEqual([...READ_TOOLS, "a2ui_action"]);
    expect(await toolNames("d1", issue("owner1", "drives:read drives:write")))
      .toEqual(["list_files", "read_file", "write_file", "delete_path", "stat", "search", "a2ui_action"]);
    expect(await toolNames("d1", issue("owner1", "drives:read drives:sell"))).toEqual([...READ_TOOLS, ...SALE_TOOLS, "a2ui_action"]);
    expect(await toolNames("d1", issue("owner1", "drives:sell"))).toEqual(SALE_TOOLS);
    expect(await toolNames("d1", issue("owner1", "drives:write"))).toEqual(["write_file", "delete_path"]);
  });

  it("sale tool schemas carry no drive_id; a profile-only token is refused", async () => {
    const list = await rpcResult(await rpc("d1", ownerSell, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(JSON.stringify(list.result.tools)).not.toContain("drive_id");
    const res = await rpc("d1", issue("owner1", "profile"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("drives:write runs write_file; the role check still applies (viewer refused)", async () => {
    expect((await call("d1", issue("owner1", "drives:read drives:write"), "write_file", { path: "art/new.txt", content: "x" })).isError)
      .toBeFalsy();
    const viewer = await call("d1", issue("viewer1", "drives:read drives:write"), "write_file", { path: "art/new.txt", content: "x" });
    expect(errText(viewer)).toMatch(/^\[forbidden\] forbidden \(need editor, have viewer\)/);
  });

  it("a read-only token can't call a sale tool (not listed → refused)", async () => {
    const r = await call("d1", issue("owner1", "drives:read"), "create_share", { path: "", price: 1, currency: "USDC" });
    expect(errText(r)).toMatch(/unknown tool: create_share/);
    // runSkill itself refuses sale tools without `sell` (A2A, legacy /mcp, drive tokens).
    expect(await runSkill({ userId: "owner1", driveId: "d1", scope: "write" }, "list_shares", {}))
      .toMatchObject({ kind: "err", code: "forbidden", message: expect.stringContaining("drives:sell") });
    expect(await runSkill({ userId: "owner1" }, "list_receipts", { drive_id: "d1" }))
      .toMatchObject({ kind: "err", code: "forbidden" });
  });
});

describe("sale tools: creator only", () => {
  let shareId = "";
  const ownerArgs = (): Record<string, Record<string, unknown>> => ({
    set_payout_wallet: { wallet: PAYOUT },
    set_token_policy: { tokens: [TOKEN_PRESETS.USDC, { symbol: "FANCO", chain: "base", asset: FANCO, decimals: 18, transferMethod: "permit2" }] },
    create_share: { path: "art/red.png", price: 2.5, currency: "FANCO" },
    list_shares: {},
    update_share: { shareId, price: 3 },
    get_sale_settings: {},
    list_receipts: {},
    delete_share: { shareId },
  });

  it("the owner (creator) runs every sale tool", async () => {
    for (const name of SALE_TOOLS) expect(Object.keys(ownerArgs())).toContain(name);
    const ok = async (name: string) => {
      const r = await call("d1", ownerSell, name, ownerArgs()[name]);
      expect(r.isError, `${name}: ${errText(r)}`).toBeFalsy();
      return r.structuredContent;
    };
    expect(await ok("set_payout_wallet")).toEqual({ ok: true });
    expect(await ok("set_token_policy")).toEqual({ ok: true });
    const created = await ok("create_share");
    expect(created).toMatchObject({ id: expect.any(String), token: expect.any(String) });
    expect(created.url).toBe(`http://drive.test/s/${created.token}`);
    shareId = created.id;
    const { shares } = await ok("list_shares");
    expect(shares[0]).toMatchObject({
      id: shareId, token: created.token, url: created.url, path: "art/red.png", role: "viewer",
      price: 2.5, currency: "FANCO", listed: true, expiresAt: null, createdAt: expect.any(String),
    });
    expect(await ok("update_share")).toEqual({ ok: true });
    expect(db.prepare("SELECT price_usdc FROM shares WHERE id = ?").get(shareId)).toEqual({ price_usdc: 3 });
    const settings = await ok("get_sale_settings");
    expect(settings.payoutWallets).toEqual([{ path: "", wallet: PAYOUT }]);
    expect(settings.allowedTokens.map((t: { symbol: string }) => t.symbol)).toEqual(["USDC", "FANCO"]);
    expect(settings.allowedTokens[1]).toMatchObject({ asset: FANCO, name: null, version: null, transferMethod: "permit2" });
    expect(await ok("list_receipts")).toEqual({ receipts: [] });
    expect(await ok("delete_share")).toEqual({ ok: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM shares WHERE id = ?").get(shareId)).toEqual({ n: 0 });
  });

  it("a member — even a co-owner — gets [forbidden] from every sale tool", async () => {
    for (const who of ["coowner1", "viewer1"]) {
      const token = issue(who, "drives:read drives:sell");
      for (const name of SALE_TOOLS) {
        const r = await call("d1", token, name, ownerArgs()[name]);
        expect(errText(r), `${who} ${name}`).toMatch(/^\[forbidden\] forbidden \(only the drive's creator/);
      }
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM shares WHERE drive_id = 'd1'").get()).toEqual({ n: 0 });
  });

  it("a stranger is refused at the endpoint and by runSkill", async () => {
    const res = await rpc("d1", issue("stranger", "drives:read drives:sell"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
    for (const name of SALE_TOOLS) {
      expect(await runSkill({ userId: "stranger", driveId: "d1", sell: true }, name, ownerArgs()[name]), name)
        .toMatchObject({ kind: "err", code: "forbidden" });
    }
  });
});

describe("sale tool validation matches the HTTP routes", () => {
  it("create_share without a payout wallet fails with the route's message", async () => {
    const r = await call("dnowallet", ownerSell, "create_share", { path: "", price: 1, currency: "USDC" });
    expect(errText(r)).toBe("[invalid_params] set a payout wallet for this folder (or a parent) before selling");
  });

  it("create_share: currency policy, path checks, agent online, required path", async () => {
    expect(errText(await call("d1", ownerSell, "create_share", { path: "", price: 1, currency: "DOGE" })))
      .toBe("[invalid_params] currency not allowed by drive policy");
    expect(errText(await call("d1", ownerSell, "create_share", { path: "art/missing.png", price: 1, currency: "USDC" })))
      .toBe("[invalid_params] path not found in drive");
    expect(errText(await call("d1", ownerSell, "create_share", { path: ".aindrive/x", price: 1, currency: "USDC" })))
      .toMatch(/^\[invalid_params\] invalid input \(path\): reserved path/);
    expect(errText(await call("d1", ownerSell, "create_share", { price: 1, currency: "USDC" }))).toMatch(/path required/);
    expect(errText(await call("d1", ownerSell, "create_share", { path: "", price: -1, currency: "USDC" }))).toMatch(/invalid input \(price\)/);
    agent.online = false;
    try {
      expect(errText(await call("d1", ownerSell, "create_share", { path: "art/red.png", price: 1, currency: "USDC" })))
        .toBe("[internal] agent offline");
      // Root needs no agent, as in POST /shares.
      expect((await call("d1", ownerSell, "create_share", { path: "", price: 1, currency: "USDC", listed: false })).isError).toBeFalsy();
    } finally {
      agent.online = true;
    }
  });

  it("update_share can't turn a free share paid; unknown shares are not_found", async () => {
    db.prepare("INSERT INTO shares (id, drive_id, path, role, token) VALUES ('free1','d1','art','viewer','tokfree1')").run();
    expect(errText(await call("d1", ownerSell, "update_share", { shareId: "free1", price: 2 })))
      .toBe("[invalid_params] revoke and recreate to start charging a free share");
    expect(errText(await call("d1", ownerSell, "update_share", { shareId: "free1" }))).toMatch(/no fields to update/);
    expect(errText(await call("d1", ownerSell, "update_share", { shareId: "nope", listed: false }))).toBe("[not_found] not found");
    expect(errText(await call("d1", ownerSell, "delete_share", { shareId: "nope" }))).toBe("[not_found] not found");
  });

  it("set_payout_wallet checks the address and stores it lowercased", async () => {
    expect(errText(await call("d1", ownerSell, "set_payout_wallet", { wallet: "0x123" }))).toBe("[invalid_params] invalid address");
    expect((await call("d1", ownerSell, "set_payout_wallet", { path: "/art/", wallet: FANCO })).isError).toBeFalsy();
    expect(db.prepare("SELECT wallet FROM drive_payout_wallets WHERE drive_id = 'd1' AND path = 'art'").get())
      .toEqual({ wallet: FANCO.toLowerCase() });
  });

  it("set_token_policy rejects non-Base assets and malformed tokens, keeps the policy on failure", async () => {
    const before = db.prepare("SELECT allowed_tokens FROM drives WHERE id = 'd1'").get();
    const fanco = { symbol: "FANCO", chain: "base", asset: FANCO, decimals: 18, transferMethod: "permit2" };
    expect(errText(await call("d1", ownerSell, "set_token_policy", { tokens: [{ ...fanco, chain: "ethereum" }] })))
      .toMatch(/^\[invalid_params\] FANCO: asset must be a token contract address on Base/);
    expect(errText(await call("d1", ownerSell, "set_token_policy", { tokens: [{ ...fanco, asset: "" }] })))
      .toMatch(/asset must be a token contract address on Base/);
    expect(errText(await call("d1", ownerSell, "set_token_policy", { tokens: [{ ...fanco, decimals: 0 }] })))
      .toBe("[invalid_params] invalid token policy");
    expect(errText(await call("d1", ownerSell, "set_token_policy", { tokens: [] }))).toBe("[invalid_params] invalid token policy");
    expect(db.prepare("SELECT allowed_tokens FROM drives WHERE id = 'd1'").get()).toEqual(before);
  });

  it("list_receipts pages newest first without splitting a timestamp", async () => {
    const ins = db.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    const at = ["2020-01-01 00:00:05", "2020-01-01 00:00:04", "2020-01-01 00:00:03", "2020-01-01 00:00:03", "2020-01-01 00:00:02"];
    at.forEach((t, i) => ins.run(`r${i}`, "d1", "art/red.png", "0xw", `0xtx${i}`, 1 + i, "USDC", "base-sepolia", "s1", "buyer1", t));
    ins.run("other", "dnowallet", "", "0xw", "0xtxother", 9, "USDC", "base-sepolia", null, null, "2020-01-01 00:00:09");

    const page = async (args: Record<string, unknown>) =>
      (await call("d1", ownerSell, "list_receipts", args)).structuredContent.receipts as { txHash: string; settledAt: string }[];
    const p1 = await page({ limit: 3 });
    expect(p1.map((r) => r.txHash)).toEqual(["0xtx0", "0xtx1", "0xtx3", "0xtx2"]); // the 00:00:03 tie stays together
    const p2 = await page({ limit: 3, before: p1[p1.length - 1].settledAt });
    expect(p2.map((r) => r.txHash)).toEqual(["0xtx4"]);
    expect(await page({ limit: 3, before: p2[0].settledAt })).toEqual([]);
    expect((await page({ limit: 2 })).map((r) => r.txHash)).toEqual(["0xtx0", "0xtx1"]);
    expect((await page({})).length).toBe(5);
    expect(p1[0]).toEqual({
      txHash: "0xtx0", path: "art/red.png", wallet: "0xw", amount: 1, currency: "USDC", network: "base-sepolia",
      shareId: "s1", accountId: "buyer1", settledAt: "2020-01-01 00:00:05",
    });
    expect(errText(await call("d1", ownerSell, "list_receipts", { limit: 0 }))).toMatch(/limit must be an integer/);
  });
});

describe("/api/s/[token]: a relayed bearer account gets the purchase", () => {
  const PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00009";
  const sig = (from: string) => Buffer.from(JSON.stringify({ payload: { authorization: { from } } })).toString("base64");
  const get = (headers: Record<string, string>) =>
    shareRoute.GET(new Request("http://drive.test/api/s/tokrelay", { headers }), { params: Promise.resolve({ token: "tokrelay" }) });

  beforeAll(() => {
    db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
      .run("shrelay", "d1", "art/red.png", "viewer", "tokrelay", 4, "USDC", 1);
  });

  it("refuses an invalid account token before any payment; ignores other bearers", async () => {
    cookieJar.clear();
    const bad = await get({ authorization: "Bearer aind_aat_bogus", "PAYMENT-SIGNATURE": sig(PAYER) });
    expect(bad.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM payment_receipts WHERE share_id = 'shrelay'").get()).toEqual({ n: 0 });
    expect((await get({ authorization: "Bearer some.session.jwt" })).status).toBe(402);
  });

  it("credits the settled purchase to the bearer's account, not a wallet account", async () => {
    cookieJar.clear();
    const token = issue("buyer1", "profile");
    expect((await get({ authorization: `Bearer ${token}` })).status).toBe(402);
    const res = await get({ authorization: `Bearer ${token}`, "PAYMENT-SIGNATURE": sig(PAYER) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, driveId: "d1", driveName: "D1", path: "art/red.png", role: "viewer" });
    expect(body.txHash).toMatch(/^0xdev_bypass_/);

    expect(db.prepare("SELECT account_id, wallet FROM payment_receipts WHERE tx_hash = ?").get(body.txHash))
      .toEqual({ account_id: "buyer1", wallet: PAYER.toLowerCase() });
    expect(db.prepare("SELECT role FROM drive_members WHERE drive_id = 'd1' AND user_id = 'buyer1' AND path = 'art/red.png'").get())
      .toEqual({ role: "viewer" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM account_wallets WHERE wallet_address = ?").get(PAYER.toLowerCase())).toEqual({ n: 0 });

    // Already entitled: the same account is let through without paying again.
    const again = await get({ authorization: `Bearer ${token}` });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, role: "viewer" });
    // The sale shows up in the owner's list_receipts.
    const r = await call("d1", ownerSell, "list_receipts", { limit: 1 });
    expect(r.structuredContent.receipts[0]).toMatchObject({ txHash: body.txHash, accountId: "buyer1", shareId: "shrelay", amount: 4 });
  });
});
