# Willow foundation (Plan 1 of 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pure, shared building blocks every Willow peer needs: device keys, the Willow
parameter schemes with a real signature check, device certificates, the membership
policy, Yjs-documents-as-entries, and the chunked media digest.

**Architecture:** Everything lives in `web/shared/willow/` and `web/shared/media/`: plain
TypeScript with no Node, DOM or Next imports, so the server peer, the browser, the phone
shell and (by hand mirror, Plan 3) the CLI run the same logic. Tests are vitest under
`web/lib/__tests__/` (the web test script runs `vitest run lib/`).

**Tech Stack:** `@earthstar/willow` 0.6.1 + `@earthstar/willow-utils` 2.x (JSR, via
`@jsr:registry`), `@noble/ed25519` 3.1, `@noble/hashes` 2.x, `yjs` 13.6, vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md` (§3–§8)
and `docs/superpowers/specs/2026-09-26-p2p-media-streaming-design.md` (M2).

**The six plans** (each ships working, tested software):
1. **Foundation** (this plan)
2. Server peer + WGPS + browser client (offline editing end to end in the browser)
3. CLI/Mac agent peer (materialise to disk, disk edits, migration from `yjs_entries`)
4. Identity in the product (certificates at sign-in and pairing, device list, revocation)
5. Phone shell peer (the same JS store in the Capacitor shell, keystore plugin)
6. Media: indexer + verifying cache peer (P2P media spec, order step 1)

## Global Constraints

- Namespace: communal, one per drive; nobody holds a namespace secret (spec D1).
- Subspace = device key, Ed25519, 32 bytes, never exported (D2).
- Payload digest: SHA-256, 32 bytes, for document entries.
- Timestamps: microseconds (`bigint`), non-decreasing per subspace (spec §5).
- Paths: `["_id","cert"]`, `["_id","revoke",<deviceKeyHex>]`, `["_acl",<userId>]`,
  `["doc",...docPath,"~u",<seq>]` for updates, `["doc",...docPath,"~u"]` for a
  device's own snapshot. (The `"~u"` segment is a deliberate refinement of spec §5 so a
  snapshot can never prune a different document; update the spec in Task 6.)
- Media chunk size: 1 MiB (1,048,576 bytes); digest = SHA-256 over the concatenated leaf
  SHA-256 hashes (M2).
- `web/shared/` code imports nothing from Node, the DOM, Next, or `@/lib`.
- English only in code, comments and docs.

## Review Focus

1. **A forged or replayed entry** (valid signature from key A placed in subspace B, or a
   byte flipped in the payload): must be refused by `isAuthorisedWrite`/ingest; pinned
   in Task 1.
2. **A revoked device writing after its revocation, and its edits from before**: new
   entries refused, old ones still attributed; pinned in Task 3.
3. **A grant for `notes/` and a write to `notes-old/x.md`**: path prefix is by
   components, not by string; pinned in Task 3.
4. **Two devices of different people editing the same document offline, merged in either
   order**: identical text, each character attributed to its own person; pinned in Task 4.
5. **A media file whose size is an exact multiple of 1 MiB, and an empty file**: correct
   leaf count and root; pinned in Task 5.

---

## File structure

| File | Responsibility |
|---|---|
| `web/shared/willow/bytes.ts` | hex, concat, equality, canonical JSON bytes, component ⇄ string |
| `web/shared/willow/keys.ts` | device keypair: generate, sign, verify |
| `web/shared/willow/schemes.ts` | Willow `StoreSchemes` for aindrive, incl. signature authorisation |
| `web/shared/willow/cert.ts` | device certificates, revocations, `resolvePerson` |
| `web/shared/willow/policy.ts` | grants, `mayWrite` |
| `web/shared/willow/doc.ts` | Yjs update ⇄ entries, read/merge, compact, authors |
| `web/shared/media/chunks.ts` | chunked digest + per-chunk verification |
| `web/shared/media/chunk-vectors.json` | cross-language test vectors |
| `web/lib/__tests__/willow-*.test.ts`, `media-chunks.test.ts` | tests |

---

### Task 1: Device keys and Willow schemes with a real signature check

**Files:**
- Modify: `web/package.json` (dependencies)
- Create: `web/shared/willow/bytes.ts`, `web/shared/willow/keys.ts`, `web/shared/willow/schemes.ts`
- Test: `web/lib/__tests__/willow-schemes.test.ts`

**Interfaces:**
- Produces:
  - `bytes.ts`: `toHex(b: Uint8Array): string`, `fromHex(s: string): Uint8Array`,
    `concat(...parts: Uint8Array[]): Uint8Array`, `equalBytes(a, b): boolean`,
    `utf8(s: string): Uint8Array`, `canonicalJson(v: unknown): Uint8Array` (keys sorted,
    bigint as decimal string), `pathOf(parts: string[]): Uint8Array[]`,
    `partsOf(path: Uint8Array[]): string[]`
  - `keys.ts`: `type DeviceKeypair = { publicKey: Uint8Array; secretKey: Uint8Array }`,
    `generateDeviceKey(): Promise<DeviceKeypair>`, `sign(kp, msg): Promise<Uint8Array>`,
    `verify(pub, msg, sig): Promise<boolean>`
  - `schemes.ts`: `aindriveSchemes` (a `StoreSchemes<Uint8Array, Uint8Array, Uint8Array, DeviceKeypair, Uint8Array, Uint8Array, Uint8Array>`),
    `namespaceOf(driveId: string): Uint8Array`, `newStore(driveId: string): Store<...>` (in-memory drivers),
    `encodeEntryBytes(entry): Uint8Array`, `nowMicros(): bigint`

- [ ] **Step 1: Add the Willow packages to web**

```bash
cd web
npm install "@earthstar/willow@npm:@jsr/earthstar__willow@^0.6.1" "@earthstar/willow-utils@npm:@jsr/earthstar__willow-utils@^2.0.1"
```
Expected: both appear under `dependencies` in `web/package.json` next to `@earthstar/meadowcap`.

- [ ] **Step 2: Write the failing test**

```ts
// web/lib/__tests__/willow-schemes.test.ts
import { describe, it, expect } from "vitest";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore, aindriveSchemes, namespaceOf } from "@/shared/willow/schemes";
import { pathOf, utf8 } from "@/shared/willow/bytes";

describe("aindrive Willow schemes", () => {
  it("a device writes in its own subspace with a real signature", async () => {
    const kp = await generateDeviceKey();
    const store = newStore("drive-1");
    const r = await store.set({ path: pathOf(["doc", "a.md", "~u", "1"]), subspace: kp.publicKey, payload: utf8("hello") }, kp);
    expect(r.kind).toBe("success");
  });

  it("refuses an entry signed by another key (communal rule: the subspace owner signs)", async () => {
    const mom = await generateDeviceKey();
    const eve = await generateDeviceKey();
    const store = newStore("drive-1");
    const r = await store.set({ path: pathOf(["doc", "a.md", "~u", "1"]), subspace: mom.publicKey, payload: utf8("x") }, eve);
    expect(r.kind).toBe("failure");
  });

  it("refuses a token replayed onto a changed entry", async () => {
    const kp = await generateDeviceKey();
    const a = newStore("drive-1");
    const ok = await a.set({ path: pathOf(["doc", "a.md", "~u", "1"]), subspace: kp.publicKey, payload: utf8("x") }, kp);
    if (ok.kind !== "success") throw new Error("setup");
    const b = newStore("drive-1");
    const tampered = { ...ok.entry, timestamp: ok.entry.timestamp + 1n };
    const r = await b.ingestEntry(tampered, ok.authToken);
    expect(r.kind).toBe("failure");
  });

  it("derives one namespace per drive", () => {
    expect(namespaceOf("drive-1")).toEqual(namespaceOf("drive-1"));
    expect(namespaceOf("drive-1")).not.toEqual(namespaceOf("drive-2"));
    expect(aindriveSchemes.namespace.encodedLength(namespaceOf("x"))).toBe(32);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-schemes.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/keys'`.

- [ ] **Step 4: Write `bytes.ts`**

```ts
// web/shared/willow/bytes.ts
// Byte helpers shared by every Willow unit. No Node or DOM imports: this runs in
// the server, the browser and the phone shell.

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** JSON with sorted keys and bigints as decimal strings: the bytes a signature covers. */
export function canonicalJson(v: unknown): Uint8Array {
  const norm = (x: unknown): unknown => {
    if (typeof x === "bigint") return x.toString();
    if (x instanceof Uint8Array) return toHex(x);
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return utf8(JSON.stringify(norm(v)));
}

export const pathOf = (parts: string[]): Uint8Array[] => parts.map(utf8);
export const partsOf = (path: Uint8Array[]): string[] => path.map((c) => new TextDecoder().decode(c));
```

- [ ] **Step 5: Write `keys.ts`**

```ts
// web/shared/willow/keys.ts
// A device's signing key (spec D2): Ed25519, the device's Willow subspace id.
// The browser keeps it non-extractable (Plan 2); this module only does the math.
import * as ed from "@noble/ed25519";

export type DeviceKeypair = { publicKey: Uint8Array; secretKey: Uint8Array };

export async function generateDeviceKey(): Promise<DeviceKeypair> {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { secretKey, publicKey };
}

export const sign = (kp: DeviceKeypair, msg: Uint8Array): Promise<Uint8Array> => ed.signAsync(msg, kp.secretKey);

export async function verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try { return await ed.verifyAsync(sig, msg, pub); } catch { return false; }
}
```

- [ ] **Step 6: Write `schemes.ts`**

```ts
// web/shared/willow/schemes.ts
// Willow parameters for aindrive (spec §3 D1/D2): communal namespace per drive,
// subspace = device key (Ed25519, 32 B), payload digest = SHA-256, and the
// communal-namespace write rule: the token is the subspace owner's signature
// over the encoded entry. Membership (who may write where) is policy.ts, applied
// by peers at ingest (D4); this file is only "is it really from that device".
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeEntry, type Entry } from "@earthstar/willow-utils";
import { Store, KvDriverInMemory, EntryDriverKvStore, PayloadDriverMemory } from "@earthstar/willow";
import { equalBytes, utf8 } from "./bytes";
import { sign, verify, type DeviceKeypair } from "./keys";

type Bytes = Uint8Array;

const fixed32 = {
  encode: (b: Bytes) => b,
  decode: (b: Bytes) => b.slice(0, 32),
  encodedLength: () => 32,
  async decodeStream(bytes: { nextAbsolute(n: number): Promise<void>; array: Bytes; prune(n: number): void }) {
    await bytes.nextAbsolute(32);
    const out = bytes.array.slice(0, 32);
    bytes.prune(32);
    return out;
  },
};

const order = (a: Bytes, b: Bytes): -1 | 0 | 1 => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

function successor32(b: Bytes): Bytes | null {
  const out = b.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 255) { out[i]++; return out; }
    out[i] = 0;
  }
  return null;
}

async function collect(p: Bytes | AsyncIterable<Bytes>): Promise<Bytes> {
  if (p instanceof Uint8Array) return p;
  const parts: Bytes[] = [];
  for await (const c of p) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of parts) { out.set(c, off); off += c.length; }
  return out;
}

const pathScheme = { maxComponentCount: 32, maxComponentLength: 512, maxPathLength: 8192 };

export function encodeEntryBytes(entry: Entry<Bytes, Bytes, Bytes>): Bytes {
  return encodeEntry({ encodeNamespace: (n) => n, encodeSubspace: (s) => s, encodePayload: (d) => d, pathScheme }, entry);
}

const SIG_LEN = 64;

export const aindriveSchemes = {
  path: pathScheme,
  namespace: { ...fixed32, isEqual: equalBytes, defaultNamespaceId: new Uint8Array(32) },
  subspace: { ...fixed32, order, successor: successor32, minimalSubspaceId: new Uint8Array(32) },
  payload: {
    ...fixed32,
    fromBytes: async (b: Bytes | AsyncIterable<Bytes>) => sha256(await collect(b)),
    order,
    defaultDigest: new Uint8Array(32),
  },
  authorisation: {
    authorise: (entry: Entry<Bytes, Bytes, Bytes>, kp: DeviceKeypair) => {
      if (!equalBytes(kp.publicKey, entry.subspaceId)) throw new Error("a device writes only in its own subspace");
      return sign(kp, encodeEntryBytes(entry));
    },
    isAuthorisedWrite: (entry: Entry<Bytes, Bytes, Bytes>, token: Bytes) =>
      token.length === SIG_LEN ? verify(entry.subspaceId, encodeEntryBytes(entry), token) : Promise.resolve(false),
    tokenEncoding: {
      encode: (t: Bytes) => t,
      decode: (b: Bytes) => b.slice(0, SIG_LEN),
      encodedLength: () => SIG_LEN,
      async decodeStream(bytes: { nextAbsolute(n: number): Promise<void>; array: Bytes; prune(n: number): void }) {
        await bytes.nextAbsolute(SIG_LEN);
        const out = bytes.array.slice(0, SIG_LEN);
        bytes.prune(SIG_LEN);
        return out;
      },
    },
  },
  fingerprint: {
    // XOR of SHA-256(encoded entry): associative, commutative, neutral = zeros.
    fingerprintSingleton: async ({ entry }: { entry: Entry<Bytes, Bytes, Bytes> }) => sha256(encodeEntryBytes(entry)),
    fingerprintCombine: (a: Bytes, b: Bytes) => a.map((x, i) => x ^ b[i]),
    fingerprintFinalise: async (a: Bytes) => a,
    neutral: new Uint8Array(32),
    neutralFinalised: new Uint8Array(32),
    isEqual: equalBytes,
    encoding: fixed32,
  },
};

/** One communal namespace per drive, derived from the drive id: nobody holds a secret for it. */
export const namespaceOf = (driveId: string): Bytes => sha256(utf8(`aindrive/namespace/v1/${driveId}`));

export const nowMicros = (): bigint => BigInt(Date.now()) * 1000n;

/** An in-memory store for `driveId` (tests; Plans 2/3 pass persistent drivers). */
export function newStore(driveId: string) {
  const kv = new KvDriverInMemory();
  return new Store({
    namespace: namespaceOf(driveId),
    schemes: aindriveSchemes,
    entryDriver: new EntryDriverKvStore({
      kvDriver: kv,
      namespaceScheme: aindriveSchemes.namespace,
      subspaceScheme: aindriveSchemes.subspace,
      payloadScheme: aindriveSchemes.payload,
      pathScheme: aindriveSchemes.path,
      fingerprintScheme: aindriveSchemes.fingerprint,
      getPayloadLength: () => Promise.resolve(0n),
    }),
    payloadDriver: new PayloadDriverMemory(aindriveSchemes.payload),
  });
}
```

If `EntryDriverKvStore`'s constructor options differ in 0.6.1, read
`node_modules/@earthstar/willow/src/store/storage/entry_drivers/kv_store.ts` and
`cli/src/willow-store.js` (which constructs one today) and match them; if the default
drivers are enough, `new Store({ namespace, schemes })` alone is fine for the in-memory case.

- [ ] **Step 7: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-schemes.test.ts`
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add web/package.json web/package-lock.json web/shared/willow/bytes.ts web/shared/willow/keys.ts web/shared/willow/schemes.ts web/lib/__tests__/willow-schemes.test.ts
git commit -m "feat(willow): device keys and schemes with a real signature check"
```

---

### Task 2: Device certificates, revocations, and who a device is

**Files:**
- Create: `web/shared/willow/cert.ts`
- Test: `web/lib/__tests__/willow-cert.test.ts`

**Interfaces:**
- Consumes: `DeviceKeypair`, `sign`, `verify` (Task 1); `canonicalJson`, `toHex`, `fromHex` (Task 1)
- Produces:
  - `type Issuer = { type: "attestation"; key: string } | { type: "device"; key: string } | { type: "wallet"; address: string; message: string; signature: string; link: SignedLink }`
  - `type SignedLink = { address: string; userId: string; sig: string }` (attestation-signed "wallet address ↔ user")
  - `type Cert = { v: 1; deviceKey: string; userId: string; label: string; issuedAt: string /* µs */; issuer: Issuer; sig: string }`
    (`sig` is by the attestation key or the issuing device; for `wallet` it is empty, the wallet signature covers the device key)
  - `type Revocation = { v: 1; deviceKey: string; userId: string; at: string /* µs */; by: string /* device key hex */; sig: string }`
  - `issueAttestedCert(attestation: DeviceKeypair, deviceKey: Uint8Array, userId: string, label: string, at: bigint): Promise<Cert>`
  - `issueDeviceCert(issuer: DeviceKeypair, deviceKey: Uint8Array, userId: string, label: string, at: bigint): Promise<Cert>`
  - `walletCertMessageLine(deviceKey: Uint8Array): string` → `"aindrive device: ed25519:<hex>"`
  - `issueWalletCert(p: { deviceKey; userId; label; at; address; message; signature; link: SignedLink }): Cert`
  - `signLink(attestation, address, userId): Promise<SignedLink>`
  - `revoke(by: DeviceKeypair, deviceKey: Uint8Array, userId: string, at: bigint): Promise<Revocation>`
  - `type Trust = { attestationKeys: string[]; verifyWallet(message: string, signature: string): Promise<string | null> }`
    (`verifyWallet` returns the recovering address, lowercase, or null; injected so `shared/` stays free of viem)
  - `type Person = { userId: string; strength: "wallet" | "attested" }`
  - `resolvePerson(deviceKeyHex: string, certs: Cert[], revocations: Revocation[], trust: Trust, at?: bigint): Promise<Person | null>`

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-cert.test.ts
import { describe, it, expect } from "vitest";
import { generateDeviceKey } from "@/shared/willow/keys";
import { toHex } from "@/shared/willow/bytes";
import {
  issueAttestedCert, issueDeviceCert, issueWalletCert, walletCertMessageLine, signLink, revoke, resolvePerson, type Trust,
} from "@/shared/willow/cert";

const T0 = 1_000_000n;

async function setup() {
  const aindrive = await generateDeviceKey();
  const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async () => null };
  return { aindrive, trust };
}

describe("device certificates", () => {
  it("an attested device resolves to its person, marked attested", async () => {
    const { aindrive, trust } = await setup();
    const laptop = await generateDeviceKey();
    const cert = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "Mom's laptop", T0);
    expect(await resolvePerson(toHex(laptop.publicKey), [cert], [], trust)).toEqual({ userId: "u-mom", strength: "attested" });
  });

  it("a paired device chains to the approving device's person", async () => {
    const { aindrive, trust } = await setup();
    const laptop = await generateDeviceKey();
    const phone = await generateDeviceKey();
    const c1 = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "laptop", T0);
    const c2 = await issueDeviceCert(laptop, phone.publicKey, "u-mom", "phone", T0 + 1n);
    expect(await resolvePerson(toHex(phone.publicKey), [c1, c2], [], trust)).toEqual({ userId: "u-mom", strength: "attested" });
  });

  it("a device cannot vouch a device into someone else's account", async () => {
    const { aindrive, trust } = await setup();
    const eveLaptop = await generateDeviceKey();
    const evil = await generateDeviceKey();
    const c1 = await issueAttestedCert(aindrive, eveLaptop.publicKey, "u-eve", "eve", T0);
    const c2 = await issueDeviceCert(eveLaptop, evil.publicKey, "u-mom", "fake", T0 + 1n);
    expect(await resolvePerson(toHex(evil.publicKey), [c1, c2], [], trust)).toBeNull();
  });

  it("an unknown attestation key is not trusted", async () => {
    const { trust } = await setup();
    const rogue = await generateDeviceKey();
    const d = await generateDeviceKey();
    const c = await issueAttestedCert(rogue, d.publicKey, "u-mom", "x", T0);
    expect(await resolvePerson(toHex(d.publicKey), [c], [], trust)).toBeNull();
  });

  it("a wallet-signed cert is 'wallet' strength when the wallet and the link check out", async () => {
    const { aindrive } = await setup();
    const d = await generateDeviceKey();
    const message = `aindrive.ainetwork.ai wants you to sign in\n${walletCertMessageLine(d.publicKey)}`;
    const link = await signLink(aindrive, "0xabc", "u-mom");
    const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async (m, s) => (m === message && s === "0xsig" ? "0xabc" : null) };
    const cert = issueWalletCert({ deviceKey: d.publicKey, userId: "u-mom", label: "browser", at: T0, address: "0xabc", message, signature: "0xsig", link });
    expect(await resolvePerson(toHex(d.publicKey), [cert], [], trust)).toEqual({ userId: "u-mom", strength: "wallet" });
    const other = issueWalletCert({ deviceKey: (await generateDeviceKey()).publicKey, userId: "u-mom", label: "b", at: T0, address: "0xabc", message, signature: "0xsig", link });
    expect(await resolvePerson(other.deviceKey, [other], [], trust)).toBeNull(); // the signed message names a different key
  });

  it("a revoked device stops resolving from the revocation time on, not before", async () => {
    const { aindrive, trust } = await setup();
    const laptop = await generateDeviceKey();
    const phone = await generateDeviceKey();
    const c1 = await issueAttestedCert(aindrive, laptop.publicKey, "u-mom", "laptop", T0);
    const c2 = await issueAttestedCert(aindrive, phone.publicKey, "u-mom", "phone", T0);
    const r = await revoke(laptop, phone.publicKey, "u-mom", T0 + 100n);
    expect(await resolvePerson(toHex(phone.publicKey), [c1, c2], [r], trust, T0 + 50n)).not.toBeNull();
    expect(await resolvePerson(toHex(phone.publicKey), [c1, c2], [r], trust, T0 + 100n)).toBeNull();
  });

  it("a revocation by another person's device is ignored", async () => {
    const { aindrive, trust } = await setup();
    const phone = await generateDeviceKey();
    const eve = await generateDeviceKey();
    const c = await issueAttestedCert(aindrive, phone.publicKey, "u-mom", "phone", T0);
    const ce = await issueAttestedCert(aindrive, eve.publicKey, "u-eve", "eve", T0);
    const r = await revoke(eve, phone.publicKey, "u-mom", T0 + 1n);
    expect(await resolvePerson(toHex(phone.publicKey), [c, ce], [r], trust, T0 + 2n)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-cert.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/cert'`.

- [ ] **Step 3: Write `cert.ts`**

```ts
// web/shared/willow/cert.ts
// Who a device is (spec §4): a certificate binds a device key to a person, issued
// in flows people already do. Issuers: aindrive's attestation key (email/Google),
// another device of the same person (pairing), or the person's wallet (SIWE with a
// device line), the last paired with an attested wallet↔user link. Certificates and
// revocations are stored as Willow entries in the device's own subspace (Plan 2);
// this module only builds and checks them.
import { canonicalJson, fromHex, toHex, utf8 } from "./bytes";
import { sign, verify, type DeviceKeypair } from "./keys";

export type SignedLink = { address: string; userId: string; sig: string };
export type Issuer =
  | { type: "attestation"; key: string }
  | { type: "device"; key: string }
  | { type: "wallet"; address: string; message: string; signature: string; link: SignedLink };
export type Cert = { v: 1; deviceKey: string; userId: string; label: string; issuedAt: string; issuer: Issuer; sig: string };
export type Revocation = { v: 1; deviceKey: string; userId: string; at: string; by: string; sig: string };
export type Trust = { attestationKeys: string[]; verifyWallet(message: string, signature: string): Promise<string | null> };
export type Person = { userId: string; strength: "wallet" | "attested" };

const body = (c: Omit<Cert, "sig">) => canonicalJson({ kind: "aindrive-device-cert", ...c });
const linkBody = (address: string, userId: string) => canonicalJson({ kind: "aindrive-wallet-link", address: address.toLowerCase(), userId });
const revBody = (r: Omit<Revocation, "sig">) => canonicalJson({ kind: "aindrive-device-revocation", ...r });

export const walletCertMessageLine = (deviceKey: Uint8Array) => `aindrive device: ed25519:${toHex(deviceKey)}`;

async function issueSigned(signer: DeviceKeypair, issuer: Issuer, deviceKey: Uint8Array, userId: string, label: string, at: bigint): Promise<Cert> {
  const c = { v: 1 as const, deviceKey: toHex(deviceKey), userId, label, issuedAt: at.toString(), issuer };
  return { ...c, sig: toHex(await sign(signer, body(c))) };
}

export const issueAttestedCert = (attestation: DeviceKeypair, deviceKey: Uint8Array, userId: string, label: string, at: bigint) =>
  issueSigned(attestation, { type: "attestation", key: toHex(attestation.publicKey) }, deviceKey, userId, label, at);

export const issueDeviceCert = (issuer: DeviceKeypair, deviceKey: Uint8Array, userId: string, label: string, at: bigint) =>
  issueSigned(issuer, { type: "device", key: toHex(issuer.publicKey) }, deviceKey, userId, label, at);

export async function signLink(attestation: DeviceKeypair, address: string, userId: string): Promise<SignedLink> {
  return { address: address.toLowerCase(), userId, sig: toHex(await sign(attestation, linkBody(address, userId))) };
}

export function issueWalletCert(p: {
  deviceKey: Uint8Array; userId: string; label: string; at: bigint; address: string; message: string; signature: string; link: SignedLink;
}): Cert {
  return {
    v: 1, deviceKey: toHex(p.deviceKey), userId: p.userId, label: p.label, issuedAt: p.at.toString(),
    issuer: { type: "wallet", address: p.address.toLowerCase(), message: p.message, signature: p.signature, link: p.link }, sig: "",
  };
}

export async function revoke(by: DeviceKeypair, deviceKey: Uint8Array, userId: string, at: bigint): Promise<Revocation> {
  const r = { v: 1 as const, deviceKey: toHex(deviceKey), userId, at: at.toString(), by: toHex(by.publicKey) };
  return { ...r, sig: toHex(await sign(by, revBody(r))) };
}

async function linkOk(link: SignedLink, trust: Trust): Promise<boolean> {
  for (const k of trust.attestationKeys) if (await verify(fromHex(k), linkBody(link.address, link.userId), fromHex(link.sig))) return true;
  return false;
}

/**
 * The person behind `deviceKeyHex` at time `at` (µs; default: ignore revocations
 * after "now" = all of them apply), or null. Chains through device-issued certs
 * (max depth 8), never across people.
 */
export async function resolvePerson(deviceKeyHex: string, certs: Cert[], revocations: Revocation[], trust: Trust, at?: bigint): Promise<Person | null> {
  const seen = new Set<string>();
  const walk = async (key: string, depth: number): Promise<Person | null> => {
    if (depth > 8 || seen.has(key)) return null;
    seen.add(key);
    for (const c of certs.filter((c) => c.deviceKey === key)) {
      const p = await certPerson(c, depth);
      if (p && !(await revokedAt(key, p.userId, at))) return p;
    }
    return null;
  };
  const certPerson = async (c: Cert, depth: number): Promise<Person | null> => {
    const { sig, ...rest } = c;
    if (c.issuer.type === "attestation") {
      if (!trust.attestationKeys.includes(c.issuer.key)) return null;
      return (await verify(fromHex(c.issuer.key), body(rest), fromHex(sig))) ? { userId: c.userId, strength: "attested" } : null;
    }
    if (c.issuer.type === "device") {
      if (!(await verify(fromHex(c.issuer.key), body(rest), fromHex(sig)))) return null;
      const parent = await walk(c.issuer.key, depth + 1);
      return parent && parent.userId === c.userId ? parent : null;
    }
    const w = c.issuer;
    if (!w.message.split("\n").includes(`aindrive device: ed25519:${c.deviceKey}`)) return null;
    if ((await trust.verifyWallet(w.message, w.signature))?.toLowerCase() !== w.address) return null;
    if (w.link.address !== w.address || w.link.userId !== c.userId || !(await linkOk(w.link, trust))) return null;
    return { userId: c.userId, strength: "wallet" };
  };
  const revokedAt = async (key: string, userId: string, t?: bigint): Promise<boolean> => {
    for (const r of revocations.filter((r) => r.deviceKey === key && r.userId === userId)) {
      if (t !== undefined && t < BigInt(r.at)) continue;
      const { sig, ...rest } = r;
      if (!(await verify(fromHex(r.by), revBody(rest), fromHex(sig)))) continue;
      if (r.by === key) return true; // a device may retire itself
      const byPerson = await resolveNoRevoke(r.by);
      if (byPerson?.userId === userId) return true;
    }
    return false;
  };
  // the revoker's own standing is checked without revocations, so two devices cannot lock each other out in a loop
  const resolveNoRevoke = (key: string) => resolvePerson(key, certs, [], trust);
  return walk(deviceKeyHex, 0);
}

export const certBytes = (c: Cert) => utf8(JSON.stringify(c));
```

- [ ] **Step 4: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-cert.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add web/shared/willow/cert.ts web/lib/__tests__/willow-cert.test.ts
git commit -m "feat(willow): device certificates, revocations, resolvePerson"
```

---

### Task 3: Grants and the ingest policy

**Files:**
- Create: `web/shared/willow/policy.ts`
- Test: `web/lib/__tests__/willow-policy.test.ts`

**Interfaces:**
- Consumes: `resolvePerson`, `Cert`, `Revocation`, `Trust`, `Person` (Task 2); `canonicalJson`, `toHex`, `fromHex`, `partsOf` (Task 1); `sign`, `verify` (Task 1)
- Produces:
  - `type Role = "viewer" | "commenter" | "editor" | "owner"`
  - `type Grant = { v: 1; driveId: string; userId: string; role: Role; pathPrefix: string[]; expiresAt?: string /* µs */; issuedAt: string; issuer: { type: "attestation" | "device"; key: string }; sig: string }`
  - `signGrant(signer: DeviceKeypair, issuerType: "attestation" | "device", g: Omit<Grant, "v" | "sig" | "issuer">): Promise<Grant>`
  - `type PolicyCtx = { driveId: string; ownerUserId: string; grants: Grant[]; certs: Cert[]; revocations: Revocation[]; trust: Trust }`
  - `type EntryMeta = { subspaceHex: string; path: string[]; timestamp: bigint }`
  - `mayWrite(e: EntryMeta, ctx: PolicyCtx): Promise<{ ok: true; person: Person | null } | { ok: false; reason: "unknown-device" | "revoked" | "not-a-member" | "outside-grant" | "expired" | "bad-grant" }>`

Rules: `["_id", ...]` entries are always accepted (they carry their own proofs and are
checked on use). `["_acl", ...]` entries are accepted only from a device of the owner.
`["doc", ...]` entries need a device that resolves to a person (at the entry's
timestamp) who is the owner or holds an unexpired grant with role `editor` or `owner`
whose `pathPrefix` is a component-wise prefix of the doc path. A grant counts only if
signed by a trusted attestation key or by a device of the owner.

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-policy.test.ts
import { describe, it, expect } from "vitest";
import { generateDeviceKey } from "@/shared/willow/keys";
import { toHex } from "@/shared/willow/bytes";
import { issueAttestedCert, revoke, type Trust } from "@/shared/willow/cert";
import { signGrant, mayWrite, type PolicyCtx } from "@/shared/willow/policy";

const T0 = 1_000_000n;

async function world() {
  const aindrive = await generateDeviceKey();
  const trust: Trust = { attestationKeys: [toHex(aindrive.publicKey)], verifyWallet: async () => null };
  const momDev = await generateDeviceKey();
  const kidDev = await generateDeviceKey();
  const strangerDev = await generateDeviceKey();
  const certs = [
    await issueAttestedCert(aindrive, momDev.publicKey, "u-mom", "mom", T0),
    await issueAttestedCert(aindrive, kidDev.publicKey, "u-kid", "kid", T0),
    await issueAttestedCert(aindrive, strangerDev.publicKey, "u-x", "x", T0),
  ];
  const grant = await signGrant(momDev, "device", { driveId: "d", userId: "u-kid", role: "editor", pathPrefix: ["notes"], issuedAt: T0.toString() });
  const ctx: PolicyCtx = { driveId: "d", ownerUserId: "u-mom", grants: [grant], certs, revocations: [], trust };
  return { aindrive, momDev, kidDev, strangerDev, ctx };
}

const doc = (dev: { publicKey: Uint8Array }, path: string[], t = T0 + 10n) => ({ subspaceHex: toHex(dev.publicKey), path: ["doc", ...path, "~u", "1"], timestamp: t });

describe("mayWrite", () => {
  it("the owner writes anywhere", async () => {
    const w = await world();
    expect((await mayWrite(doc(w.momDev, ["a.md"]), w.ctx)).ok).toBe(true);
  });

  it("an editor writes inside the grant", async () => {
    const w = await world();
    expect(await mayWrite(doc(w.kidDev, ["notes", "a.md"]), w.ctx)).toEqual({ ok: true, person: { userId: "u-kid", strength: "attested" } });
  });

  it("a grant for notes/ does not cover notes-old/", async () => {
    const w = await world();
    expect(await mayWrite(doc(w.kidDev, ["notes-old", "a.md"]), w.ctx)).toEqual({ ok: false, reason: "outside-grant" });
  });

  it("a stranger is not a member", async () => {
    const w = await world();
    expect(await mayWrite(doc(w.strangerDev, ["notes", "a.md"]), w.ctx)).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("an unknown device is refused", async () => {
    const w = await world();
    const ghost = await generateDeviceKey();
    expect(await mayWrite(doc(ghost, ["a.md"]), w.ctx)).toEqual({ ok: false, reason: "unknown-device" });
  });

  it("a revoked device: earlier edits accepted, later ones refused", async () => {
    const w = await world();
    const r = await revoke(w.kidDev, w.kidDev.publicKey, "u-kid", T0 + 100n);
    const ctx = { ...w.ctx, revocations: [r] };
    expect((await mayWrite(doc(w.kidDev, ["notes", "a.md"], T0 + 50n), ctx)).ok).toBe(true);
    expect(await mayWrite(doc(w.kidDev, ["notes", "a.md"], T0 + 150n), ctx)).toEqual({ ok: false, reason: "revoked" });
  });

  it("an expired grant stops counting", async () => {
    const w = await world();
    const g = await signGrant(w.momDev, "device", { driveId: "d", userId: "u-kid", role: "editor", pathPrefix: [], issuedAt: T0.toString(), expiresAt: (T0 + 20n).toString() });
    expect(await mayWrite(doc(w.kidDev, ["b.md"], T0 + 30n), { ...w.ctx, grants: [g] })).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("a grant signed by a non-owner device is ignored", async () => {
    const w = await world();
    const g = await signGrant(w.kidDev, "device", { driveId: "d", userId: "u-x", role: "editor", pathPrefix: [], issuedAt: T0.toString() });
    expect(await mayWrite(doc(w.strangerDev, ["a.md"]), { ...w.ctx, grants: [g] })).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("a viewer grant does not allow writing", async () => {
    const w = await world();
    const g = await signGrant(w.momDev, "device", { driveId: "d", userId: "u-x", role: "viewer", pathPrefix: [], issuedAt: T0.toString() });
    expect(await mayWrite(doc(w.strangerDev, ["a.md"]), { ...w.ctx, grants: [g] })).toEqual({ ok: false, reason: "not-a-member" });
  });

  it("only the owner's devices write _acl entries; _id entries are always accepted", async () => {
    const w = await world();
    const acl = (dev: { publicKey: Uint8Array }) => ({ subspaceHex: toHex(dev.publicKey), path: ["_acl", "u-kid"], timestamp: T0 + 1n });
    expect((await mayWrite(acl(w.momDev), w.ctx)).ok).toBe(true);
    expect((await mayWrite(acl(w.kidDev), w.ctx)).ok).toBe(false);
    const ghost = await generateDeviceKey();
    expect((await mayWrite({ subspaceHex: toHex(ghost.publicKey), path: ["_id", "cert"], timestamp: T0 }, w.ctx)).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-policy.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/policy'`.

- [ ] **Step 3: Write `policy.ts`**

```ts
// web/shared/willow/policy.ts
// Who may write where (spec D4): every peer runs this at ingest, so a non-member's
// entry is refused by the server and by any device alike. Grants mirror the
// server's drive_members rows and are signed by the owner's device or by aindrive's
// attestation key (spec §5).
import { canonicalJson, fromHex, toHex } from "./bytes";
import { sign, verify, type DeviceKeypair } from "./keys";
import { resolvePerson, type Cert, type Person, type Revocation, type Trust } from "./cert";

export type Role = "viewer" | "commenter" | "editor" | "owner";
export type Grant = {
  v: 1; driveId: string; userId: string; role: Role; pathPrefix: string[]; expiresAt?: string; issuedAt: string;
  issuer: { type: "attestation" | "device"; key: string }; sig: string;
};
export type PolicyCtx = { driveId: string; ownerUserId: string; grants: Grant[]; certs: Cert[]; revocations: Revocation[]; trust: Trust };
export type EntryMeta = { subspaceHex: string; path: string[]; timestamp: bigint };
export type Verdict =
  | { ok: true; person: Person | null }
  | { ok: false; reason: "unknown-device" | "revoked" | "not-a-member" | "outside-grant" | "expired" | "bad-grant" };

const grantBody = (g: Omit<Grant, "sig">) => canonicalJson({ kind: "aindrive-grant", ...g });
const WRITE: Role[] = ["editor", "owner"];

export async function signGrant(signer: DeviceKeypair, issuerType: "attestation" | "device", g: Omit<Grant, "v" | "sig" | "issuer">): Promise<Grant> {
  const full = { v: 1 as const, ...g, issuer: { type: issuerType, key: toHex(signer.publicKey) } };
  return { ...full, sig: toHex(await sign(signer, grantBody(full))) };
}

const isPrefix = (prefix: string[], path: string[]) => prefix.length <= path.length && prefix.every((c, i) => path[i] === c);

async function grantValid(g: Grant, ctx: PolicyCtx): Promise<boolean> {
  if (g.driveId !== ctx.driveId) return false;
  const { sig, ...rest } = g;
  if (!(await verify(fromHex(g.issuer.key), grantBody(rest), fromHex(sig)))) return false;
  if (g.issuer.type === "attestation") return ctx.trust.attestationKeys.includes(g.issuer.key);
  const issuer = await resolvePerson(g.issuer.key, ctx.certs, ctx.revocations, ctx.trust, BigInt(g.issuedAt));
  return issuer?.userId === ctx.ownerUserId;
}

export async function mayWrite(e: EntryMeta, ctx: PolicyCtx): Promise<Verdict> {
  const [head, ...rest] = e.path;
  if (head === "_id") return { ok: true, person: null };

  const now = await resolvePerson(e.subspaceHex, ctx.certs, ctx.revocations, ctx.trust, e.timestamp);
  if (!now) {
    const ever = await resolvePerson(e.subspaceHex, ctx.certs, [], ctx.trust);
    return { ok: false, reason: ever ? "revoked" : "unknown-device" };
  }
  if (head === "_acl") return now.userId === ctx.ownerUserId ? { ok: true, person: now } : { ok: false, reason: "not-a-member" };
  if (head !== "doc") return { ok: false, reason: "outside-grant" };
  if (now.userId === ctx.ownerUserId) return { ok: true, person: now };

  const docPath = rest.slice(0, rest.indexOf("~u") < 0 ? rest.length : rest.indexOf("~u"));
  let member = false;
  for (const g of ctx.grants.filter((g) => g.userId === now.userId && WRITE.includes(g.role))) {
    if (g.expiresAt && e.timestamp >= BigInt(g.expiresAt)) continue;
    if (!(await grantValid(g, ctx))) continue;
    member = true;
    if (isPrefix(g.pathPrefix, docPath)) return { ok: true, person: now };
  }
  return { ok: false, reason: member ? "outside-grant" : "not-a-member" };
}
```

- [ ] **Step 4: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-policy.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add web/shared/willow/policy.ts web/lib/__tests__/willow-policy.test.ts
git commit -m "feat(willow): grants and the ingest policy (mayWrite)"
```

---

### Task 4: Yjs documents as entries: append, read, compact, authors

**Files:**
- Create: `web/shared/willow/doc.ts`
- Test: `web/lib/__tests__/willow-doc.test.ts`

**Interfaces:**
- Consumes: `newStore`, `nowMicros`, `aindriveSchemes` (Task 1); `DeviceKeypair` (Task 1); `pathOf`, `partsOf`, `toHex` (Task 1)
- Produces:
  - `type AnyStore = ReturnType<typeof newStore>`
  - `updatePath(docPath: string[], seq: number): Uint8Array[]` → `["doc",...docPath,"~u",<seq padded to 12 digits>]`
  - `snapshotPath(docPath: string[]): Uint8Array[]` → `["doc",...docPath,"~u"]`
  - `appendUpdate(store: AnyStore, kp: DeviceKeypair, docPath: string[], update: Uint8Array, seq: number, timestamp?: bigint): Promise<void>` (throws on ingest failure)
  - `readUpdates(store: AnyStore, docPath: string[]): Promise<{ subspaceHex: string; update: Uint8Array; timestamp: bigint }[]>` (all subspaces, snapshots included)
  - `loadDoc(store: AnyStore, docPath: string[]): Promise<Y.Doc>`
  - `compactOwn(store: AnyStore, kp: DeviceKeypair, docPath: string[]): Promise<void>` (merges only this device's updates into its snapshot; prefix pruning removes its older `~u/<seq>` entries)
  - `authorsByClient(store: AnyStore, docPath: string[]): Promise<Map<number, string>>` (Yjs clientID → subspace hex)

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-doc.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { newStore } from "@/shared/willow/schemes";
import { toHex } from "@/shared/willow/bytes";
import { appendUpdate, loadDoc, compactOwn, readUpdates, authorsByClient } from "@/shared/willow/doc";

function typed(clientId: number, text: string, base?: Uint8Array) {
  const d = new Y.Doc();
  d.clientID = clientId;
  if (base) Y.applyUpdate(d, base);
  const before = Y.encodeStateVector(d);
  d.getText("content").insert(d.getText("content").length, text);
  return { doc: d, update: Y.encodeStateAsUpdate(d, before) };
}

describe("documents as Willow entries", () => {
  it("two people edit offline; any merge order gives the same text and per-client authors", async () => {
    const mom = await generateDeviceKey();
    const kid = await generateDeviceKey();
    const a = typed(1, "mom ");
    const b = typed(2, "kid ");
    const s1 = newStore("d");
    const s2 = newStore("d");
    await appendUpdate(s1, mom, ["a.md"], a.update, 1);
    await appendUpdate(s1, kid, ["a.md"], b.update, 1);
    await appendUpdate(s2, kid, ["a.md"], b.update, 1);
    await appendUpdate(s2, mom, ["a.md"], a.update, 1);
    const t1 = (await loadDoc(s1, ["a.md"])).getText("content").toString();
    const t2 = (await loadDoc(s2, ["a.md"])).getText("content").toString();
    expect(t1).toBe(t2);
    expect(t1).toContain("mom ");
    expect(t1).toContain("kid ");
    const authors = await authorsByClient(s1, ["a.md"]);
    expect(authors.get(1)).toBe(toHex(mom.publicKey));
    expect(authors.get(2)).toBe(toHex(kid.publicKey));
  });

  it("compaction keeps the text, prunes only this device's updates, and keeps others' authorship", async () => {
    const mom = await generateDeviceKey();
    const kid = await generateDeviceKey();
    const s = newStore("d");
    const a1 = typed(1, "one ");
    await appendUpdate(s, mom, ["a.md"], a1.update, 1);
    const a2 = typed(1, "two ", a1.update);
    await appendUpdate(s, mom, ["a.md"], a2.update, 2);
    await appendUpdate(s, kid, ["a.md"], typed(2, "kid").update, 1);
    const before = (await loadDoc(s, ["a.md"])).getText("content").toString();
    await compactOwn(s, mom, ["a.md"]);
    const after = await readUpdates(s, ["a.md"]);
    expect(after.filter((u) => u.subspaceHex === toHex(mom.publicKey))).toHaveLength(1);
    expect(after.filter((u) => u.subspaceHex === toHex(kid.publicKey))).toHaveLength(1);
    expect((await loadDoc(s, ["a.md"])).getText("content").toString()).toBe(before);
    expect((await authorsByClient(s, ["a.md"])).get(2)).toBe(toHex(kid.publicKey));
  });

  it("a snapshot of a.md never prunes a.md.bak", async () => {
    const mom = await generateDeviceKey();
    const s = newStore("d");
    await appendUpdate(s, mom, ["a.md.bak"], typed(1, "keep").update, 1);
    await appendUpdate(s, mom, ["a.md"], typed(1, "x").update, 1);
    await compactOwn(s, mom, ["a.md"]);
    expect((await loadDoc(s, ["a.md.bak"])).getText("content").toString()).toBe("keep");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-doc.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/doc'`.

- [ ] **Step 3: Write `doc.ts`**

```ts
// web/shared/willow/doc.ts
// A collaborative document is the union of the Yjs updates for its path across all
// subspaces (spec D5). Each update is one entry signed by its device; a device may
// fold its own updates into one snapshot at ["doc",...path,"~u"], which prunes its
// older ["doc",...path,"~u",seq] entries (Willow prefix pruning, same subspace only).
import * as Y from "yjs";
import { ANY_SUBSPACE, OPEN_END } from "@earthstar/willow-utils";
import { pathOf, partsOf, toHex } from "./bytes";
import { nowMicros, type newStore } from "./schemes";
import type { DeviceKeypair } from "./keys";

export type AnyStore = ReturnType<typeof newStore>;

export const snapshotPath = (docPath: string[]) => pathOf(["doc", ...docPath, "~u"]);
export const updatePath = (docPath: string[], seq: number) => pathOf(["doc", ...docPath, "~u", String(seq).padStart(12, "0")]);

export async function appendUpdate(store: AnyStore, kp: DeviceKeypair, docPath: string[], update: Uint8Array, seq: number, timestamp = nowMicros()): Promise<void> {
  const r = await store.set({ path: updatePath(docPath, seq), subspace: kp.publicKey, payload: update, timestamp }, kp);
  if (r.kind !== "success") throw new Error(`update not stored: ${r.kind}`);
}

export async function readUpdates(store: AnyStore, docPath: string[]) {
  const out: { subspaceHex: string; update: Uint8Array; timestamp: bigint }[] = [];
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: snapshotPath(docPath), timeRange: { start: 0n, end: OPEN_END } };
  for await (const [entry, payload] of store.query({ area, maxCount: 0, maxSize: 0n }, "timestamp")) {
    const parts = partsOf(entry.path);
    // only this document's own entries: exactly the snapshot, or one level below "~u"
    if (parts.length !== docPath.length + 2 && parts.length !== docPath.length + 3) continue;
    if (!payload) continue;
    out.push({ subspaceHex: toHex(entry.subspaceId), update: await payload.bytes(), timestamp: entry.timestamp });
  }
  return out;
}

export async function loadDoc(store: AnyStore, docPath: string[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const u of await readUpdates(store, docPath)) Y.applyUpdate(doc, u.update);
  return doc;
}

export async function compactOwn(store: AnyStore, kp: DeviceKeypair, docPath: string[]): Promise<void> {
  const me = toHex(kp.publicKey);
  const mine = (await readUpdates(store, docPath)).filter((u) => u.subspaceHex === me);
  if (mine.length < 2) return;
  const merged = Y.mergeUpdates(mine.map((u) => u.update));
  const newest = mine.reduce((t, u) => (u.timestamp > t ? u.timestamp : t), 0n);
  const r = await store.set({ path: snapshotPath(docPath), subspace: kp.publicKey, payload: merged, timestamp: newest + 1n }, kp);
  if (r.kind !== "success") throw new Error(`snapshot not stored: ${r.kind}`);
}

export async function authorsByClient(store: AnyStore, docPath: string[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  for (const u of await readUpdates(store, docPath)) {
    for (const s of Y.decodeUpdate(u.update).structs) map.set(s.id.client, u.subspaceHex);
  }
  return map;
}
```

A device's Yjs `clientID` must be stable per device and document for authorship to be
per device; Plan 2's client sets `doc.clientID` from the device key (first 4 bytes as a
uint32, re-rolled on a collision seen in `authorsByClient`). The prefix-pruning check
in Step 1's second test depends on the snapshot timestamp being newer than every pruned
update, which `newest + 1n` guarantees.

- [ ] **Step 4: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/willow-doc.test.ts`
Expected: 3 passed. If `query` returns entries in a shape other than `[entry, payload, token]`, match `Store.query` in `node_modules/@earthstar/willow/src/store/store.ts`.

- [ ] **Step 5: Commit**

```bash
git add web/shared/willow/doc.ts web/lib/__tests__/willow-doc.test.ts
git commit -m "feat(willow): Yjs documents as signed entries (append, read, compact, authors)"
```

---

### Task 5: Chunked media digest with per-chunk verification

**Files:**
- Create: `web/shared/media/chunks.ts`, `web/shared/media/chunk-vectors.json`
- Test: `web/lib/__tests__/media-chunks.test.ts`

**Interfaces:**
- Produces:
  - `CHUNK_BYTES = 1_048_576`
  - `leafHashes(data: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array[]>` (streams; re-chunks input to exact 1 MiB leaves)
  - `rootOf(leaves: Uint8Array[]): Uint8Array` (SHA-256 of concatenated leaves; for zero leaves, SHA-256 of empty input)
  - `outboardOf(leaves): Uint8Array` / `leavesOf(outboard): Uint8Array[]`
  - `verifyChunk(chunk: Uint8Array, index: number, outboard: Uint8Array, root: Uint8Array): boolean` (checks the outboard against the root, then the chunk against its leaf, and that non-final chunks are exactly 1 MiB)

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/media-chunks.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_BYTES, leafHashes, rootOf, outboardOf, verifyChunk } from "@/shared/media/chunks";
import { toHex } from "@/shared/willow/bytes";

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

describe("chunked media digest", () => {
  it("leaf counts at the edges", async () => {
    expect(await leafHashes(new Uint8Array(0))).toHaveLength(0);
    expect(await leafHashes(pattern(1))).toHaveLength(1);
    expect(await leafHashes(pattern(CHUNK_BYTES))).toHaveLength(1);
    expect(await leafHashes(pattern(CHUNK_BYTES + 1))).toHaveLength(2);
    expect(await leafHashes(pattern(3 * CHUNK_BYTES))).toHaveLength(3);
  });

  it("streaming in odd pieces gives the same leaves as one buffer", async () => {
    const data = pattern(2 * CHUNK_BYTES + 12345);
    async function* pieces() { for (let i = 0; i < data.length; i += 99_991) yield data.slice(i, i + 99_991); }
    expect((await leafHashes(pieces())).map(toHex)).toEqual((await leafHashes(data)).map(toHex));
  });

  it("verifies each chunk and refuses a corrupted one or a forged outboard", async () => {
    const data = pattern(2 * CHUNK_BYTES + 10);
    const leaves = await leafHashes(data);
    const root = rootOf(leaves);
    const ob = outboardOf(leaves);
    const chunk = (i: number) => data.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    expect([0, 1, 2].every((i) => verifyChunk(chunk(i), i, ob, root))).toBe(true);
    const bad = chunk(1); bad[5] ^= 1;
    expect(verifyChunk(bad, 1, ob, root)).toBe(false);
    const forged = ob.slice(); forged[0] ^= 1;
    expect(verifyChunk(chunk(0), 0, forged, root)).toBe(false);
    expect(verifyChunk(chunk(0).slice(0, 10), 0, ob, root)).toBe(false); // a short non-final chunk
  });

  it("matches the cross-language vectors", async () => {
    const v = JSON.parse(readFileSync(join(__dirname, "../../shared/media/chunk-vectors.json"), "utf8")) as { size: number; root: string }[];
    for (const { size, root } of v) expect(toHex(rootOf(await leafHashes(pattern(size))))).toBe(root);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/media-chunks.test.ts`
Expected: FAIL: `Cannot find module '@/shared/media/chunks'`.

- [ ] **Step 3: Write `chunks.ts`**

```ts
// web/shared/media/chunks.ts
// The media payload digest (P2P media spec M2): 1 MiB leaves, SHA-256 each; the
// digest is SHA-256 over the concatenated leaves. The leaf list ("outboard", 32 B
// per MiB) lets any peer's chunk be checked on arrival. Mirrored by hand in Java
// and Swift (Plan 6); chunk-vectors.json keeps them identical.
import { sha256 } from "@noble/hashes/sha2.js";
import { equalBytes } from "../willow/bytes";

export const CHUNK_BYTES = 1_048_576;

export async function leafHashes(data: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const leaves: Uint8Array[] = [];
  if (data instanceof Uint8Array) {
    for (let i = 0; i < data.length; i += CHUNK_BYTES) leaves.push(sha256(data.subarray(i, i + CHUNK_BYTES)));
    return leaves;
  }
  let buf = new Uint8Array(CHUNK_BYTES);
  let fill = 0;
  for await (const piece of data) {
    let off = 0;
    while (off < piece.length) {
      const n = Math.min(CHUNK_BYTES - fill, piece.length - off);
      buf.set(piece.subarray(off, off + n), fill);
      fill += n; off += n;
      if (fill === CHUNK_BYTES) { leaves.push(sha256(buf)); buf = new Uint8Array(CHUNK_BYTES); fill = 0; }
    }
  }
  if (fill > 0) leaves.push(sha256(buf.subarray(0, fill)));
  return leaves;
}

export const outboardOf = (leaves: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(leaves.length * 32);
  leaves.forEach((l, i) => out.set(l, i * 32));
  return out;
};

export const leavesOf = (outboard: Uint8Array): Uint8Array[] =>
  Array.from({ length: outboard.length / 32 }, (_, i) => outboard.slice(i * 32, i * 32 + 32));

export const rootOf = (leaves: Uint8Array[]): Uint8Array => sha256(outboardOf(leaves));

export function verifyChunk(chunk: Uint8Array, index: number, outboard: Uint8Array, root: Uint8Array): boolean {
  if (outboard.length % 32 !== 0 || !equalBytes(sha256(outboard), root)) return false;
  const count = outboard.length / 32;
  if (index < 0 || index >= count) return false;
  if (index < count - 1 && chunk.length !== CHUNK_BYTES) return false;
  if (chunk.length === 0 || chunk.length > CHUNK_BYTES) return false;
  return equalBytes(sha256(chunk), outboard.subarray(index * 32, index * 32 + 32));
}
```

- [ ] **Step 4: Generate the vectors from this implementation**

```bash
cd web && cat > /tmp/gen-chunk-vectors.test.ts <<'TS'
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { leafHashes, rootOf } from "@/shared/media/chunks";
import { toHex } from "@/shared/willow/bytes";
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
it("writes chunk-vectors.json", async () => {
  const out = [];
  for (const size of [0, 1, 1048575, 1048576, 1048577, 3145728]) out.push({ size, root: toHex(rootOf(await leafHashes(pattern(size)))) });
  writeFileSync("shared/media/chunk-vectors.json", JSON.stringify(out, null, 2) + "\n");
});
TS
cp /tmp/gen-chunk-vectors.test.ts lib/__tests__/zz-gen-vectors.test.ts && npx vitest run lib/__tests__/zz-gen-vectors.test.ts; rm lib/__tests__/zz-gen-vectors.test.ts
```
Expected: a JSON file with six `{ size, root }` rows; `size: 0` has root
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (SHA-256 of nothing).

- [ ] **Step 5: Run the test until it passes**

Run: `cd web && npx vitest run lib/__tests__/media-chunks.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add web/shared/media/chunks.ts web/shared/media/chunk-vectors.json web/lib/__tests__/media-chunks.test.ts
git commit -m "feat(media): chunked SHA-256 digest with per-chunk verification + vectors"
```

---

### Task 6: Document the foundation

**Files:**
- Create: `web/shared/willow/README.md`
- Modify: `web/shared/README.md` (a pointer line), `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md` §5 (the `"~u"` segment)

- [ ] **Step 1: Write `web/shared/willow/README.md`**

```markdown
# web/shared/willow — Willow building blocks (pure, shared)

Spec: `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md`.
No Node/DOM/Next imports: the server peer, the browser, the phone shell and (mirrored
by hand) the CLI run this code.

| File | What |
|---|---|
| `bytes.ts` | hex, concat, canonical JSON (what signatures cover), path components |
| `keys.ts` | device Ed25519 keypair = the device's subspace |
| `schemes.ts` | Willow parameters: communal namespace per drive (`namespaceOf`), subspace owner signs (`isAuthorisedWrite`) |
| `cert.ts` | device certificates (attestation / device / wallet), revocations, `resolvePerson` |
| `policy.ts` | owner-signed grants, `mayWrite` — every peer runs it at ingest |
| `doc.ts` | a Yjs document = its updates across subspaces; compaction; clientID → author |

Paths: `["_id","cert"]`, `["_id","revoke",<key>]`, `["_acl",<userId>]`,
`["doc",...path,"~u",<seq>]`, snapshot `["doc",...path,"~u"]`.
Gotcha: timestamps are microseconds; compaction must stamp the snapshot newer than
every update it replaces, or prefix pruning keeps them.
```

- [ ] **Step 2: Add a pointer to `web/shared/README.md`** (one line in its file map)

```markdown
- `willow/` — Willow building blocks (keys, schemes, certificates, policy, documents); see `willow/README.md`. `media/chunks.ts` — the chunked media digest.
```

- [ ] **Step 3: Update spec §5's path list** to `["doc", <docPath...>, "~u", <seq>]` and
  `["doc", <docPath...>, "~u"]`, with one sentence: the `"~u"` segment keeps a snapshot
  from pruning another document whose path starts the same.

- [ ] **Step 4: Run the whole web test suite**

Run: `cd web && npm test`
Expected: all tests pass, including the five new files.

- [ ] **Step 5: Commit**

```bash
git add web/shared/willow/README.md web/shared/README.md docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md
git commit -m "docs(willow): shared foundation README; spec path layout uses ~u"
```
