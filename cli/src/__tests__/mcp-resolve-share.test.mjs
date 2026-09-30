import { describe, it, expect } from "vitest";
import { TOOLS } from "../mcp/tools.js";

const tool = TOOLS.find((t) => t.name === "resolve_share");

// The server's 402 for an unpaid paid share (web/app/api/s/[token]/route.ts paymentGate).
function gate402(error = "PAYMENT-SIGNATURE header is required") {
  return Object.assign(new Error(`GET /api/s/tok → 402: ${error}`), {
    status: 402,
    body: {
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:84532", amount: "500000", asset: "0xA5E7", payTo: "0xB0B" }],
      currency: { symbol: "USDC", decimals: 6 },
      error,
    },
    headers: { "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0=" },
  });
}

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    client: {
      server: "https://drive.example",
      get: async (path, opts = {}) => {
        calls.push({ path, headers: opts.headers ?? null });
        const r = responses.shift();
        if (r instanceof Error) throw r;
        return { status: 200, body: r };
      },
    },
  };
}

describe("mcp resolve_share", () => {
  it("returns a free or already-bought share as is", async () => {
    const { client, calls } = fakeClient([{ driveId: "d1", path: "a.md", role: "viewer" }]);
    const r = await tool.handler({ token: "tok" }, { client });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ driveId: "d1", path: "a.md", role: "viewer" });
    expect(calls).toEqual([{ path: "/api/s/tok", headers: null }]);
  });

  it("on 402 reports the price and the x402 requirements instead of sending a fake payment", async () => {
    const { client, calls } = fakeClient([gate402()]);
    const r = await tool.handler({ token: "tok" }, { client });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(1); // no second request with a synthesized X-PAYMENT envelope
    const [head, ...rest] = r.content[0].text.split("\n");
    expect(head).toBe("resolve_share: payment required [HTTP 402]");
    const out = JSON.parse(rest.join("\n"));
    expect(out).toMatchObject({
      error: "payment_required", price: "0.5 USDC", amount: "500000", network: "eip155:84532",
      asset: "0xA5E7", payTo: "0xB0B", scheme: "exact", paymentRequired: "eyJ4NDAyVmVyc2lvbiI6Mn0=",
      buyUrl: "https://drive.example/s/tok",
    });
  });

  it("sends a caller-signed payment as the x402 v2 PAYMENT-SIGNATURE header", async () => {
    const { client, calls } = fakeClient([{ driveId: "d1", txHash: "0xabc" }]);
    const r = await tool.handler({ token: "tok", payment: "c2lnbmVk" }, { client });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ txHash: "0xabc" });
    expect(calls).toEqual([{ path: "/api/s/tok", headers: { "PAYMENT-SIGNATURE": "c2lnbmVk" } }]);
  });

  it("says so when the server refuses the payment", async () => {
    const { client } = fakeClient([gate402("invalid PAYMENT-SIGNATURE header")]);
    const r = await tool.handler({ token: "tok", payment: "bad" }, { client });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^resolve_share: payment not accepted \[HTTP 402\]/);
    expect(r.content[0].text).toContain("invalid PAYMENT-SIGNATURE header");
  });

  it("formats prices without floating point and passes other errors through", async () => {
    const e = gate402();
    e.body.accepts[0].amount = "1234567";
    const { client } = fakeClient([e]);
    const out = JSON.parse((await tool.handler({ token: "t" }, { client })).content[0].text.split("\n").slice(1).join("\n"));
    expect(out.price).toBe("1.234567 USDC");
    const notFound = Object.assign(new Error("GET /api/s/t → 404: share not found"), { status: 404 });
    const c2 = fakeClient([notFound]);
    await expect(tool.handler({ token: "t" }, { client: c2.client })).rejects.toThrow(/404/);
  });

  it("encodes the token in the path", async () => {
    const { client, calls } = fakeClient([{}]);
    await tool.handler({ token: "a/b" }, { client });
    expect(calls[0].path).toBe("/api/s/a%2Fb");
  });
});
