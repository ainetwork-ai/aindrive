// The pay skills: gated by AINDRIVE_AGENT_WALLETS and the `pay` ctx flag,
// x402_wallet → x402_sign → x402_settle round trip (dev bypass), and what
// tools/list offers on /mcp and /mcp/d/[driveId] with / without wallet:pay.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTypedData } from "viem";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-pay-skills-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";
process.env.AINDRIVE_DEV_BYPASS_X402 = "1";
process.env.AINDRIVE_AGENT_WALLETS = "1";

const { db } = await import("../db.js");
const { runSkill, PAY_SKILL_NAMES, skillGroup, driveScopedDescriptors } = await import("../../shared/agent-skills");
const { agentWalletOf, accountOfAgentWallet } = await import("../agent-wallets");
const acct = await import("../account-tokens");
const oauth = await import("../oauth");
const { sign } = await import("../session.js");
const mcpRoute = await import("../../app/mcp/route.js");
const driveRoute = await import("../../app/mcp/d/[driveId]/route.js");

const REQ = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "36230000",
  payTo: "0x000000000000000000000000000000000000dEaD",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
};

async function rpc(handler: (req: Request) => Promise<Response>, bearer: string, method: string, params: unknown) {
  const res = await handler(new Request("http://drive.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
  return JSON.parse(line.replace(/^data:\s*/, ""));
}

describe("x402 pay skills", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u1", "u@example.com", "U", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u2", "v@example.com", "V", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "u1", "D1", "h", "s");
  });

  it("are the pay group and are refused without ctx.pay", async () => {
    for (const n of PAY_SKILL_NAMES) expect(skillGroup(n)).toBe("pay");
    const r = await runSkill({ userId: "u1" }, "x402_wallet", {});
    expect(r.kind).toBe("err");
    expect((r as { message: string }).message).toMatch(/wallet:pay/);
  });

  it("wallet is stable per account and looked up by address", async () => {
    const a = await runSkill({ userId: "u1", pay: true }, "x402_wallet", {});
    const b = await runSkill({ userId: "u1", pay: true }, "x402_wallet", {});
    expect(a.kind).toBe("ok");
    const addr = (a as { structured: { address: string } }).structured.address;
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect((b as { structured: { address: string } }).structured.address).toBe(addr);
    expect(accountOfAgentWallet(addr)).toBe("u1");
    expect(agentWalletOf("u2").address).not.toBe(addr);
  });

  it("sign → a real EIP-3009 authorization by the agent wallet; settle → the facilitator reply", async () => {
    const signed = await runSkill({ userId: "u1", pay: true }, "x402_sign", { x402Version: 2, paymentRequirements: REQ, resource: { url: "http://gift.test/g/1" } });
    expect(signed.kind).toBe("ok");
    const { paymentPayload } = (signed as { structured: { paymentPayload: { x402Version: number; resource: { url: string }; accepted: typeof REQ; payload: { signature: `0x${string}`; authorization: Record<string, string> } } } }).structured;
    expect(paymentPayload.x402Version).toBe(2);
    expect(paymentPayload.resource.url).toBe("http://gift.test/g/1");
    expect(paymentPayload.accepted).toEqual(REQ);
    const a = paymentPayload.payload.authorization;
    expect(a.from).toBe(agentWalletOf("u1").address);
    expect(a.to.toLowerCase()).toBe(REQ.payTo.toLowerCase());
    expect(a.value).toBe(REQ.amount);
    const ok = await verifyTypedData({
      address: a.from as `0x${string}`,
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: REQ.asset as `0x${string}` },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
      signature: paymentPayload.payload.signature,
    });
    expect(ok).toBe(true);

    const settled = await runSkill({ userId: "u2", pay: true }, "x402_settle", { paymentPayload, paymentRequirements: REQ });
    expect(settled.kind).toBe("ok");
    const s = (settled as { structured: { success: boolean; transaction: string; payer: string; network: string; bypass: boolean } }).structured;
    expect(s.success).toBe(true);
    expect(s.transaction).toMatch(/^0xdev_bypass_/);
    expect(s.payer).toBe(a.from.toLowerCase());
    expect(s.network).toBe(REQ.network);
    expect(s.bypass).toBe(true);
  });

  it("refuses permit2 and malformed requirements", async () => {
    const p2 = await runSkill({ userId: "u1", pay: true }, "x402_sign", { paymentRequirements: { ...REQ, extra: { ...REQ.extra, assetTransferMethod: "permit2" } } });
    expect(p2.kind).toBe("err");
    const bad = await runSkill({ userId: "u1", pay: true }, "x402_sign", { paymentRequirements: { scheme: "exact" } });
    expect(bad.kind).toBe("err");
    const nopayload = await runSkill({ userId: "u1", pay: true }, "x402_settle", { paymentRequirements: REQ });
    expect(nopayload.kind).toBe("err");
  });

  it("legacy /mcp lists the pay tools for a session and runs them", async () => {
    const jwt = await sign("u1");
    const list = await rpc(mcpRoute.POST, jwt, "tools/list", {});
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining([...PAY_SKILL_NAMES]));
    const call = await rpc(mcpRoute.POST, jwt, "tools/call", { name: "x402_wallet", arguments: {} });
    expect(call.result.structuredContent.address).toBe(agentWalletOf("u1").address);
  });

  it("/mcp/d/[driveId] offers them only to a wallet:pay account grant", async () => {
    const clientId = oauth.registerClient("Test", ["https://test.example/cb"]).client_id;
    const without = acct.issueAccountTokens({ userId: "u1", clientId, clientName: "Test", scopes: ["drives:read"] });
    const withPay = acct.issueAccountTokens({ userId: "u1", clientId, clientName: "Test", scopes: ["drives:read", "wallet:pay"] });
    const handler = (req: Request) => driveRoute.POST(req, { params: Promise.resolve({ driveId: "d1" }) });
    const a = await rpc(handler, without.access_token, "tools/list", {});
    expect(a.result.tools.map((t: { name: string }) => t.name)).not.toContain("x402_sign");
    const b = await rpc(handler, withPay.access_token, "tools/list", {});
    expect(b.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining([...PAY_SKILL_NAMES]));
    const denied = await rpc(handler, without.access_token, "tools/call", { name: "x402_wallet", arguments: {} });
    expect(denied.result.isError).toBe(true);
    expect(driveScopedDescriptors("read", { pay: true }).some((d) => d.name === "x402_settle")).toBe(true);
  });
});
