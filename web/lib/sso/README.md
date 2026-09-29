# web/lib/sso — AIN SSO integration

## Responsibility

aindrive as an AIN SSO relying party ("Continue with AIN") and provisioning
target. **Off unless configured**: with no `AINDRIVE_SSO_*` variable set no
new endpoint answers (404) and every legacy path behaves as before. AIN SSO
specs (repo `ainetwork-ai/sso`): `docs/specs/adapter-protocol.md`,
ADR-0003/0004/0005, `docs/runbooks/migration-rollback.md`.

## Files

- `config.ts` — env: `AINDRIVE_SSO_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_ENABLED`, `AINDRIVE_LEGACY_LOGIN`, `AINDRIVE_SSO_SILENT`, `AINDRIVE_SSO_ATTEST`, `AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS`. Issuer + client id = adapter/back-channel live; + secret = app attestations; + `ENABLED=true` = sign-in button, sign-up and the silent check. The legacy switch applies only while SSO login is on. Bad values fail `boot-checks.js` in production.
- `silent.ts` — automatic sign-in (Edge-safe, used by `middleware.ts`): which requests get the one `prompt=none` redirect, the `ain_sso_checked` loop guard, `SILENT_ERRORS`. `stale-session.ts` — the same decision from a page whose session cookie turned out dead.
- `app-attest.ts` — after a legacy sign-in, `POST {issuer}/api/upstream/app-attest` (AIN SSO management-api §13.2): Google → `{googleSub}`; password/sign-up → `{email, emailVerifiedBy: "password"}` only for a company-domain address aindrive verified by an emailed code (`otpVerifiedEmail`); wallet → nothing.
- `store.js` (+ `.d.ts`) — all SSO SQL: identity links, the account gate (`liveSessionUserId`, `isAccountBlocked`), SSO sessions, sign-in state, jti replay, audit, `applyDesiredState`. Plain JS: `lib/dochub.js` uses the gate. Tables are created in `lib/db.js`.
- `oidc.ts` — discovery, code + PKCE S256 + state + nonce (+ `prompt=none|create`, `ain_idp=google`), client_secret_basic exchange, ID-token validation (jose). `sessionOrg` = the org a session acts for.
- `tokens.ts` — adapter request JWT (`ain-adapter+jwt`, htm/htu/bsh, ≤ 60 s, single-use jti) and logout token (`logout+jwt`) verification.
- `adapter.ts` — `/api/sso/v1/{health, orgs/:orgId/users/:sub}`. `backchannel.ts` — `/api/auth/sso/backchannel-logout`.
- `policy.ts` — legacy sign-in/reset refusals. `signin.ts` — SSO session + cookies. `app-proof.ts` — reports in-app links to AIN SSO.
- Routes: `app/api/auth/sso/{route,start,callback,link,backchannel-logout}`, `app/api/sso/v1/…`; page `app/sso/link`; UI `components/{sso-signin-button,sso-signup-link,google-signin-button,use-sso-status}`.

## Contracts

- **Accounts are reached by `(issuer, sub)` only** (`sso_identities`, UNIQUE per issuer both ways). Never by email: a new account takes the ID token's email only if verified and free, else `<sub>@sso.aindrive.local`; one that takes it claims the drive invites pending for it (as a legacy sign-up does). An existing account is linked only by the adapter's verified `legacyUserId` (once) or an in-app proof on `/sso/link` (this browser's session, or the password; wallet/Google: sign in first).
- **Rolled-back legacy mapping** (`legacy_mapping` link, later push without that `legacyUserId`): unlinked, and if anyone signed in through the link, before the 200 everything they could have obtained on the account ends — every session JWT (epoch), SSO rows, sockets, uncollected CLI pairings, PATs/OAuth grants/codes made in an SSO session or since the link, wallet sign-in added since. aindrive can't tell them from the owner's, so the owner signs in again. Data and grants stay.
- **Placeholders**: an account the adapter created (`provisioned`) that nobody signed in to yet (`last_login_at` NULL) is replaced by a verified legacy link — a later push with `legacyUserId`, or a proof on `/sso/link` (the callback sends such a sign-in there while legacy login is allowed). Drive grants people gave it (by the work address it took) move to the legacy account, upgrade-only, and it gives that address up for a reserved one. Once used it is the person's account. The placeholder row stays.
- **Silent check**: only GET/HEAD top-level browser navigations to pages (not `/api`, static files, sign-in/sign-up/recovery, `/sso`, `/oauth`, `/cli-login`, MCP/A2A/AG-UI, bots, prefetch/RSC), without a session cookie or `ain_sso_checked`. The cookie (HttpOnly, Lax, Secure on https, 30 min) is set on the redirect (and by the start route for `prompt=none`). The callback turns any failure of a `prompt=none` request into an anonymous visit of `next`; success = the button's path (unlinked → `/sso/link`, which has "Not now"). Every sign-out sets the cookie, so a live AIN session doesn't sign the browser straight back in (AIN's sign-out page also offers "Stay signed in", which returns here with the AIN session alive).
- **Dead session cookie** (its session ended server-side; the Edge middleware can't tell): `/`, `/d/:id` and `/d/:id/manage` ask `staleSessionCheck` before rendering anonymous and repeat the check; the start route and `/api/auth/me` drop the dead cookie.
- **Back-channel logout** also cancels a sign-in of that `sid` (or `sub`) still waiting on `/sso/link`.
- **Sign-up**: while `AINDRIVE_LEGACY_LOGIN=true` "Sign up with AIN" (`prompt=create`) sits next to the legacy sign-up; otherwise it is the sign-up. With `false`, the Google button goes through AIN SSO (`ain_idp=google`).
- **Sessions**: the session JWT gains `ep` (per-account epoch, `users.session_epoch`) and, for SSO sign-ins, `ses` → `sso_sessions` (keyed by the OIDC `sid`). `session.ts verify()` and `dochub.js` check both on every use, so an epoch bump ends cookies, bearer uses and CLI/mobile pairing tokens at once. Old `{sub}` tokens verify as before.
- **Blocked account** = SSO membership rows, none `active`. No session verifies and every sign-in path (password, Google, SIWE, signup, CLI pairing, reset, SSO) refuses it — independent of every switch (rollback never re-activates).
- **Org scope**: PATs and OAuth grants created from an SSO session carry `sso_org_id` (the session's `active_org`, or its only org). Suspension/offboarding of that org revokes them (and burns unredeemed codes); `sso_org_id IS NULL` = personal, never touched.
- **Apply** (`applyDesiredState`): one immediate transaction, version compare-and-set per (issuer, org, sub); older/equal versions are 200 no-ops. `suspended`/`deprovisioned`: end all sessions + revoke the org's credentials before 200, close sockets after commit.
- **Ownership**: every drive is personal (ownership.md §2); `deprovisioned` transfers nothing, never deletes a user. `appRole`/`groups` are recorded and reported, not mapped to drive access.
- Email-OTP reset is never available to an AIN-linked account. Google sign-in never links by email (`lib/google-auth.ts`).

## Gotchas

- `htu` is compared with `AINDRIVE_PUBLIC_URL` + path (TLS proxy in front). Register the adapter as `{AINDRIVE_PUBLIC_URL}/api/sso`.
- Single process: jti replay lives in SQLite (`sso_replay`), which also survives restarts.
- The silent check reads `process.env` inside the Edge middleware sandbox (copied from the server process at runtime), so a restart applies a change; `silent.ts` mirrors `ssoLoginConfig()` because Edge can't import `lib/env`.
- Tests: `lib/__tests__/sso-*.test.ts` (in-test issuer in `sso-test-issuer.ts`).
