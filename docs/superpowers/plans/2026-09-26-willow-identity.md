# Willow identity in the product (Plan 4 of 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People see and manage the devices that write in their name. A wallet sign-in
certifies the browser's device key with the wallet itself ("wallet", not "vouched by
aindrive"), with no extra step. "Remove this device" revokes a device everywhere.

**Architecture:**
- **Sign-in:** the device key rides in the SIWE message's `resources` (`urn:aindrive:device:ed25519:<hex>`), so the one signature the person already makes also certifies the device.
- **Device list:** built from the certificates in the server's per-drive stores.
- **Revocation:** signed by aindrive's attestation key and written into every drive store where the device is known. Sync carries it to every peer, and `resolvePerson` honours it from its timestamp on.

**Spec:** `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md` §4.

## Global Constraints

- No new step for people: the wallet cert comes from the sign-in signature they already make; everyone else keeps the attested cert.
- The strongest valid cert wins when a device has several (wallet > attested).
- Only the signed-in person may list or revoke their own devices.

## Review Focus

1. **A SIWE message whose resources name a different device key**: no wallet cert for the browser's key.
2. **Revoking the device you are using now**: allowed, and the UI says so; the next edit is refused.
3. **A device known in several drives**: revoked in all of them.
4. **Someone else's device key in the revoke request**: refused.
5. **A wallet linked to an email account that did not enable wallet login**: no session, no cert.

### Task 1: certificates accept the SIWE resource line; the strongest cert wins
- `walletCertMessageLine(key)` → `urn:aindrive:device:ed25519:<hex>`; a wallet cert is valid when the message has the line `- urn:aindrive:device:ed25519:<hex>` (SIWE resources) naming the cert's device key.
- `resolvePerson` returns `wallet` strength when any valid cert for the device is wallet-issued.
- Tests: resource line accepted, a different key refused; a device with attested + wallet certs resolves to wallet.

### Task 2: the wallet sign-in issues a wallet cert
- `web/lib/willow/wallet-cert.ts`: `walletCertFromLogin({ message, signature, address, userId, label })` → a `Cert` or null (no resource line); uses `signLink(attestationKey(), address, userId)`.
- `POST /api/wallet/login` returns `{ ok, address, userId, cert? }`.
- Tests: the helper issues a cert that `resolvePerson` (with the server's `trust()`) resolves to the user with `wallet` strength; no resource → null.

### Task 3: the browser signs in with its device key and stores the wallet cert
- `lib/willow/client.ts`: `pendingDeviceKey()` (before anyone is signed in), adopted as the user's device key after sign-in; `rememberWalletCert(userId, cert)`; on start, a remembered wallet cert is written as an `_id/cert` entry.
- `components/use-wallet-login.ts`: `resources: [walletCertMessageLine(pendingKey.publicKey)]`; after login, adopt the key and remember the cert.

### Task 4: the device list and "Remove this device"
- `web/lib/willow/devices.ts`: `listDevices(userId)` (every drive the user is a member of: certs for `userId` in the server store, with label, issuedAt, strength, revoked flag), `revokeDevice(userId, deviceKeyHex)` (refuses a key that is not the user's; writes an attested revocation into every drive store where the key has a cert, from the server's own device key — itself certified by the attestation key).
- `GET /api/willow/devices`, `POST /api/willow/devices/revoke`.
- Account page: a "Devices" section (label, how vouched, "this browser", Remove).
- Tests: list across two drives; revoke writes into both stores and `resolvePerson` then refuses new entries; someone else's key → 403.
