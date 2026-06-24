import { describe, it, expect } from "vitest";
import { decideShareEdit, type ShareSaleTerms, type ShareEditFacts } from "../share-edit";

// A paid, unlisted share priced in USDC — the common starting point.
const PAID: ShareSaleTerms = { price_usdc: 5, currency: "USDC", listed: false };
// Drive policy allows USDC + FANCO; payout set; caller owns the drive.
const OK_FACTS: ShareEditFacts = { allowedSymbols: ["USDC", "FANCO"], payoutExists: true, isOwner: true };

describe("decideShareEdit — repricing", () => {
  it("changes the price, keeping currency", () => {
    const r = decideShareEdit(PAID, { price_usdc: 9 }, OK_FACTS);
    expect(r).toEqual({ ok: true, next: { price_usdc: 9, currency: "USDC", listed: 0 } });
  });

  it("changes the currency to another policy token", () => {
    const r = decideShareEdit(PAID, { currency: "FANCO" }, OK_FACTS);
    expect(r).toEqual({ ok: true, next: { price_usdc: 5, currency: "FANCO", listed: 0 } });
  });

  it("rejects a currency not in the drive policy (400)", () => {
    const r = decideShareEdit(PAID, { currency: "DOGE" }, OK_FACTS);
    expect(r).toEqual({ ok: false, status: 400, error: "currency not allowed by drive policy" });
  });

  it("rejects (re)pricing with no payout wallet (400)", () => {
    const r = decideShareEdit(PAID, { price_usdc: 9 }, { ...OK_FACTS, payoutExists: false });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/payout wallet/);
  });

  it("refuses to start charging a free share — free→paid is revoke + recreate", () => {
    // Edit changes an existing sale's terms; it never flips a free link to paid
    // (keeps PATCH/edit and POST/create disjoint). Blocked even for the owner.
    const free: ShareSaleTerms = { price_usdc: null, currency: null, listed: false };
    const r = decideShareEdit(free, { price_usdc: 3 }, OK_FACTS);
    expect(r).toEqual({ ok: false, status: 400, error: "revoke and recreate to start charging a free share" });
  });

  it("allows non-price edits on a free share (no free→paid flip)", () => {
    // A free share can still be listed by the owner — price stays null.
    const free: ShareSaleTerms = { price_usdc: null, currency: null, listed: false };
    const r = decideShareEdit(free, { listed: true }, OK_FACTS);
    expect(r).toEqual({ ok: true, next: { price_usdc: null, currency: null, listed: 1 } });
  });
});

describe("decideShareEdit — listing", () => {
  it("owner lists a sellable paid share", () => {
    const r = decideShareEdit(PAID, { listed: true }, OK_FACTS);
    expect(r).toEqual({ ok: true, next: { price_usdc: 5, currency: "USDC", listed: 1 } });
  });

  it("blocks a non-owner from listing (403), before any currency/payout error", () => {
    // Off-policy currency AND non-owner: the actionable reason is ownership.
    const r = decideShareEdit({ ...PAID, currency: "DOGE" }, { listed: true }, { ...OK_FACTS, isOwner: false });
    expect(r).toEqual({ ok: false, status: 403, error: "only the owner can list a share" });
  });

  it("refuses to list a share whose currency left the policy (400)", () => {
    const r = decideShareEdit({ ...PAID, currency: "DOGE" }, { listed: true }, OK_FACTS);
    expect(r).toEqual({ ok: false, status: 400, error: "currency not allowed by drive policy" });
  });

  it("refuses to list a paid share with no payout wallet (400)", () => {
    const r = decideShareEdit(PAID, { listed: true }, { ...OK_FACTS, payoutExists: false });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe("decideShareEdit — unlisting is never blocked", () => {
  // The escape hatch: a sale whose token was dropped from policy, with no payout,
  // must still be removable from the storefront. A pure unlist skips every gate.
  const broken: ShareSaleTerms = { price_usdc: 5, currency: "DOGE", listed: true };
  const broken_facts: ShareEditFacts = { allowedSymbols: ["USDC"], payoutExists: false, isOwner: true };

  it("unlists a broken sale (stale currency, no payout) — keeps stored currency", () => {
    const r = decideShareEdit(broken, { listed: false }, broken_facts);
    expect(r).toEqual({ ok: true, next: { price_usdc: 5, currency: "DOGE", listed: 0 } });
  });
});

describe("decideShareEdit — non-owner editor on an owner-listed share", () => {
  // The owner listed an editor-created share; the editor reprices it. patch has
  // no `listed`, so the owner-only listing gate does not fire — repricing is OK.
  it("allows a non-owner to reprice an already-listed share (no listed in patch)", () => {
    const listedPaid: ShareSaleTerms = { price_usdc: 5, currency: "USDC", listed: true };
    const r = decideShareEdit(listedPaid, { price_usdc: 7 }, { ...OK_FACTS, isOwner: false });
    expect(r).toEqual({ ok: true, next: { price_usdc: 7, currency: "USDC", listed: 1 } });
  });
});
