import { describe, it, expect } from "vitest";
import { paidLockFrom } from "../paid-lock";

// A drive route answers a read the viewer hasn't paid for with 402 + the gate
// (require-access.ts). The drive UI turns that answer — not an error string —
// into the paywall, so arriving at a paid folder by URL, back button or a
// grant row shows the price and a Buy button instead of "Couldn't load".
const body = { error: "payment required", reason: "payment_required", gatePath: "앨범", shareId: "s1", price: 1, currency: "AIN", listed: true };

describe("paidLockFrom", () => {
  it("a 402 payment denial → the lock to show", () => {
    expect(paidLockFrom(402, body)).toEqual({ gatePath: "앨범", shareId: "s1", price: 1, currency: "AIN", listed: true });
  });

  it("an unlisted gate stays unlisted (no Buy button)", () => {
    expect(paidLockFrom(402, { ...body, listed: false })).toMatchObject({ listed: false });
  });

  it("anything else is not a paywall", () => {
    expect(paidLockFrom(403, body)).toBeNull();
    expect(paidLockFrom(402, { error: "payment required" })).toBeNull(); // no gate described
    expect(paidLockFrom(402, null)).toBeNull();
  });
});
