# aindrive production env — 1Password op-inject template. COMMITTED, and holds
# NO secrets: secret values are `op://ainetwork/…` references, resolved at deploy
# time. Render the real (gitignored) file with:
#
#   op inject -i web/.env.production.tpl -o web/.env.production
#
# Non-secret config stays as plain literals ON PURPOSE — the load-bearing prod
# flags (mainnet, DEV_BYPASS=0, https URL) are then visible in git review, not
# hidden in a vault. Move any line to an op:// ref if you'd rather vault it; op
# inject passes literals through untouched either way, so it's still one command.
#
# One-time setup (deploy host):
#   1. Install the 1Password CLI (`op`).
#   2. Create a Service Account; export its token as OP_SERVICE_ACCOUNT_TOKEN so
#      `op inject` runs non-interactively (no desktop app / login).
#   3. In vault `ainetwork`, create item `aindrive-prod` with fields:
#        session_secret, smtp_password, cdp_api_key_id, cdp_api_key_secret,
#        cdp_paymaster_url
#      (put the dev@ainetwork.ai Gmail app password in smtp_password).

# ── Payments (x402) ─────────────────────────────────────────────────────────
NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet
AINDRIVE_DEV_BYPASS_X402=0
CDP_API_KEY_ID=op://ainetwork/aindrive-prod/cdp_api_key_id
CDP_API_KEY_SECRET=op://ainetwork/aindrive-prod/cdp_api_key_secret
# Sponsored gas for permit2 (FANCO) buys. Remove this line to disable sponsorship.
CDP_PAYMASTER_URL=op://ainetwork/aindrive-prod/cdp_paymaster_url
# AINDRIVE_X402_FACILITATOR left unset on purpose — CDP keys above are the facilitator.

# ── Session / URL ───────────────────────────────────────────────────────────
AINDRIVE_SESSION_SECRET=op://ainetwork/aindrive-prod/session_secret
AINDRIVE_PUBLIC_URL=https://aindrive.ainetwork.ai

# ── Email (password-reset + signup OTP) — Gmail SMTP via dev@ainetwork.ai ─────
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=dev@ainetwork.ai
SMTP_PASS=op://ainetwork/aindrive-prod/smtp_password
EMAIL_FROM=dev@ainetwork.ai

# ── Optional ────────────────────────────────────────────────────────────────
# Public-by-design (baked into the client bundle); keep literal if used.
# NEXT_PUBLIC_WC_PROJECT_ID=
