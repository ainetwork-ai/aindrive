import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Paid share bought by an AUTHENTICATED account with an EIP-3009
// authorization (lib/x402-account-settlements.js, docs/X402_PAYMENT_PENDING.md;
// decision docs/11-entitlements.md §6 option 3): no automatic credit from the
// chain, only no second charge. The facilitator and the chain are simulated:
// verify checks a toy signature, the terms and (unless lagging) that the
// nonce is unused, runs the route's beforeSettle hook, then "settles" per
// `fac.mode` into `chain`.
const DATA_DIR = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aindrive-nodouble-"));
process.env.AINDRIVE_DATA_DIR = DATA_DIR;
process.env.AINDRIVE_SUPPORT_URL = "https://support.example/ticket?ref={ref}";
delete process.env.AINDRIVE_DEV_BYPASS_X402;

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

type Auth = { from: string; to: string; value: string | number; nonce: string };
const chain = new Map<string, string>(); // `${from}:${nonce}` → tx
type Mode = "ok" | "lost" | "timeout" | "refused" | "reverted";
const fac = {
  /** ok: mine + answer; lost: mine, answer lost; timeout: nothing mined, no answer;
   *  refused: pre-broadcast refusal; reverted: broadcast reverted (nothing moved, uncertain). */
  mode: "ok" as Mode,
  settleCalls: 0,
  verifyCalls: 0,
  /** A lagging verify node: does not see a used nonce. */
  lagging: false,
  /** Awaited between verify and the hook, per nonce (a slow request). */
  preHold: null as null | ((nonce: string) => Promise<void>),
  /** Awaited after the hook, before settling. */
  hold: null as null | Promise<void>,
};
let txSeq = 0;
const nextTx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;

vi.mock("../x402-facilitator", async (orig) => {
  const real = await orig<typeof import("../x402-facilitator")>();
  return {
    ...real,
    canSettle: () => true,
    verifyAndSettle: async (
      payload: { payload: { signature?: string; authorization?: Auth; permit2Authorization?: { from: string } } },
      req: { payTo: string; amount: string; network: string },
      _label: string,
      opts: { beforeSettle?: () => string | null } = {},
    ) => {
      fac.verifyCalls++;
      // Shape decides the path, as @x402/evm does ("permit2Authorization" in payload).
      if (payload.payload.permit2Authorization) {
        const stop = opts.beforeSettle?.() ?? null;
        if (stop) return { ok: false, status: 409, reason: stop, settle: "not_sent", aborted: true };
        fac.settleCalls++;
        return { ok: true, payer: payload.payload.permit2Authorization.from, transaction: nextTx(), network: req.network, bypass: false };
      }
      const a = payload.payload.authorization!;
      const from = a.from.toLowerCase(), nonce = a.nonce.toLowerCase();
      if (payload.payload.signature !== toySig(from, nonce)) return { ok: false, status: 402, reason: "invalid_exact_evm_signature", settle: "not_sent" };
      if (a.to.toLowerCase() !== req.payTo.toLowerCase() || BigInt(a.value) !== BigInt(req.amount)) return { ok: false, status: 402, reason: "invalid_exact_evm_authorization_value", settle: "not_sent" };
      if (!fac.lagging && chain.has(`${from}:${nonce}`)) return { ok: false, status: 402, reason: "invalid_exact_evm_nonce_already_used", settle: "not_sent" };
      if (fac.preHold) await fac.preHold(nonce);
      const stop = opts.beforeSettle?.() ?? null;
      if (stop) return { ok: false, status: 409, reason: stop, settle: "not_sent", aborted: true };
      fac.settleCalls++;
      if (fac.hold) await fac.hold;
      const mode = fac.mode;
      if (mode === "refused") return { ok: false, status: 402, reason: "invalid_exact_evm_signature", settle: "refused" };
      if (mode === "timeout") return { ok: false, status: 402, reason: "facilitator unavailable, please retry", settle: "uncertain" };
      if (mode === "reverted") return { ok: false, status: 402, reason: "invalid_exact_evm_transaction_failed", settle: "uncertain" };
      // Broadcast: a used nonce reverts (nothing moves).
      if (chain.has(`${from}:${nonce}`)) return { ok: false, status: 402, reason: "invalid_exact_evm_nonce_already_used", settle: "uncertain" };
      const tx = nextTx();
      chain.set(`${from}:${nonce}`, tx);
      if (mode === "lost") return { ok: false, status: 402, reason: "facilitator unavailable, please retry", settle: "uncertain" };
      return { ok: true, payer: from, transaction: tx, network: req.network, bypass: false };
    },
  };
});
// Nothing on a request path may read the chain: any call here fails the test.
const chainCalls: string[] = [];
vi.mock("../x402-authorization-chain.js", () => ({
  clientForNetwork: () => { chainCalls.push("clientForNetwork"); throw new Error("no chain reads on a request path"); },
  authorizationUsed: async () => { chainCalls.push("authorizationUsed"); throw new Error("no chain reads"); },
  findAuthorizationUses: async () => { chainCalls.push("findAuthorizationUses"); throw new Error("no chain reads"); },
  checkPaymentTx: async () => { chainCalls.push("checkPaymentTx"); throw new Error("no chain reads"); },
}));

const { db } = await import("../db.js");
const { GET } = await import("../../app/api/s/[token]/route.js");
const { sign } = await import("../session.js");
const { issueAccountTokens } = await import("../account-tokens.js");
const S = await import("../x402-account-settlements.js");
const bearerFor = (userId: string) => issueAccountTokens({ userId, clientId: "c-test", clientName: "Test", scopes: ["profile"] }).access_token;

const PAYER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYER2 = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const PAY_TO = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const PRICE = "500000"; // 0.5 USDC
const toySig = (from: string, nonce: string) => `0x5169${from.slice(2, 10)}${nonce.slice(2, 10)}`;
let nonceSeq = 0;
const freshNonce = () => `0x${(++nonceSeq).toString(16).padStart(64, "a")}`;
const VALID_BEFORE = String(Math.floor(Date.now() / 1000) + 3600);
function envelope(o: { nonce: string; from?: string; sig?: string; auth?: Record<string, unknown>; extra?: Record<string, unknown> }) {
  const from = o.from ?? PAYER;
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    payload: {
      signature: o.sig ?? toySig(from.toLowerCase(), o.nonce.toLowerCase()),
      authorization: { from, to: PAY_TO, value: PRICE, validAfter: "0", validBefore: VALID_BEFORE, nonce: o.nonce, ...o.auth },
      ...o.extra,
    },
  })).toString("base64");
}
const permit2Envelope = (from: string) => Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x01", permit2Authorization: { from } } })).toString("base64");

let saleSeq = 0;
/** A fresh 0.5 USDC viewer sale on drive nd1 (payout PAY_TO). */
function newSale(o: { path?: string; currency?: string | null } = {}): { token: string; shareId: string; path: string } {
  const n = ++saleSeq;
  const path = o.path ?? `f${n}.md`;
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency) VALUES (?,?,?,?,?,?,?)")
    .run(`nsh${n}`, "nd1", path, "viewer", `ntok${n}`, 0.5, o.currency ?? null);
  return { token: `ntok${n}`, shareId: `nsh${n}`, path };
}

type Who = { user?: string | null; bearer?: string; wallet?: string };
async function buy(token: string, o: Who & { env: string }) {
  cookieJar.clear();
  if (o.user) cookieJar.set("aindrive_session", await sign(o.user));
  const headers: Record<string, string> = { "PAYMENT-SIGNATURE": o.env };
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
  const res = await GET(new Request(`http://localhost/api/s/${token}`, { headers }), { params: Promise.resolve({ token }) });
  return { status: res.status, body: await res.json(), cookie: cookieJar.get("aindrive_wallet") };
}

type Row = import("../x402-account-settlements.js").SettlementRow;
const row = (nonce: string) => db.prepare("SELECT * FROM x402_account_settlements WHERE nonce = ?").get(nonce.toLowerCase()) as Row | undefined;
const events = (id: string) => S.settlementEvents(id).map((e) => `${e.action}:${e.actor}`);
const grantAt = (user: string, path: string) => db.prepare("SELECT role FROM drive_members WHERE drive_id = 'nd1' AND user_id = ? AND path = ?").get(user, path) as { role: string } | undefined;
const receipts = (tx: string) => db.prepare("SELECT account_id, share_id FROM payment_receipts WHERE tx_hash = ?").all(tx);
const receiptsFor = (user: string, path: string) => db.prepare("SELECT tx_hash FROM payment_receipts WHERE account_id = ? AND path = ?").all(user, path);
const revokeAt = (user: string, path: string) => {
  db.prepare("DELETE FROM drive_members WHERE drive_id = 'nd1' AND user_id = ? AND path = ?").run(user, path);
  db.prepare("DELETE FROM payment_receipts WHERE drive_id = 'nd1' AND account_id = ? AND path = ?").run(user, path);
};
const deferred = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; };
const tick = () => new Promise((r) => setTimeout(r, 20));
const chargesFor = (from: string) => [...chain.keys()].filter((k) => k.startsWith(`${from.toLowerCase()}:`)).length;

/** A purchase whose settle mined but whose answer was lost. */
async function lostPurchase(token: string, who: Who, nonce: string) {
  fac.mode = "lost";
  const r = await buy(token, { ...who, env: envelope({ nonce }) });
  fac.mode = "ok";
  return r;
}

describe("x402 paid share — authenticated account: no double charge, no credit from the chain", () => {
  beforeAll(() => {
    for (const id of ["nowner", "nbuyer", "nother", "nthird"]) {
      db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, `${id}@example.com`, id, "x");
    }
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, allowed_tokens) VALUES (?,?,?,?,?,?)").run(
      "nd1", "nowner", "nd1", "hnd", "s",
      JSON.stringify([
        { symbol: "USDC", chain: "base-sepolia", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", name: "USDC", version: "2", decimals: 6, transferMethod: "eip3009" },
        { symbol: "FANCO", chain: "base-sepolia", asset: "0x187e30921d687583e5e35f3dc6474f59a6e6fe5b", name: null, version: null, decimals: 6, transferMethod: "permit2" },
      ]),
    );
    db.prepare("INSERT INTO drive_payout_wallets (id, drive_id, path, wallet) VALUES (?,?,?,?)").run("npw", "nd1", "", PAY_TO);
  });
  beforeEach(() => {
    Object.assign(fac, { mode: "ok", settleCalls: 0, verifyCalls: 0, lagging: false, preHold: null, hold: null });
  });
  afterAll(() => {
    expect(chainCalls).toEqual([]);
  });

  // --- Rule 1: record before settle, credit on success ---------------------------------

  it("normal purchase: row recorded before settle and credited with receipt + membership; no wallet cookie", async () => {
    const { token, shareId, path } = newSale();
    const nonce = freshNonce();
    const r = await buy(token, { user: "nbuyer", env: envelope({ nonce }) });
    expect(r.status).toBe(200);
    expect(r.body.txHash).toMatch(/^0x/);
    expect(r.cookie).toBeUndefined();
    const rec = row(nonce)!;
    expect(rec).toMatchObject({
      status: "credited", account_id: "nbuyer", share_id: shareId, drive_id: "nd1", path, role: "viewer",
      amount_usdc: 0.5, currency: "USDC", pay_to: PAY_TO, amount_atomic: PRICE, network: "eip155:84532",
      asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", payer: PAYER, nonce, tx_hash: r.body.txHash, resolved_by: "server",
    });
    expect(rec.envelope_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(events(rec.id)).toEqual(["recorded:server", "credited:server"]);
    expect(receipts(r.body.txHash)).toEqual([{ account_id: "nbuyer", share_id: shareId }]);
    expect(grantAt("nbuyer", path)).toEqual({ role: "viewer" });
  });

  it("the same for an aind_aat Bearer account", async () => {
    const { token, path } = newSale();
    const nonce = freshNonce();
    const r = await buy(token, { bearer: bearerFor("nother"), env: envelope({ nonce }) });
    expect(r.status).toBe(200);
    expect(r.cookie).toBeUndefined();
    expect(row(nonce)).toMatchObject({ status: "credited", account_id: "nother" });
    expect(grantAt("nother", path)).toEqual({ role: "viewer" });
  });

  it("UNIQUE(network, asset, payer, nonce) holds in the table itself", () => {
    const n = freshNonce();
    const ins = (id: string) => db.prepare(
      `INSERT INTO x402_account_settlements (id, account_id, share_id, drive_id, path, role, amount_usdc, currency, chain, pay_to, amount_atomic,
         network, asset, payer, nonce, envelope_hash, created_at, updated_at) VALUES (?, 'a', 's', 'd', 'p', 'viewer', 1, 'USDC', 'base', 'x', '1', 'n', 'a', 'p', ?, 'h', 0, 0)`,
    ).run(id, n);
    ins("u1");
    expect(() => ins("u2")).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM x402_account_settlements WHERE id = 'u1'").run();
  });

  it("verify refusal: no row (nothing sent), a new signature is not blocked", async () => {
    const { token, path } = newSale();
    const bad = freshNonce();
    const r1 = await buy(token, { user: "nbuyer", env: envelope({ nonce: bad, sig: "0xdead" }) });
    expect(r1.status).toBe(402);
    expect(row(bad)).toBeUndefined();
    const r2 = await buy(token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) });
    expect(r2.status).toBe(200);
    expect(grantAt("nbuyer", path)).toBeTruthy();
  });

  it("definite pre-broadcast refusal: row released (by server), 402, the account may sign again and is charged once", async () => {
    const { token, path } = newSale();
    const n1 = freshNonce();
    fac.mode = "refused";
    const r1 = await buy(token, { user: "nbuyer", env: envelope({ nonce: n1 }) });
    expect(r1.status).toBe(402);
    expect(row(n1)).toMatchObject({ status: "released", resolved_by: "server" });
    expect(events(row(n1)!.id)).toEqual(["recorded:server", "released:server"]);
    fac.mode = "ok";
    // The released envelope is never settled again.
    const again = await buy(token, { user: "nbuyer", env: envelope({ nonce: n1 }) });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("authorization_released");
    expect(fac.settleCalls).toBe(1);
    const r2 = await buy(token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) });
    expect(r2.status).toBe(200);
    expect(grantAt("nbuyer", path)).toEqual({ role: "viewer" });
    expect(receiptsFor("nbuyer", path)).toHaveLength(1);
  });

  for (const mode of ["lost", "timeout", "reverted"] as const) {
    it(`uncertain settle (${mode}): row stays unresolved, 409 payment_pending with reference + support URL; a NEW nonce is refused without verify or settle`, async () => {
      const { token, path } = newSale();
      const n1 = freshNonce();
      fac.mode = mode;
      const r1 = await buy(token, { user: "nbuyer", env: envelope({ nonce: n1 }) });
      fac.mode = "ok";
      expect(r1.status).toBe(409);
      const rec = row(n1)!;
      expect(rec.status).toBe("unresolved");
      expect(rec.last_error).toBeTruthy();
      expect(r1.body).toMatchObject({ error: "payment_pending", reference: rec.id, payer: PAYER, nonce: n1 });
      expect(r1.body.support_url).toBe(`https://support.example/ticket?ref=${rec.id}`);
      expect(r1.cookie).toBeUndefined();
      expect(events(rec.id)).toEqual(["recorded:server", "settle_uncertain:server"]);
      fac.settleCalls = 0; fac.verifyCalls = 0;
      for (const who of [{ user: "nbuyer" }, { bearer: bearerFor("nbuyer") }] as Who[]) {
        const r2 = await buy(token, { ...who, env: envelope({ nonce: freshNonce() }) });
        expect(r2.status).toBe(409);
        expect(r2.body).toMatchObject({ error: "payment_pending", reference: rec.id });
        // A different payer wallet of the same account: still the same sale.
        const r3 = await buy(token, { ...who, env: envelope({ nonce: freshNonce(), from: PAYER2 }) });
        expect(r3.status).toBe(409);
      }
      expect(fac.verifyCalls).toBe(0);
      expect(fac.settleCalls).toBe(0);
      expect(grantAt("nbuyer", path)).toBeUndefined();
    });
  }

  it("lost answer (mined): resending the same envelope settles again, the used nonce cannot move money twice → stays unresolved, never credited", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    await lostPurchase(token, { user: "nbuyer" }, n);
    const r = await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("payment_pending");
    expect(row(n)?.status).toBe("unresolved");
    // Even a lagging verify that lets settle run again: the broadcast fails, nothing more moves.
    fac.lagging = true;
    const r2 = await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    expect(r2.status).toBe(409);
    expect(row(n)?.status).toBe("unresolved");
    expect(chargesFor(PAYER)).toBeGreaterThan(0);
    expect(chain.has(`${PAYER}:${n}`)).toBe(true);
    expect(grantAt("nbuyer", path)).toBeUndefined();
    expect(receiptsFor("nbuyer", path)).toHaveLength(0);
  });

  it("timeout before broadcast: resending the same envelope settles it → credited normally (one charge)", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    fac.mode = "timeout";
    expect((await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) })).status).toBe(409);
    // Still refused on a resend while the facilitator times out: never released.
    expect((await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) })).status).toBe(409);
    expect(row(n)?.status).toBe("unresolved");
    fac.mode = "ok";
    const r = await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    expect(r.status).toBe(200);
    expect(r.cookie).toBeUndefined();
    expect(row(n)).toMatchObject({ status: "credited", tx_hash: r.body.txHash });
    expect(grantAt("nbuyer", path)).toEqual({ role: "viewer" });
    expect(receipts(r.body.txHash)).toHaveLength(1);
    // Credited and still entitled: no settle at all.
    fac.settleCalls = 0;
    expect((await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) })).status).toBe(200);
    expect(fac.settleCalls).toBe(0);
    // Membership revoked by the owner: the credited envelope is not settled or credited again.
    revokeAt("nbuyer", path);
    const replay = await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("already_credited");
    expect(fac.settleCalls).toBe(0);
    // A credited row is a known outcome: a new purchase is allowed.
    expect((await buy(token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) })).status).toBe(200);
  });

  it("a hex/number twin of the pending envelope is the same envelope (resend), and twins of a new nonce are still refused", async () => {
    const { token } = newSale();
    const n = freshNonce();
    fac.mode = "timeout";
    await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    const h = row(n)!.envelope_hash;
    fac.mode = "timeout";
    // value as hex, as a JSON number, nonce/from upper-case: same authorization.
    const twin = envelope({ nonce: n.toUpperCase().replace("0X", "0x"), from: PAYER.toUpperCase().replace("0X", "0x"), auth: { value: "0x7a120" } });
    const r = await buy(token, { user: "nbuyer", env: twin });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("payment_pending");
    expect(row(n)!.envelope_hash).toBe(h);
    expect(fac.settleCalls).toBe(2); // the twin was settled again as the same envelope
    fac.mode = "ok";
    fac.settleCalls = 0;
    for (const auth of [{ value: "0x7a120" }, { value: 500000 }]) {
      const r2 = await buy(token, { user: "nbuyer", env: envelope({ nonce: freshNonce(), auth }) });
      expect(r2.status).toBe(409);
      expect(r2.body.error).toBe("payment_pending");
    }
    expect(fac.settleCalls).toBe(0);
  });

  // --- Rule 2: the block spans the sale, not the link ----------------------------------

  it("another link selling the same drive/path/role, and the link re-made after a revoke, are blocked too", async () => {
    const s1 = newSale({ path: "twin.md" });
    const n1 = freshNonce();
    await lostPurchase(s1.token, { user: "nbuyer" }, n1);
    const s2 = newSale({ path: "twin.md" });
    const r = await buy(s2.token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "payment_pending", reference: row(n1)!.id });
    db.prepare("DELETE FROM shares WHERE id IN (?, ?)").run(s1.shareId, s2.shareId);
    const s3 = newSale({ path: "twin.md" });
    const r3 = await buy(s3.token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) });
    expect(r3.status).toBe(409);
    expect(fac.settleCalls).toBe(1);
    // The pending envelope itself, resent on the new link (same sale), is a resend.
    fac.lagging = false;
    const r4 = await buy(s3.token, { user: "nbuyer", env: envelope({ nonce: n1 }) });
    expect(r4.status).toBe(409);
    expect(r4.body.error).toBe("payment_pending");
  });

  it("a permit2 link for the same sale (owner changed the currency) is blocked too; another sale is not", async () => {
    const s1 = newSale({ path: "cur.md" });
    await lostPurchase(s1.token, { user: "nbuyer" }, freshNonce());
    const p = newSale({ path: "cur.md", currency: "FANCO" });
    fac.settleCalls = 0;
    const r = await buy(p.token, { user: "nbuyer", env: permit2Envelope(PAYER) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("payment_pending");
    expect(fac.settleCalls).toBe(0);
    const other = newSale();
    expect((await buy(other.token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) })).status).toBe(200);
  });

  it("another account is not blocked by this account's unresolved row", async () => {
    const { token, path } = newSale();
    await lostPurchase(token, { user: "nbuyer" }, freshNonce());
    const r = await buy(token, { user: "nother", env: envelope({ nonce: freshNonce(), from: PAYER2 }) });
    expect(r.status).toBe(200);
    expect(grantAt("nother", path)).toBeTruthy();
  });

  // --- Copied envelopes ----------------------------------------------------------------

  it("another account resends the buyer's envelope → 409 authorization_in_use, no settle, no credit, no cookie, row never re-bound", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    await lostPurchase(token, { user: "nbuyer" }, n);
    fac.settleCalls = 0;
    fac.lagging = true; // even when verify would pass
    for (const who of [{ user: "nother" }, { bearer: bearerFor("nother") }] as Who[]) {
      const r = await buy(token, { ...who, env: envelope({ nonce: n }) });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("authorization_in_use");
      expect(r.cookie).toBeUndefined();
    }
    expect(fac.settleCalls).toBe(0);
    expect(grantAt("nother", path)).toBeUndefined();
    expect(row(n)?.account_id).toBe("nbuyer");
  });

  it("the same envelope for another sale → 409, even after it is credited", async () => {
    const s1 = newSale(), s2 = newSale();
    const n = freshNonce();
    fac.mode = "timeout";
    await buy(s1.token, { user: "nbuyer", env: envelope({ nonce: n }) });
    fac.mode = "ok";
    expect((await buy(s2.token, { user: "nbuyer", env: envelope({ nonce: n }) })).body.error).toBe("authorization_in_use");
    expect((await buy(s1.token, { user: "nbuyer", env: envelope({ nonce: n }) })).status).toBe(200);
    expect((await buy(s2.token, { user: "nbuyer", env: envelope({ nonce: n }) })).status).toBe(409);
    expect(grantAt("nbuyer", s2.path)).toBeUndefined();
  });

  it("same (payer, nonce) with another signature → 409 authorization_in_use, not a resend", async () => {
    const { token } = newSale();
    const n = freshNonce();
    await lostPurchase(token, { user: "nbuyer" }, n);
    fac.settleCalls = 0;
    const r = await buy(token, { user: "nbuyer", env: envelope({ nonce: n, sig: "0xbeef" }) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("authorization_in_use");
    expect(fac.settleCalls).toBe(0);
  });

  it("v3 A2: a chain-copied envelope of an anonymous buyer, sent by an attacker account with a lagging verify, is never credited", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    // The anonymous victim's settle mined, but its answer was lost (today: a plain 402, no receipt).
    fac.mode = "lost";
    const victim = await buy(token, { env: envelope({ nonce: n }) });
    expect(victim.status).toBe(402);
    fac.mode = "ok";
    // Attacker copies the envelope from calldata; the facilitator's verify lags.
    fac.lagging = true;
    const a1 = await buy(token, { bearer: bearerFor("nthird"), env: envelope({ nonce: n }) });
    expect(a1.status).toBe(409);
    expect(a1.body.error).toBe("payment_pending");
    for (let i = 0; i < 3; i++) {
      const again = await buy(token, { user: "nthird", env: envelope({ nonce: n }) });
      expect(again.status).toBe(409);
    }
    expect(row(n)).toMatchObject({ status: "unresolved", account_id: "nthird" });
    expect(grantAt("nthird", path)).toBeUndefined();
    expect(receiptsFor("nthird", path)).toHaveLength(0);
    expect(chargesFor(PAYER)).toBeGreaterThan(0);
  });

  // --- Dual-form and malformed payloads -------------------------------------------------

  for (const who of [{ user: "nbuyer" }, { bearer: "acct" }, {}] as const) {
    it(`v3: a payload with both authorization and permit2Authorization → 400 before verify (${Object.keys(who)[0] ?? "anonymous"})`, async () => {
      const { token } = newSale();
      const n = freshNonce();
      const w: Who = "bearer" in who ? { bearer: bearerFor("nbuyer") } : who;
      const r = await buy(token, { ...w, env: envelope({ nonce: n, extra: { permit2Authorization: { from: PAYER2 } } }) });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("ambiguous_payment_payload");
      expect(fac.verifyCalls).toBe(0);
      expect(row(n)).toBeUndefined();
      expect(r.cookie).toBeUndefined();
    });
  }

  it("an account's payload the parser cannot read never reaches the unguarded flow (402, nothing settled)", async () => {
    const { token } = newSale();
    await lostPurchase(token, { user: "nbuyer" }, freshNonce());
    fac.settleCalls = 0; fac.verifyCalls = 0;
    const bad = [
      envelope({ nonce: "0x1234" }), // short nonce
      envelope({ nonce: freshNonce(), auth: { value: "1e6" } }),
      envelope({ nonce: freshNonce(), sig: "not-hex" }),
      permit2Envelope(PAYER), // permit2 shape on an EIP-3009 sale
    ];
    for (const env of bad) {
      const r = await buy(token, { user: "nbuyer", env });
      expect(r.status).toBe(402);
    }
    expect(fac.verifyCalls).toBe(0);
    expect(fac.settleCalls).toBe(0);
  });

  // --- Races ----------------------------------------------------------------------------

  it("two new nonces in parallel (double click / two tabs): one settles, the other 409 payment_pending — one charge", async () => {
    const { token } = newSale();
    const hold = deferred();
    fac.hold = hold.p;
    const p1 = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: freshNonce() }) });
    await tick();
    fac.hold = null;
    const r2 = await buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: freshNonce() }) });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe("payment_pending");
    hold.release();
    expect((await p1).status).toBe(200);
    expect(fac.settleCalls).toBe(1);
  });

  it("two new nonces both past verify at once: the hook's transaction admits one", async () => {
    const { token } = newSale();
    const gate = deferred();
    fac.preHold = async () => { await gate.p; };
    const pA = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: freshNonce() }) });
    const pB = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: freshNonce(), from: PAYER2 }) });
    await tick();
    gate.release();
    const [a, b] = await Promise.all([pA, pB]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.error, b.body.error]).toContain("payment_pending");
    expect(fac.settleCalls).toBe(1);
  });

  it("the same fresh envelope twice in parallel: one settles, the other 409 payment_pending (not 'another purchase')", async () => {
    const { token } = newSale();
    const n = freshNonce();
    const gate = deferred();
    fac.preHold = async () => { await gate.p; };
    const pA = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n }) });
    const pB = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n }) });
    await tick();
    gate.release();
    const [a, b] = await Promise.all([pA, pB]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.error, b.body.error]).toContain("payment_pending");
    expect(fac.settleCalls).toBe(1);
    expect(row(n)?.status).toBe("credited");
  });

  it("two accounts race one envelope: the second's hook conflicts — never settled, one credit", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    const gate = deferred();
    fac.preHold = async () => { await gate.p; };
    const pX = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n }) });
    const pY = buy(token, { bearer: bearerFor("nother"), env: envelope({ nonce: n }) });
    await tick();
    gate.release();
    const [x, y] = await Promise.all([pX, pY]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x.body.error, y.body.error]).toContain("authorization_in_use");
    expect(fac.settleCalls).toBe(1);
    expect([grantAt("nbuyer", path), grantAt("nother", path)].filter(Boolean)).toHaveLength(1);
  });

  it("parallel resends of one unresolved envelope: at most one transfer, one receipt, credited once", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    fac.mode = "timeout";
    await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    fac.mode = "ok";
    const hold = deferred();
    fac.hold = hold.p;
    const pA = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n }) });
    const pB = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n }) });
    await tick();
    hold.release();
    const [a, b] = await Promise.all([pA, pB]);
    expect([a.status, b.status]).toEqual([200, 200]); // the loser sees the winner's credit
    expect(chain.get(`${PAYER}:${n}`)).toBe(row(n)!.tx_hash);
    expect(receiptsFor("nbuyer", path)).toHaveLength(1);
    expect(events(row(n)!.id).filter((e) => e.startsWith("credited"))).toHaveLength(1);
  });

  it("a request still in verify when another is credited → re-checked in the hook: 200 without settling", async () => {
    const { token, path } = newSale();
    const n2 = freshNonce();
    const gate = deferred();
    fac.preHold = async (nonce) => { if (nonce === n2) await gate.p; };
    const p2 = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n2 }) });
    await tick();
    const r1 = await buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: freshNonce() }) });
    expect(r1.status).toBe(200);
    gate.release();
    const r2 = await p2;
    expect(r2.status).toBe(200);
    expect(r2.body.txHash).toBeUndefined();
    expect(fac.settleCalls).toBe(1);
    expect(row(n2)).toBeUndefined();
    expect(grantAt("nbuyer", path)).toBeTruthy();
  });

  it("support releases a row while its resend is in verify → the resend does not settle", async () => {
    const { token } = newSale();
    const n = freshNonce();
    fac.mode = "timeout";
    await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    fac.mode = "ok";
    fac.settleCalls = 0;
    const gate = deferred();
    fac.preHold = async () => { await gate.p; };
    const p = buy(token, { bearer: bearerFor("nbuyer"), env: envelope({ nonce: n }) });
    await tick();
    expect(S.releaseSettlement({ id: row(n)!.id, actor: "support:alice", reason: "test" })).toBe(true);
    gate.release();
    const r = await p;
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("authorization_released");
    expect(fac.settleCalls).toBe(0);
  });

  it("settled but the tx is already receipted for another purchase → 409 payment_conflict, row stays unresolved (support)", async () => {
    const { token, shareId, path } = newSale();
    const n = freshNonce();
    // Pre-seed a receipt for the tx id the facilitator will return next.
    const tx = `0x${(txSeq + 1).toString(16).padStart(64, "0")}`;
    db.prepare("INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("seeded", "nd1", "elsewhere.md", PAYER, tx, 0.5, "USDC", "base-sepolia", "other-share", "nother");
    const r = await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "payment_conflict", txHash: tx, reference: row(n)!.id });
    expect(row(n)?.status).toBe("unresolved");
    expect(grantAt("nbuyer", path)).toBeUndefined();
    expect(receipts(tx)).toEqual([{ account_id: "nother", share_id: "other-share" }]);
    expect((await buy(token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) })).status).toBe(409);
    void shareId;
  });

  // --- Scope: anonymous / wallet buyers unchanged ----------------------------------------

  it("anonymous buyer: today's flow — no row, wallet cookie set, a lost answer is a plain 402, a new nonce settles", async () => {
    const { token } = newSale();
    const n = freshNonce();
    const ok = await buy(token, { env: envelope({ nonce: n }) });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toBeTruthy();
    expect(row(n)).toBeUndefined();
    const s2 = newSale();
    const n2 = freshNonce();
    fac.mode = "lost";
    const lost = await buy(s2.token, { env: envelope({ nonce: n2, from: PAYER2 }) });
    fac.mode = "ok";
    expect(lost.status).toBe(402);
    expect(row(n2)).toBeUndefined();
    const again = await buy(s2.token, { env: envelope({ nonce: freshNonce(), from: PAYER2 }) });
    expect(again.status).toBe(200);
  });

  it("anonymous resend of an account's unresolved envelope: today's flow (settles it once, credits the wallet's account); the account row stays for support", async () => {
    const { token, path } = newSale();
    const n = freshNonce();
    fac.mode = "timeout";
    await buy(token, { user: "nbuyer", env: envelope({ nonce: n }) });
    fac.mode = "ok";
    const anon = await buy(token, { env: envelope({ nonce: n }) });
    expect(anon.status).toBe(200);
    expect(anon.cookie).toBeTruthy();
    expect(row(n)?.status).toBe("unresolved");
    expect(grantAt("nbuyer", path)).toBeUndefined();
    // The account's next new nonce is still refused: no second charge.
    expect((await buy(token, { user: "nbuyer", env: envelope({ nonce: freshNonce() }) })).status).toBe(409);
    expect(chargesFor(PAYER)).toBeGreaterThan(0);
  });
});
