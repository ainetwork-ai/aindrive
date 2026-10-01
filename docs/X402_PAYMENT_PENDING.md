# x402: no second charge after a lost settle answer (accounts, EIP-3009)

When an x402 settle answer is lost (timeout, network error, unknown failure),
the server cannot tell from the chain alone whether *it* broadcast that
transfer for *this* requester: an EIP-3009 signature is public in calldata
once mined. Three automatic-recovery attempts were rejected for that reason
(#190 reverted in #192; v2 `fix/x402-settle-recovery-bound`; v3
`fix/x402-settle-recovery-minimal`). The decision (ain-integration
`docs/11-entitlements.md` §6, option 3) is:

- **No automatic credit from the chain, ever.** No request path reads the chain.
- **Only stop a second charge.** A purchase with an unknown outcome blocks a new
  signature for the same sale until support resolves it.

## Who it applies to

Authenticated accounts (session cookie, or a relaying app's
`Authorization: Bearer aind_aat_…`) buying a paid share priced in an EIP-3009
token. Anonymous and wallet-cookie buyers keep the previous behaviour exactly.
For every requester, a payload carrying both `authorization` and
`permit2Authorization` is refused with 400 `ambiguous_payment_payload` (the
facilitator picks its path from the payload shape, so it could settle a
different authorization than the one checked).

## Rules (`web/app/api/s/[token]/route.ts`, `web/lib/x402-account-settlements.js`)

| Moment | What happens |
|---|---|
| Payload unreadable as EIP-3009 | 402, nothing verified or settled (fail closed; never falls through to the unguarded flow). |
| Facilitator verify passed, right before settle (`beforeSettle` hook, one IMMEDIATE transaction) | Insert `x402_account_settlements` row: sale snapshot (share, drive, path, role, amount, currency, payee, atomic amount), account, network, asset, payer, nonce, envelope hash. `UNIQUE(network, asset, payer, nonce)`. |
| That authorization already belongs to another account, sale or envelope | 409 `authorization_in_use`, no settle. |
| The account already has an `unresolved` row for this sale (same link, or same drive/path/role on any link, incl. a re-made or permit2 link) | 409 `payment_pending` with `reference` and `support_url`, no verify, no settle. |
| Settle answered success | Receipt + membership (upgrade-only) + `credited`, one transaction. No wallet cookie. |
| Settle refused **before broadcast** (one request, answered, no tx hash, reason in `PRE_BROADCAST_REFUSALS`) | Row `released` by `server`; 402 as before; the account may sign again. |
| Anything else (timeout, network error, retried request, revert, nonce used, low balance, expired, unknown reason, credit refused) | Row stays `unresolved`; 409 `payment_pending`. |
| Same account resends the **same** envelope for an `unresolved` row | verify + settle again (one nonce moves money at most once). Success → credited; anything else → still `unresolved`. |
| Resend of a `credited` / `released` row | 409 `already_credited` / `authorization_released`, no settle. |

`PRE_BROADCAST_REFUSALS` (`web/lib/x402-facilitator.ts`) lists only reasons a
mined use of the same authorization cannot cause. "Nonce already used",
"insufficient balance" and "valid-before expired" are excluded on purpose: a
facilitator-internal retry after its own broadcast can answer any of them.

Every state change is logged in `x402_account_settlement_events`
(`recorded`, `settle_uncertain`, `credited`, `released`; actor `server` or
`support:<operator>`).

Known limits: a buyer who logs out and pays again anonymously is outside this
guard (anonymous flow unchanged). The block is per account, not per wallet.

## Support procedure

The buyer sees "payment pending" with a reference (the row id) and a support
link (`AINDRIVE_SUPPORT_URL`, `{ref}` placeholder or `?ref=` appended; default:
a new GitHub issue). In production the CLI runs inside the web container:

```sh
X="sudo docker exec aindrive-web-1 node scripts/x402-settlements.mjs"
$X list                                  # unresolved rows (--status all|credited|released, --account, --drive)
$X show  --id <ref>                      # row + event log + the account's role/receipts for the sale
$X check --id <ref>                      # READ-ONLY chain check (RPC: AINDRIVE_BASE_RPC / AINDRIVE_BASE_SEPOLIA_RPC, or --rpc)
```

`check` prints `authorization_used` (the token's `authorizationState`), every
transaction with `AuthorizationUsed(payer, nonce)` in the lookback window
(`--lookback-blocks`, default 200000, or `--from-block`), whether each one
transferred exactly the recorded amount to the sale's payee, any existing
receipt for it, and advice. Then decide:

1. **Used, and a tx paid this sale, with no receipt for another purchase** →
   `$X credit --id <ref> --tx <hash> --operator <you> --note "<ticket>"`.
   The CLI re-checks that tx on chain first, then writes receipt + membership +
   `credited` in one transaction with the server's guards (a tx receipted or
   credited for another purchase is refused).
2. **Used, but the receipt belongs to another purchase** (e.g. the buyer resent
   the envelope after logging out, and a wallet-only account was credited) →
   no credit here; move access by hand if appropriate, then release with
   `--force` and a note explaining it.
3. **Unused and `validBefore` passed** → it can never pay:
   `$X release --id <ref> --operator <you> --note "<ticket>"`. The account can buy again.
4. **Unused but still valid** → wait until `validBefore`, check again. `release`
   refuses meanwhile, because the authorization could still be settled.

`--skip-chain-check` (credit) and `--force` (release) exist for an RPC outage
or a case decided off-chain; both are recorded in the row's note and the event
log. Releasing a row whose authorization paid lets the buyer pay twice.
