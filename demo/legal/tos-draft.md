# Terms of Service — DRAFT (2026-04-10)

> ⚠️ **Internal review only.** Do not publish without legal sign-off.
> Open questions marked `// TODO` below.

## 1. Account & Eligibility

You must be 16 or older to register an aindrive account. By creating
an account you confirm you have authority to bind your organization
if you sign up on its behalf.

## 2. Free vs Paid Tiers

- **Hobby tier** is free, capped at one drive and zero agents.
- **Pro tier** is $9/month (USD) per owner, billed monthly.
- **Team tier** is $29 per seat per month, minimum 3 seats.

We may change pricing with 30 days notice.

## 3. Refunds

- Pro / Team subscribers can cancel any time; no further charges.
- We refund the **most recent monthly charge** if the cancellation
  reason is a documented service outage on our side that exceeds
  4 hours of continuous downtime in the billing month.
- We do **not** refund partial months unrelated to outages.
- All refunds processed within **7 business days** to the original
  payment method.

## 4. Acceptable Use

- No illegal content (CSAM, IP infringement, etc.).
- No use as a public mirror for pirated material.
- No automated scraping of other users' shared drives without
  permission. Each share link is rate-limited at 60 reqs/minute by
  default.

## 5. Data ownership

- Your files stay on your machine. We never copy them to our
  infrastructure. The web UI proxies reads at request time.
- Metadata we store: account email, drive ids, agent ids, share
  link tokens, payment history. **Never file contents.**

## 6. Agent payments (x402)

When an owner enables paid agent calls:
- Platform fee is **5%** of each call price.
- Settlement currency: USDC on Base or Base-Sepolia.
- Fees and settlement settle on-chain at call time; aindrive does
  not custody funds.

## 7. Termination

We can suspend accounts violating §4 with 24 hours notice (or
immediately for severe violations). Suspended Pro/Team accounts get
a pro-rated refund.

// TODO legal: confirm jurisdiction (Delaware vs Korea)
// TODO legal: GDPR data-export request response time
