# web/lib/sso — AIN SSO integration

## Responsibility

aindrive as an AIN SSO relying party ("Continue with AIN") and provisioning
target. **Off unless configured**: with no `AINDRIVE_SSO_*` variable set no
new endpoint answers (404) and every legacy path behaves as before. AIN SSO
specs (repo `ainetwork-ai/sso`): `docs/specs/adapter-protocol.md`,
ADR-0003/0004/0005, `docs/runbooks/migration-rollback.md`.

## Files

- `config.ts` — env: `AINDRIVE_SSO_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_ENABLED`, `AINDRIVE_LEGACY_LOGIN`. Issuer + client id = adapter/back-channel live; + secret + `ENABLED=true` = sign-in button. The legacy switch applies only while SSO login is on. Bad values fail `boot-checks.js` in production.
- `store.js` (+ `.d.ts`) — all SSO SQL: identity links, the account gate (`liveSessionUserId`, `isAccountBlocked`), SSO sessions, sign-in state, jti replay, audit, `applyDesiredState`. Plain JS: `lib/dochub.js` uses the gate. Tables are created in `lib/db.js`.
- `oidc.ts` — discovery, code + PKCE S256 + state + nonce, client_secret_basic exchange, ID-token validation (jose). `sessionOrg` = the org a session acts for.
- `tokens.ts` — adapter request JWT (`ain-adapter+jwt`, htm/htu/bsh, ≤ 60 s, single-use jti) and logout token (`logout+jwt`) verification.
- `adapter.ts` — `/api/sso/v1/{health, orgs/:orgId/users/:sub}`. `backchannel.ts` — `/api/auth/sso/backchannel-logout`.
- `policy.ts` — legacy sign-in/reset refusals. `signin.ts` — SSO session + cookies. `app-proof.ts` — reports in-app links to AIN SSO.
- Routes: `app/api/auth/sso/{route,start,callback,link,backchannel-logout}`, `app/api/sso/v1/…`; page `app/sso/link`; button `components/sso-signin-button.tsx`.

## Contracts

- **Accounts are reached by `(issuer, sub)` only** (`sso_identities`, UNIQUE per issuer both ways). Never by email: a new account takes the ID token's email only if verified and free, else `<sub>@sso.aindrive.local`. An existing account is linked only by the adapter's verified `legacyUserId` (once) or an in-app proof on `/sso/link` (this browser's session, or the password; wallet/Google: sign in first).
- **Sessions**: the session JWT gains `ep` (per-account epoch, `users.session_epoch`) and, for SSO sign-ins, `ses` → `sso_sessions` (keyed by the OIDC `sid`). `session.ts verify()` and `dochub.js` check both on every use, so an epoch bump ends cookies, bearer uses and CLI/mobile pairing tokens at once. Old `{sub}` tokens verify as before.
- **Blocked account** = SSO membership rows, none `active`. No session verifies and every sign-in path (password, Google, SIWE, signup, CLI pairing, reset, SSO) refuses it — independent of every switch (rollback never re-activates).
- **Org scope**: PATs and OAuth grants created from an SSO session carry `sso_org_id` (the session's `active_org`, or its only org). Suspension/offboarding of that org revokes them (and burns unredeemed codes); `sso_org_id IS NULL` = personal, never touched.
- **Apply** (`applyDesiredState`): one immediate transaction, version compare-and-set per (issuer, org, sub); older/equal versions are 200 no-ops. `suspended`/`deprovisioned`: end all sessions + revoke the org's credentials before 200, close sockets after commit.
- **Ownership**: every drive is personal (ownership.md §2); `deprovisioned` transfers nothing, never deletes a user. `appRole`/`groups` are recorded and reported, not mapped to drive access.
- Email-OTP reset is never available to an AIN-linked account. Google sign-in never links by email (`lib/google-auth.ts`).

## Gotchas

- `htu` is compared with `AINDRIVE_PUBLIC_URL` + path (TLS proxy in front). Register the adapter as `{AINDRIVE_PUBLIC_URL}/api/sso`.
- Single process: jti replay lives in SQLite (`sso_replay`), which also survives restarts.
- Tests: `lib/__tests__/sso-*.test.ts` (in-test issuer in `sso-test-issuer.ts`).
