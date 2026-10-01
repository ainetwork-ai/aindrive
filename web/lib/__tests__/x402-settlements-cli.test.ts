import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { decodeFunctionData, encodeAbiParameters, keccak256, pad, toHex } from "viem";

// Support CLI (scripts/x402-settlements.mjs, docs/X402_PAYMENT_PENDING.md):
// inspect, check the chain read-only, then credit or release explicitly with
// the operator logged. The chain is a fake JSON-RPC server.
const DATA_DIR = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aindrive-x402-cli-"));
process.env.AINDRIVE_DATA_DIR = DATA_DIR;

const { db } = await import("../db.js");
const S = await import("../x402-account-settlements.js");
const { EIP3009_ABI } = await import("../x402-authorization-chain.js");

const WEB = join(__dirname, "..", "..");
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PAYER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAY_TO = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const NETWORK = "eip155:31337";
const T_USED = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
const T_TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));

// --- fake chain -----------------------------------------------------------------------
type FakeTx = { hash: string; block: number; status: "0x1" | "0x0"; logs: { topics: string[]; data: string }[] };
const fake = { head: 1000, used: new Set<string>(), txs: [] as FakeTx[], calls: [] as string[] };
const usedLog = (payer: string, nonce: string) => ({ topics: [T_USED, pad(payer as `0x${string}`), nonce], data: "0x" });
const transferLog = (from: string, to: string, value: bigint) => ({
  topics: [T_TRANSFER, pad(from as `0x${string}`), pad(to as `0x${string}`)],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
let txSeq = 0;
function mine(o: { payer: string; nonce: string; to?: string; value?: bigint; status?: "0x1" | "0x0"; withUsed?: boolean }) {
  const hash = `0x${(++txSeq).toString(16).padStart(64, "c")}`;
  const logs = [];
  if (o.withUsed !== false) logs.push(usedLog(o.payer, o.nonce));
  logs.push(transferLog(o.payer, o.to ?? PAY_TO, o.value ?? 500000n));
  fake.txs.push({ hash, block: fake.head - 10, status: o.status ?? "0x1", logs });
  if (o.withUsed !== false && (o.status ?? "0x1") === "0x1") fake.used.add(`${o.payer}:${o.nonce}`.toLowerCase());
  return hash;
}
const hexn = (n: number) => `0x${n.toString(16)}`;
function rpc(method: string, params: any[]): unknown {
  fake.calls.push(method);
  switch (method) {
    case "eth_chainId": return "0x7a69";
    case "eth_blockNumber": return hexn(fake.head);
    case "eth_call": {
      const { args } = decodeFunctionData({ abi: EIP3009_ABI, data: params[0].data });
      const key = `${args![0]}:${args![1]}`.toLowerCase();
      return encodeAbiParameters([{ type: "bool" }], [fake.used.has(key)]);
    }
    case "eth_getLogs": {
      const f = params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      const out: unknown[] = [];
      for (const tx of fake.txs) {
        if (tx.status !== "0x1" || tx.block < from || tx.block > to) continue;
        tx.logs.forEach((l, i) => {
          if (l.topics[0] !== f.topics[0]) return;
          if (f.topics[1] && l.topics[1].toLowerCase() !== f.topics[1].toLowerCase()) return;
          if (f.topics[2] && l.topics[2].toLowerCase() !== f.topics[2].toLowerCase()) return;
          out.push(logOf(tx, l, i));
        });
      }
      return out;
    }
    case "eth_getTransactionReceipt": {
      const tx = fake.txs.find((t) => t.hash === params[0]);
      if (!tx) return null;
      return {
        transactionHash: tx.hash, transactionIndex: "0x0", blockHash: pad("0x1"), blockNumber: hexn(tx.block),
        from: PAYER, to: ASSET, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null,
        logs: tx.logs.map((l, i) => logOf(tx, l, i)), logsBloom: `0x${"0".repeat(512)}`, status: tx.status, type: "0x2",
      };
    }
    default: throw new Error(`unsupported ${method}`);
  }
}
const logOf = (tx: FakeTx, l: { topics: string[]; data: string }, i: number) => ({
  address: ASSET, topics: l.topics, data: l.data, blockNumber: hexn(tx.block), blockHash: pad("0x1"),
  transactionHash: tx.hash, transactionIndex: "0x0", logIndex: hexn(i), removed: false,
});
let server: Server;
let RPC = "";

function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["scripts/x402-settlements.mjs", ...args], { cwd: WEB, env: { ...process.env, AINDRIVE_DATA_DIR: DATA_DIR } }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err });
    });
  });
}

let nonceSeq = 0;
const freshNonce = () => `0x${(++nonceSeq).toString(16).padStart(64, "b")}`;
let saleSeq = 0;
function unresolvedRow(o: { validBefore?: string } = {}) {
  const n = ++saleSeq;
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc) VALUES (?,?,?,?,?,?)").run(`csh${n}`, "cd1", `c${n}.md`, "viewer", `ctok${n}`, 0.5);
  const nonce = freshNonce();
  const r = S.recordBeforeSettle({
    accountId: "cbuyer", network: NETWORK, asset: ASSET, payer: PAYER, nonce, envelopeHash: "h".repeat(64),
    validBefore: o.validBefore ?? String(Math.floor(Date.now() / 1000) + 3600),
    sale: { shareId: `csh${n}`, driveId: "cd1", path: `c${n}.md`, role: "viewer", amountUsdc: 0.5, currency: "USDC", chain: "base-sepolia", payTo: PAY_TO, amountAtomic: "500000" },
  }, () => false);
  if (r.kind !== "recorded") throw new Error(r.kind);
  return r.row;
}
const status = (id: string) => S.getSettlement(id)!;
const member = (path: string) => db.prepare("SELECT role FROM drive_members WHERE drive_id = 'cd1' AND user_id = 'cbuyer' AND path = ?").get(path) as { role: string } | undefined;

describe("support CLI: scripts/x402-settlements.mjs", () => {
  beforeAll(async () => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("cowner", "cowner@example.com", "o", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("cbuyer", "cbuyer@example.com", "b", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("cd1", "cowner", "cd1", "hcd", "s");
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        const one = (m: { id: number; method: string; params: any[] }) => {
          try { return { jsonrpc: "2.0", id: m.id, result: rpc(m.method, m.params) }; } catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: (e as Error).message } }; }
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    RPC = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  it("list and show: the unresolved row, its log, and the account's receipts for the sale", async () => {
    const row = unresolvedRow();
    const l = await cli(["list"]);
    expect(l.code).toBe(0);
    expect(JSON.parse(l.out).map((r: { id: string }) => r.id)).toContain(row.id);
    const s = await cli(["show", "--id", row.id]);
    expect(s.code).toBe(0);
    const v = JSON.parse(s.out);
    expect(v.settlement).toMatchObject({ id: row.id, status: "unresolved", payer: PAYER, nonce: row.nonce });
    expect(v.events.map((e: { action: string }) => e.action)).toEqual(["recorded"]);
  });

  it("check is read-only: reports the transfer that paid this sale and writes nothing", async () => {
    const row = unresolvedRow();
    const tx = mine({ payer: PAYER, nonce: row.nonce });
    const before = JSON.stringify(status(row.id));
    const c = await cli(["check", "--id", row.id, "--rpc", RPC]);
    expect(c.code).toBe(0);
    const v = JSON.parse(c.out);
    expect(v.authorization_used).toBe(true);
    expect(v.uses).toEqual([expect.objectContaining({ txHash: tx, pays_this_sale: true, existing_receipt: null })]);
    expect(v.advice).toMatch(/credit/);
    expect(JSON.stringify(status(row.id))).toBe(before);
    expect(S.settlementEvents(row.id)).toHaveLength(1);
  });

  it("credit needs --operator and --note", async () => {
    const row = unresolvedRow();
    const tx = mine({ payer: PAYER, nonce: row.nonce });
    expect((await cli(["credit", "--id", row.id, "--tx", tx, "--note", "x", "--rpc", RPC])).code).not.toBe(0);
    expect((await cli(["credit", "--id", row.id, "--tx", tx, "--operator", "alice", "--rpc", RPC])).code).not.toBe(0);
    expect(status(row.id).status).toBe("unresolved");
  });

  it("credit refuses a tx that did not pay this sale (other nonce, other payee, wrong amount, reverted)", async () => {
    const row = unresolvedRow();
    const wrong = [
      mine({ payer: PAYER, nonce: freshNonce() }),
      mine({ payer: PAYER, nonce: row.nonce, to: "0x90f79bf6eb2c4f870365e785982e1f101e93b906" }),
      mine({ payer: PAYER, nonce: row.nonce, value: 1n }),
      mine({ payer: PAYER, nonce: row.nonce, status: "0x0" }),
    ];
    for (const tx of wrong) {
      const r = await cli(["credit", "--id", row.id, "--tx", tx, "--operator", "alice", "--note", "ticket 1", "--rpc", RPC]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/chain check failed/);
    }
    expect(status(row.id).status).toBe("unresolved");
    expect(member(row.path)).toBeUndefined();
  });

  it("credit after the chain check: receipt + membership + credited in one go, operator logged; a second credit with another tx is refused", async () => {
    const row = unresolvedRow();
    const tx = mine({ payer: PAYER, nonce: row.nonce });
    const r = await cli(["credit", "--id", row.id, "--tx", tx, "--operator", "alice", "--note", "ticket 42", "--rpc", RPC]);
    expect(r.code).toBe(0);
    expect(status(row.id)).toMatchObject({ status: "credited", tx_hash: tx, resolved_by: "support:alice", resolution_note: "ticket 42" });
    expect(member(row.path)).toEqual({ role: "viewer" });
    expect(db.prepare("SELECT account_id, share_id, amount_usdc FROM payment_receipts WHERE tx_hash = ?").get(tx))
      .toEqual({ account_id: "cbuyer", share_id: row.share_id, amount_usdc: 0.5 });
    expect(S.settlementEvents(row.id).map((e) => `${e.action}:${e.actor}`)).toEqual(["recorded:server", "credited:support:alice"]);
    const other = mine({ payer: PAYER, nonce: row.nonce });
    expect((await cli(["credit", "--id", row.id, "--tx", other, "--operator", "bob", "--note", "dup", "--skip-chain-check"])).code).not.toBe(0);
  });

  it("credit refuses a tx already receipted for another purchase, even with --skip-chain-check", async () => {
    const row = unresolvedRow();
    const tx = mine({ payer: PAYER, nonce: row.nonce });
    db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`r-${tx.slice(-6)}`, "cd1", "x.md", PAYER, tx, 0.5, "USDC", "base-sepolia", "another", "w_wallet");
    const r = await cli(["credit", "--id", row.id, "--tx", tx, "--operator", "alice", "--note", "n", "--skip-chain-check"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/another purchase/);
    expect(status(row.id).status).toBe("unresolved");
  });

  it("release is refused while the authorization is used on chain (it paid: credit it)", async () => {
    const row = unresolvedRow();
    mine({ payer: PAYER, nonce: row.nonce });
    const r = await cli(["release", "--id", row.id, "--operator", "alice", "--note", "n", "--rpc", RPC]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/IS used/);
    expect(status(row.id).status).toBe("unresolved");
  });

  it("release is refused while the authorization is unused but still valid", async () => {
    const row = unresolvedRow();
    const r = await cli(["release", "--id", row.id, "--operator", "alice", "--note", "n", "--rpc", RPC]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/still valid/);
    expect(status(row.id).status).toBe("unresolved");
  });

  it("release of an unused, expired authorization: released, operator logged; the account is unblocked", async () => {
    const row = unresolvedRow({ validBefore: String(Math.floor(Date.now() / 1000) - 10) });
    expect(S.openSettlementFor("cbuyer", { shareId: row.share_id, driveId: "cd1", path: row.path, role: "viewer" })?.id).toBe(row.id);
    const r = await cli(["release", "--id", row.id, "--operator", "alice", "--note", "expired unused", "--rpc", RPC]);
    expect(r.code).toBe(0);
    expect(status(row.id)).toMatchObject({ status: "released", resolved_by: "support:alice" });
    expect(S.settlementEvents(row.id).map((e) => `${e.action}:${e.actor}`)).toEqual(["recorded:server", "released:support:alice"]);
    expect(S.openSettlementFor("cbuyer", { shareId: row.share_id, driveId: "cd1", path: row.path, role: "viewer" })).toBeUndefined();
  });

  it("release --force skips the chain and says so in the log", async () => {
    const row = unresolvedRow();
    const r = await cli(["release", "--id", row.id, "--operator", "bob", "--note", "buyer confirmed card refund", "--force"]);
    expect(r.code).toBe(0);
    expect(status(row.id).resolution_note).toBe("buyer confirmed card refund [forced]");
  });
});
