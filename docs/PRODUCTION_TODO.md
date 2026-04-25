# aindrive — Production Readiness TODO

> Drafted 2026-04-25, before any prod traffic. Living checklist — strike items
> as they land. **P0** = blocker (must ship before public traffic). **P1** =
> within first week. **P2** = post-launch hardening.

## Top three landmines (re-read before any launch decision)

1. **`AINDRIVE_DEV_BYPASS_X402` enabled in prod** → every paid share is free.
2. **`AINDRIVE_DATA_DIR` not on persistent volume** → losing it nukes every
   drive's `namespace_secret`, every cap aindrive ever issued is unverifiable
   forever.
3. **Payout wallet private key lost** → all received USDC unrecoverable.

---

## 1. Security & Auth Hardening

- [ ] **P0** Boot guard: `NODE_ENV=production && AINDRIVE_DEV_BYPASS_X402=1` → process.exit(1) with loud log
- [ ] **P0** `AINDRIVE_SESSION_SECRET` required in prod (no fallback to `~/.aindrive/session-secret`); 32B base64; absent → boot fail
- [ ] **P0** Force cookies `Secure; HttpOnly; SameSite=Lax` in prod; refuse to start if `AINDRIVE_PUBLIC_URL` is not `https://`
- [ ] **P0** `AINDRIVE_PAYOUT_WALLET` set; reject all-zero placeholder when DEV_BYPASS off
- [ ] **P0** `AINDRIVE_X402_FACILITATOR` explicitly set; conscious base-mainnet vs base-sepolia choice (document in runbook)
- [ ] **P0** Rate limit `/api/auth/*`, `/api/wallet/verify`, `/api/drives/.../shares` POST, `/api/s/<token>` (especially 402 retry); IP + cookie keys
- [ ] **P0** Hard size cap on `fs/write` body and `fs/read` response (16 MB yjs limit already in; regular fs needs same)
- [ ] **P0** `npm audit` gate in CI + Dependabot
- [ ] **P1** CSP, HSTS, X-Frame-Options via Next.js middleware
- [ ] **P1** Use `crypto.timingSafeEqual` for share-token compares
- [ ] **P1** Path-traversal coverage for cap-bearer + payment-bearer flows
- [ ] **P1** MCP tool input revalidation with Zod (SDK only checks JSON Schema shape)
- [ ] **P1** Document secret rotation: `driveSecret`, `SESSION_SECRET`, payout wallet
- [ ] **P2** External pen test or OWASP ZAP automation
- [ ] **P2** Bug bounty policy

## 2. Reliability

- [ ] **P0** SQLite WAL mode + nightly `VACUUM` cron + nightly off-host backup (S3 / Wasabi / Backblaze)
- [ ] **P0** Graceful SIGTERM in `web/server.js` and `cli/src/agent.js`: refuse new connections, drain in-flight RPCs, close WS
- [ ] **P0** Health endpoints: `GET /healthz` (DB ping + agent map size + uptime), `GET /readyz` (initial Next compile complete)
- [ ] **P0** DocHub peer-leak guard: WS close removes from every doc set (load-test verifies)
- [ ] **P1** Agent reconnect with exponential backoff, max 60s cap
- [ ] **P1** Server→agent ping every 60s, two missed pongs → forced disconnect
- [ ] **P1** Per-process Y.Doc cache LRU eviction (currently unbounded)
- [ ] **P1** Per-doc broadcast backpressure so a slow consumer doesn't block fast ones
- [ ] **P2** Postgres migration path drafted for HA; current schema is SQLite-only

## 3. Observability

- [ ] **P0** Stdout JSON logs → external sink (Loki / Datadog / CloudWatch)
- [ ] **P0** Sentry on both web + cli, source maps uploaded
- [ ] **P1** Prometheus `/metrics`: `aindrive_agents_connected`, `aindrive_rpc_latency_seconds`, `aindrive_x402_settle_total`, `aindrive_doc_subscriptions_active`
- [ ] **P1** Persist trace ring (currently in-memory 10k events) to durable sink
- [ ] **P1** Alerts: agent disconnect >5min sustained / 5xx rate >1% / x402 settle failure rate >5%
- [ ] **P2** OpenTelemetry distributed tracing for RPC chains

## 4. Deployment / Infra

- [ ] **P0** Verify `web/Dockerfile` multi-stage build
- [ ] **P0** GitHub Actions: build + lint + scenarios (~150) + npm audit + docker push
- [ ] **P0** TLS termination (Caddy / Cloudflare / ALB) + auto-renew
- [ ] **P0** DNS for `aindrive.ainetwork.ai` + future `*.aindrive.ainetwork.ai` per-tenant
- [ ] **P0** Secret management: GitHub Actions secrets / Vault / Doppler — never `.env` in repo
- [ ] **P0** `AINDRIVE_DATA_DIR` on persistent volume — losing it nukes every drive's `namespace_secret`
- [ ] **P1** Rolling or blue/green deploy strategy (must compose with graceful shutdown)
- [ ] **P1** CDN for Next static assets
- [ ] **P1** Quarterly backup-restore drill in a clean environment, captured in runbook
- [ ] **P2** Multi-region (latency); single instance is fine for early users

## 5. CLI / npm

- [ ] **P0** Bump `cli/package.json` version + `npm publish` workflow (CI auto or manual)
- [ ] **P0** `aindrive --version` works; consider `aindrive update-check` (npm registry GET)
- [ ] **P0** Friendly errors when `aindrive mcp` can't find creds or reach server
- [ ] **P1** Verify better-sqlite3 prebuilt binaries cover Linux/macOS/Windows × x64/arm64
- [ ] **P1** `npm publish --provenance`
- [ ] **P2** Auto-update prompt on first run after version bump

## 6. x402 / Payments

- [ ] **P0** Decide network: testnet demo (`base-sepolia`) vs mainnet (`base`); README + env aligned
- [ ] **P0** Payout wallet: multisig or hot/cold split — never single hot key
- [ ] **P0** Facilitator timeout + retry policy (currently no timeout → request can hang)
- [ ] **P0** Settle-failure user-facing message (no raw error leaks)
- [ ] **P1** Document refund policy: x402 is final, no refunds, FAQ
- [ ] **P1** Per-drive revenue dashboard for the owner
- [ ] **P1** CSV export for accounting / Korean tax filing
- [ ] **P2** ERC-8004 mandate integration (hackathon-plan next-milestone)

## 7. Multi-tenancy / Abuse

- [ ] **P0** Per-user drive count limit (default 10, owner upgradeable)
- [ ] **P0** Per-drive file count + total size limit (default 1k files / 1 GB)
- [ ] **P0** Per-IP signup rate limit + email verification
- [ ] **P1** Disk quota enforcement (CLI agent reports usage to server)
- [ ] **P1** Drive ban / takedown procedure (DMCA response)

## 8. Privacy / Compliance

- [ ] **P0** Privacy Policy + ToS, especially around payments + wallet data
- [ ] **P0** Cookie consent banner (EU): `aindrive_session`, `aindrive_wallet`, `aindrive_caps`
- [ ] **P1** GDPR `DELETE /api/auth/me` (account + data hard delete)
- [ ] **P1** Retention policy: trace ring 30d, deleted drives hard-deleted after 90d
- [ ] **P1** Per-drive access audit log surfaced to owner

## 9. Testing

- [ ] **P0** CI runs `node scenarios/run.mjs` (~150) — must be green to merge
- [ ] **P0** Post-deploy smoke: `aindrive mcp initialize` + `list_drives` automated
- [ ] **P1** k6 / Artillery load test: 100 concurrent docs, 1000 keystrokes/sec, 24h soak
- [ ] **P1** Chaos test: kill agent mid-RPC, partial network partition
- [ ] **P2** Consolidate scenarios + vitest into one runner

## 10. Frontend Polish

- [x] **P1** Mobile read-only viewer + collapsible sidebar (landed 2026-04-25 — commits `60bd71d` / `11c63e8` / `62c187c` / `98de90e`)
- [ ] **P1** Lighthouse: PWA, Perf, A11y, Best Practices, SEO all 90+
- [ ] **P1** Bundle audit (wagmi + monaco are heavy, lazy-load both)
- [ ] **P1** Wallet UX: MetaMask, WalletConnect, Coinbase Wallet, Rainbow tested on mobile
- [ ] **P2** i18n (EN / KO at minimum)

## 11. Documentation

- [ ] **P0** README quickstart end-to-end on real domain (cb305aa updated copy; needs live verification)
- [ ] **P0** Operator runbook: start/stop/upgrade/rollback/backup-restore/secret rotation
- [ ] **P0** Incident playbook: agent down / facilitator down / DB corruption
- [ ] **P1** API reference (auto-generated OpenAPI / JSON Schema)
- [ ] **P1** Public docs site (`docs.aindrive.ainetwork.ai`, Mintlify or Docusaurus)

## 12. Pre-launch Checklist (do not ship without all P0 above green)

- [ ] Status page (statuspage.io / instatus)
- [ ] Domain + TLS verified end-to-end (curl + Lighthouse)
- [ ] Backup taken, restored to a fresh env, app boots clean
- [ ] End-to-end paid share demo (testnet → conscious switch to mainnet)
- [ ] External log sink + Sentry receive first event
- [ ] `npm i -g aindrive` on a fresh box → `aindrive` + `aindrive mcp` both work, Claude Desktop picks up the MCP server
- [ ] Rollback procedure rehearsed once
