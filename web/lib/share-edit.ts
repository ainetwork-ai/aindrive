// Pure decision logic for editing an existing share's sale terms — price,
// currency, and storefront `listed` flag. The route gathers the IO facts (the
// drive's allowed-token symbols, whether a payout wallet covers this path, and
// whether the caller owns the drive) and this function decides the resulting
// row or the rejection. Kept IO-free so every branch is unit-testable and the
// route stays a thin adapter.
//
// Why a separate edit path at all (vs. the create route): a paid share's price
// is read live on every /s/<token> hit and the payment is verified against that
// live amount, so mutating these columns in place is safe — the same link keeps
// working at the new terms and already-granted access (drive_members) is
// untouched. See web/app/api/drives/[driveId]/shares/[shareId]/route.ts.
import { pickShareCurrency } from "./payment-tokens";

/** The mutable sale terms of a share row (booleans, not SQLite 0/1). */
export type ShareSaleTerms = {
  price_usdc: number | null;
  currency: string | null;
  listed: boolean;
};

/** Partial edit: an omitted field keeps its current value. */
export type ShareEditPatch = {
  price_usdc?: number;
  currency?: string;
  listed?: boolean;
};

/** IO facts the route resolves before deciding. */
export type ShareEditFacts = {
  allowedSymbols: string[]; // drive token policy symbols (first = default)
  payoutExists: boolean; // a payout wallet covers this share's path (incl. inherited)
  isOwner: boolean; // caller is the drive owner
};

export type ShareEditDecision =
  | { ok: true; next: { price_usdc: number | null; currency: string | null; listed: number } }
  | { ok: false; status: 400 | 403; error: string };

export function decideShareEdit(
  current: ShareSaleTerms,
  patch: ShareEditPatch,
  facts: ShareEditFacts,
): ShareEditDecision {
  // Edit changes the terms of an EXISTING sale; it does not flip a free link
  // into a paid one. Crossing free⇄paid (either direction) is revoke + recreate,
  // so the share's paid/free nature is fixed here: the schema forbids price <= 0
  // (can't null a price out), and we reject starting to charge a free share.
  // Keeps PATCH (edit) and POST (create) responsibilities disjoint.
  if (current.price_usdc === null && patch.price_usdc !== undefined) {
    return { ok: false, status: 400, error: "revoke and recreate to start charging a free share" };
  }

  // Merge: an omitted field keeps its current value.
  const price_usdc = patch.price_usdc !== undefined ? patch.price_usdc : current.price_usdc;
  const listed = patch.listed !== undefined ? patch.listed : current.listed;
  const paid = price_usdc !== null;

  // [rev2-D] Listing on the drive's showcase is owner-only — mirrors create.
  // Gate the ACT of listing (patch.listed === true), not an inherited true, so
  // a non-owner editor may still reprice a share the owner later listed. Check
  // before the sellability gates so a non-owner gets the actionable reason.
  if (patch.listed === true && !facts.isOwner) {
    return { ok: false, status: 403, error: "only the owner can list a share" };
  }

  // A buyer-facing change = (re)setting price or currency. Only these — plus
  // putting the item on the storefront (listed) — re-run the sellability gates.
  // A pure unlist must NEVER be blocked by an unrelated payout gap or by a
  // currency the owner later dropped from policy, so a broken sale stays
  // removable.
  const repricing = patch.price_usdc !== undefined || patch.currency !== undefined;

  let currency: string | null = null;
  if (paid) {
    // Re-run sellability when the buyer-facing terms change OR the item is being
    // actively put on the storefront. Test patch.listed (the ACT of listing),
    // not the merged `listed`, so the intent is explicit and not coupled to the
    // schema's "at least one field" rule.
    if (repricing || patch.listed === true) {
      // Validate the currency exactly as create does (shared pickShareCurrency
      // gate): the requested one, else keep current, else the policy default.
      const requested = patch.currency !== undefined ? patch.currency : current.currency;
      const resolved = pickShareCurrency(facts.allowedSymbols, requested);
      if (resolved === null) {
        return { ok: false, status: 400, error: "currency not allowed by drive policy" };
      }
      currency = resolved;
      // A paid share needs somewhere for the money to land. Don't (re)price or
      // list one without a payout wallet on this path or an ancestor.
      if (!facts.payoutExists) {
        return { ok: false, status: 400, error: "set a payout wallet for this folder (or a parent) before selling" };
      }
    } else {
      // No buyer-facing change (e.g. a pure unlist): keep the stored currency
      // untouched so a sale whose token was later dropped from policy can still
      // be edited/unlisted rather than getting stuck.
      currency = current.currency;
    }
  }

  return { ok: true, next: { price_usdc, currency, listed: listed ? 1 : 0 } };
}
