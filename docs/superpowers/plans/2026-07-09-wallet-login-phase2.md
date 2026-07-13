# Wallet-login Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wallet-provisioned accounts legible and durable — stop leaking their synthetic email, tell the user their account is wallet-only (no recovery), and let them *optionally* attach a real email+password as an alternative login.

**Architecture:** Three spec §5 items. (1) A pure display helper de-leaks the synthetic `<addr>@wallet.aindrive.local` email at every render site. (2) The logged-in landing shows a "wallet account — no recovery" affordance when the current user is wallet-only. (3) Two authenticated endpoints + a form let a wallet-only account attach an OTP-verified email + password, reusing the existing OTP machinery. No wallet-key recovery, no account merging (spec "Explicitly NOT built").

**Tech Stack:** Next.js App Router (server + client components), TypeScript + plain-ESM JS under `web/lib/`, better-sqlite3, `web/lib/otp.ts` (OTP), `web/lib/email` (`sendMail`), `bcryptjs`, vitest.

## Global Constraints

- **Package boundary:** all work inside `web/`; no cross-package imports. `web/shared/` holds code reused across server + client inside web.
- **Test runner:** `cd web && npm test`; one file `cd web && npx vitest run lib/__tests__/<f>`; typecheck `cd web && npm run typecheck` (MUST be clean; `.ts` import extensions fail it — use `.js` for dynamic route imports per repo convention).
- **Test DB pattern:** `process.env.AINDRIVE_DATA_DIR = mkdtempSync(...)` before the first `await import("../db.js")`; env via `vi.stubEnv` + `afterEach(vi.unstubAllEnvs)`.
- **Synthetic wallet email:** wallet-provisioned accounts have `email = <lowercased 0x address>@wallet.aindrive.local` and an unusable `password_hash` (`web/lib/wallet.ts` `resolveAccountForWallet`). This is the single signal for "wallet-only account".
- **OTP:** `issueOtpCode(email, purpose): string`, `verifyOtpCode(email, code, purpose): { ok: true } | { ok: false; reason; remainingAttempts? }`. Purposes are a string-union `OtpPurpose` in `web/lib/otp.ts`.
- **Email:** `sendMail(msg)` / `mailConfigured()` from `web/lib/email`.
- **Never force email.** Attaching email is opt-in; a wallet-only account stays fully usable without it. This is NOT wallet-key recovery.

---

## File Structure

- `web/shared/wallet-display.ts` — CREATE. `isWalletOnlyEmail(email)` + `walletDisplayLabel(email, name?)` (pure; used by server `page.tsx` and client components).
- `web/components/drive-manage.tsx`, `web/components/share-dialog-sections.tsx`, `web/app/page.tsx` — MODIFY. Render `walletDisplayLabel(...)` instead of raw `email`.
- `web/app/page.tsx` — MODIFY. Show a wallet-only affordance (badge + "Add an email" entry) when `isWalletOnlyEmail(user.email)`.
- `web/lib/otp.ts` — MODIFY. Add `"attach_email"` to `OtpPurpose`.
- `web/app/api/account/email/start/route.ts` — CREATE. Authenticated; wallet-only guard; issue + send OTP for a candidate email.
- `web/app/api/account/email/verify/route.ts` — CREATE. Authenticated; wallet-only guard; verify OTP; set `email` + `password_hash`.
- `web/components/add-email-form.tsx` — CREATE. Client form (email → code + password → done); embedded in `page.tsx`.
- Tests: `web/lib/__tests__/wallet-display.test.ts`, `web/lib/__tests__/account-email.test.ts` (CREATE).

---

## Task 1: De-leak helper + apply at render sites

**Files:**
- Create: `web/shared/wallet-display.ts`, `web/lib/__tests__/wallet-display.test.ts`
- Modify: `web/components/drive-manage.tsx` (187, 217, 219, 220), `web/components/share-dialog-sections.tsx` (521, 560), `web/app/page.tsx` (Sign out label)

**Interfaces:**
- Produces: `isWalletOnlyEmail(email: string): boolean`; `walletDisplayLabel(email: string, name?: string | null): string`.

**Why:** A wallet-only account's synthetic email/`wallet:0x…` name currently renders to itself and to other drive members (the owner roster). Show a truncated wallet address instead.

- [ ] **Step 1: Write the failing test** — `web/lib/__tests__/wallet-display.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isWalletOnlyEmail, walletDisplayLabel } from "../../shared/wallet-display";

const ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

describe("wallet-display", () => {
  it("detects the synthetic wallet email (case-insensitive)", () => {
    expect(isWalletOnlyEmail(`${ADDR}@wallet.aindrive.local`)).toBe(true);
    expect(isWalletOnlyEmail(`${ADDR.toUpperCase()}@WALLET.AINDRIVE.LOCAL`)).toBe(true);
    expect(isWalletOnlyEmail("real@example.com")).toBe(false);
  });

  it("truncates the wallet address for a wallet-only email", () => {
    expect(walletDisplayLabel(`${ADDR}@wallet.aindrive.local`)).toBe("0x7099…79c8");
  });

  it("returns name (then email) for a real account", () => {
    expect(walletDisplayLabel("real@example.com", "Alice")).toBe("Alice");
    expect(walletDisplayLabel("real@example.com")).toBe("real@example.com");
  });

  it("ignores the wallet:… name and uses the address for wallet-only accounts", () => {
    expect(walletDisplayLabel(`${ADDR}@wallet.aindrive.local`, "wallet:0x70997970")).toBe("0x7099…79c8");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run lib/__tests__/wallet-display.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `web/shared/wallet-display.ts`**

```ts
// Display helpers for wallet-provisioned accounts, whose email is a synthetic
// `<lowercased 0x address>@wallet.aindrive.local` placeholder (web/lib/wallet.ts
// resolveAccountForWallet). Never show that placeholder to a human — show a
// truncated wallet address instead. Pure; used by server + client.
const SYNTH_SUFFIX = "@wallet.aindrive.local";

export function isWalletOnlyEmail(email: string): boolean {
  return email.toLowerCase().endsWith(SYNTH_SUFFIX);
}

export function walletDisplayLabel(email: string, name?: string | null): string {
  if (!isWalletOnlyEmail(email)) return name || email;
  // The local-part of the synthetic email IS the lowercased wallet address.
  const addr = email.slice(0, email.length - SYNTH_SUFFIX.length);
  return addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
```

- [ ] **Step 4: Run to verify it passes** — `cd web && npx vitest run lib/__tests__/wallet-display.test.ts` → PASS (4/4).

- [ ] **Step 5: Apply at the render sites**

Import in each file: `import { walletDisplayLabel } from "@/shared/wallet-display";`.

- `web/components/drive-manage.tsx`: the roster renders `p.email` (line ~187) and `p.name || p.email` (219) with `p.email` as sub-label (220). Replace the human-facing label with `walletDisplayLabel(p.email, p.name)`; where BOTH name and email show (219 name, 220 email sub-label), for a wallet-only member collapse to just `walletDisplayLabel(p.email)` (no synthetic sub-label): render the sub-label (220) only when `!isWalletOnlyEmail(p.email)`. Import `isWalletOnlyEmail` too.
- `web/components/share-dialog-sections.tsx` (521, 560): `m.name || m.email` → `walletDisplayLabel(m.email, m.name)`. The `aria-label`s at 528/542 may keep `m.email` (screen-reader/aria; not a visible leak) — leave them.
- `web/app/page.tsx`: `Sign out ({user.email})` → `Sign out ({walletDisplayLabel(user.email, user.name)})`.

- [ ] **Step 6: Typecheck + full suite + commit**

```bash
cd web && npm run typecheck && npm test && cd ..
git add web/shared/wallet-display.ts web/lib/__tests__/wallet-display.test.ts web/components/drive-manage.tsx web/components/share-dialog-sections.tsx web/app/page.tsx
git commit -m "feat(ui): de-leak wallet-provisioned synthetic email in member/account displays

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wallet-only "no recovery" affordance on the landing

**Files:**
- Modify: `web/app/page.tsx`
- Create: (none — static markup; the interactive form is Task 5)

**Why:** A wallet-only account must know it is recoverable ONLY by its wallet (state legibility). Show it where the user lands after login, next to where Task 5 will mount the "Add an email" form.

- [ ] **Step 1: Add the affordance** — in `web/app/page.tsx` (a server component; `user` is from `getUser()`), when `isWalletOnlyEmail(user.email)` render a banner below the header:

```tsx
{isWalletOnlyEmail(user.email) && (
  <div className="mb-6 rounded-xl border border-drive-border bg-drive-panel px-4 py-3 text-sm">
    <p className="font-medium text-drive-text">This is a wallet account</p>
    <p className="mt-0.5 text-drive-muted">
      You sign in with your wallet. There is no password recovery — lose the wallet
      and you lose access. Add an email to enable a second way in.
    </p>
    {/* Task 5 mounts <AddEmailForm/> here */}
  </div>
)}
```

Import `isWalletOnlyEmail` from `@/shared/wallet-display` (already imported for Task 1). Keep copy honest — do NOT imply aindrive can recover the wallet.

- [ ] **Step 2: Typecheck + build sanity + commit**

```bash
cd web && npm run typecheck && cd ..
git add web/app/page.tsx
git commit -m "feat(ui): wallet-only accounts show a 'no recovery' affordance on landing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: OTP purpose + `POST /api/account/email/start`

**Files:**
- Modify: `web/lib/otp.ts` (add purpose)
- Create: `web/app/api/account/email/start/route.ts`
- Test: `web/lib/__tests__/account-email.test.ts` (create; covers start + verify across Tasks 3–4)

**Interfaces:**
- Consumes: `getUser` (`@/lib/session`), `db` (`@/lib/db`), `issueOtpCode` (`@/lib/otp`), `sendMail`/`mailConfigured` (`@/lib/email`), `isWalletOnlyEmail` (`@/shared/wallet-display`), `tryConsume`/`clientKey` (`@/lib/rate-limit`), zod.
- Produces: `POST` → 200 `{ ok: true }` (code issued+sent) | 400 invalid | 401 unauth | 403 not a wallet-only account | 409 email taken | 429.

**Why:** Step one of attaching an email to a wallet-only account: prove the account is wallet-only, that the target email is free, then issue+send an OTP.

- [ ] **Step 1: Add the OTP purpose** — in `web/lib/otp.ts`, extend:
```ts
export type OtpPurpose = "reset_password" | "signup" | "attach_email";
```

- [ ] **Step 2: Write the failing test** (start-half) — `web/lib/__tests__/account-email.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-attach-"));

// Auth + mail stubbed; OTP + DB are real (we assert real rows/updates).
let currentUser: { id: string; email: string; name: string } | null = null;
vi.mock("@/lib/session", () => ({ getUser: async () => currentUser, setCookie: async () => {} }));
vi.mock("@/lib/email", () => ({ sendMail: vi.fn(async () => {}), mailConfigured: () => true }));
vi.mock("@/lib/rate-limit", () => ({ tryConsume: () => ({ ok: true }), clientKey: () => "k" }));

const { db } = await import("../db.js");
const { POST: START } = await import("../../app/api/account/email/start/route.js");

// Seed a wallet-only account (synthetic email) and a real account.
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
  .run("w1", "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", "wallet:0xabc", "x");
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
  .run("r1", "taken@example.com", "R1", "x");

const jsonReq = (body: unknown) => new Request("http://localhost/api/account/email/start", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("POST /api/account/email/start", () => {
  beforeEach(() => { currentUser = null; });

  it("401 when not logged in", async () => {
    expect((await START(jsonReq({ email: "new@example.com" }))).status).toBe(401);
  });

  it("403 when the account is not wallet-only", async () => {
    currentUser = { id: "r1", email: "taken@example.com", name: "R1" };
    expect((await START(jsonReq({ email: "new2@example.com" }))).status).toBe(403);
  });

  it("409 when the target email is already taken", async () => {
    currentUser = { id: "w1", email: "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", name: "w" };
    expect((await START(jsonReq({ email: "taken@example.com" }))).status).toBe(409);
  });

  it("200 and issues an OTP for a free email on a wallet-only account", async () => {
    currentUser = { id: "w1", email: "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", name: "w" };
    const res = await START(jsonReq({ email: "new@example.com" }));
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT purpose FROM email_verification_codes WHERE email = ? AND consumed = 0").get("new@example.com");
    expect(row).toMatchObject({ purpose: "attach_email" });
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `cd web && npx vitest run lib/__tests__/account-email.test.ts` → FAIL (route missing).

- [ ] **Step 4: Create `web/app/api/account/email/start/route.ts`**

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { issueOtpCode } from "@/lib/otp";
import { sendMail, mailConfigured } from "@/lib/email";
import { isWalletOnlyEmail } from "@/shared/wallet-display";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({ email: z.string().email() });

// Step 1 of attaching a real email to a wallet-only account: prove the caller
// IS a wallet-only account, the target email is free, then issue + send an OTP.
export async function POST(req: Request) {
  const rl = tryConsume({ name: "attach-email-start", key: clientKey(req, "attach-email-start"), limit: 5, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isWalletOnlyEmail(user.email)) return NextResponse.json({ error: "not_wallet_only" }, { status: 403 });

  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid email" }, { status: 400 });
  const email = body.data.email.toLowerCase();
  if (isWalletOnlyEmail(email)) return NextResponse.json({ error: "reserved domain" }, { status: 400 });

  const taken = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  if (taken) return NextResponse.json({ error: "email_taken" }, { status: 409 });

  const code = issueOtpCode(email, "attach_email");
  if (mailConfigured()) {
    await sendMail({
      to: email,
      subject: "Your aindrive email verification code",
      text: `Your code is ${code}. It expires in 10 minutes.`,
    });
  }
  return NextResponse.json({ ok: true });
}
```

> If `MailMessage` requires more/other fields than `{ to, subject, text }`, read `web/lib/email/sender.ts` and match its shape (the reset-password route is a working example to mirror).

- [ ] **Step 5: Run the start-half tests green** — `cd web && npx vitest run lib/__tests__/account-email.test.ts` → the 4 start tests PASS. (verify-half added in Task 4.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd web && npm run typecheck && cd ..
git add web/lib/otp.ts web/app/api/account/email/start/route.ts web/lib/__tests__/account-email.test.ts
git commit -m "feat(account): POST /api/account/email/start — OTP to attach email to a wallet account

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `POST /api/account/email/verify` (set email + password)

**Files:**
- Create: `web/app/api/account/email/verify/route.ts`
- Test: extend `web/lib/__tests__/account-email.test.ts`

**Interfaces:**
- Produces: `POST` → 200 `{ ok: true }` (email+password set) | 400 | 401 | 403 not wallet-only | 409 email taken (race) | 422 bad code.

**Why:** Step two: verify the OTP and durably attach the email + a real password to the wallet-only account, giving it a second login. The wallet link stays; nothing is removed.

- [ ] **Step 1: Write the failing tests** — append to `account-email.test.ts` (reuse `db`, `currentUser`, `jsonReq` pattern; import the verify route + `issueOtpCode`/`verifyOtpCode` as needed):

```ts
const { POST: VERIFY } = await import("../../app/api/account/email/verify/route.js");
const { issueOtpCode } = await import("../otp.js");

const vReq = (body: unknown) => new Request("http://localhost/api/account/email/verify", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("POST /api/account/email/verify", () => {
  beforeEach(() => { currentUser = null; });

  it("attaches the email + password to the wallet-only account on a valid code", async () => {
    currentUser = { id: "w1", email: "0xabc0000000000000000000000000000000000001@wallet.aindrive.local", name: "w" };
    const code = issueOtpCode("attach@example.com", "attach_email");
    const res = await VERIFY(vReq({ email: "attach@example.com", code, password: "hunter2hunter2" }));
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT email, password_hash FROM users WHERE id = ?").get("w1") as { email: string; password_hash: string };
    expect(row.email).toBe("attach@example.com");
    expect(row.password_hash).not.toBe("x"); // real bcrypt hash now
  });

  it("422 on a wrong code", async () => {
    currentUser = { id: "w1", email: "attach@example.com", name: "w" }; // note: now real after prior test — reseed a fresh wallet-only user
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("w2", "0xdef0000000000000000000000000000000000002@wallet.aindrive.local", "wallet:0xdef", "x");
    currentUser = { id: "w2", email: "0xdef0000000000000000000000000000000000002@wallet.aindrive.local", name: "w" };
    issueOtpCode("attach2@example.com", "attach_email");
    const res = await VERIFY(vReq({ email: "attach2@example.com", code: "000000", password: "hunter2hunter2" }));
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (verify route missing).

- [ ] **Step 3: Create `web/app/api/account/email/verify/route.ts`**

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { verifyOtpCode } from "@/lib/otp";
import { isWalletOnlyEmail } from "@/shared/wallet-display";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({
  email: z.string().email(),
  code: z.string().min(4),
  password: z.string().min(8),
});

// Step 2: verify the OTP, then attach the email + a real password to the
// wallet-only account. The wallet credential stays; this only ADDS an email
// login (never wallet-key recovery). Guarded so a real account can't reroute
// its email through this path.
export async function POST(req: Request) {
  const rl = tryConsume({ name: "attach-email-verify", key: clientKey(req, "attach-email-verify"), limit: 10, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } });

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isWalletOnlyEmail(user.email)) return NextResponse.json({ error: "not_wallet_only" }, { status: 403 });

  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const email = body.data.email.toLowerCase();
  if (isWalletOnlyEmail(email)) return NextResponse.json({ error: "reserved domain" }, { status: 400 });

  const verdict = verifyOtpCode(email, body.data.code, "attach_email");
  if (!verdict.ok) return NextResponse.json({ error: "bad_code", reason: verdict.reason }, { status: 422 });

  const hash = bcrypt.hashSync(body.data.password, 10);
  try {
    db.prepare("UPDATE users SET email = ?, password_hash = ? WHERE id = ?").run(email, hash, user.id);
  } catch (e) {
    // email UNIQUE lost a race between start's check and here.
    if (/UNIQUE/i.test((e as Error).message)) return NextResponse.json({ error: "email_taken" }, { status: 409 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests green** — `cd web && npx vitest run lib/__tests__/account-email.test.ts` → all start + verify tests PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

```bash
cd web && npm run typecheck && npm test && cd ..
git add web/app/api/account/email/verify/route.ts web/lib/__tests__/account-email.test.ts
git commit -m "feat(account): POST /api/account/email/verify — attach OTP-verified email+password

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add-email form, wired into the landing

**Files:**
- Create: `web/components/add-email-form.tsx`
- Modify: `web/app/page.tsx` (mount the form inside the Task 2 affordance)

**Why:** The user-facing opt-in. A two-step client form (email → code+password) hitting the Task 3/4 endpoints; no wallet hooks, so it's safe under the root layout (no web3 bundle).

- [ ] **Step 1: Create `web/components/add-email-form.tsx`**

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui";

type Stage = "email" | "code" | "done";

export function AddEmailForm() {
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const res = await fetch("/api/account/email/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || "could not send code"); return; }
    setStage("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const res = await fetch("/api/account/email/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, password }),
    });
    setBusy(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || "could not verify"); return; }
    setStage("done");
  }

  if (stage === "done") {
    return <p className="mt-3 text-sm text-drive-accent">Email added — you can now also sign in with {email}.</p>;
  }
  return (
    <form onSubmit={stage === "email" ? start : verify} className="mt-3 flex flex-col gap-2 max-w-sm">
      <input
        type="email" required placeholder="you@example.com" value={email}
        onChange={(e) => setEmail(e.target.value)} disabled={stage === "code"}
        className="rounded-lg border border-drive-border px-3 py-2 text-sm"
      />
      {stage === "code" && (
        <>
          <input
            required placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)}
            className="rounded-lg border border-drive-border px-3 py-2 text-sm"
          />
          <input
            type="password" required minLength={8} placeholder="Set a password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-drive-border px-3 py-2 text-sm"
          />
        </>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" size="sm" loading={busy} disabled={busy} className="self-start">
        {stage === "email" ? "Send code" : "Verify & add email"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Mount it in `web/app/page.tsx`**

Replace the `{/* Task 5 mounts <AddEmailForm/> here */}` comment inside the Task 2 affordance with `<AddEmailForm />`, and add `import { AddEmailForm } from "@/components/add-email-form";` at the top of `page.tsx`.

- [ ] **Step 3: Typecheck + full suite + commit**

```bash
cd web && npm run typecheck && npm test && cd ..
git add web/components/add-email-form.tsx web/app/page.tsx
git commit -m "feat(account): add-email form for wallet-only accounts (opt-in second login)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Regression, E2E smoke, PR

- [ ] **Step 1: Full regression** — `cd web && npm test` (all green) + `cd web && npm run typecheck` (clean). Record counts.

- [ ] **Step 2: Optional smoke** — start the dev server; as a logged-in wallet-only account, `POST /api/account/email/start` then `/verify` with the issued code (readable from the dev DB or mail sender log), then confirm the account can log in with the new email+password. Document in the PR.

- [ ] **Step 3: Push + draft PR**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git push -u origin wallet-login-phase2
gh pr create --draft --base main --title "Wallet-login Phase 2: legibility + opt-in email upgrade" --body "<summarize the 3 spec §5 items; note NOT built: wallet-key recovery, account merging>"
```

---

## Self-Review

**1. Spec coverage (spec §5):** §8 de-leak → Task 1; §9 "no recovery" legible → Task 2; §10 opt-in email link → Tasks 3–5 (start/verify endpoints + form). "Explicitly NOT built" (wallet-key recovery, account merging) — not implemented, correct. ✅

**2. Placeholder scan:** every step has full code or a precise edit; test code complete. No TBD. ✅

**3. Type consistency:** `isWalletOnlyEmail`/`walletDisplayLabel` (Task 1) consumed in Tasks 2–4 and endpoints. `OtpPurpose` gains `"attach_email"` (Task 3) used in Tasks 3–4. Endpoint contracts (`/start`, `/verify`) consumed by the form (Task 5). ✅

**Not in scope (spec "Explicitly NOT built" + Phase-1 follow-ups tracked elsewhere):** wallet-key recovery; account merging; the `/login` page wallet button (bundle decision); enabling wallet-login on a real email account (`login_enabled=1` opt-in); the review's chainId-binding hardening.
