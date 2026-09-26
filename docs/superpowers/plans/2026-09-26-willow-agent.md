# Willow agent peer (Plan 3 of 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The folder's own agent (CLI, and the Mac app, which bundles it) is a Willow
peer. It writes the merged document into the real file on disk, turns edits made
directly on disk into signed updates, imports old history once, and browsers stop
writing files themselves.

**Architecture:** The pure Willow code stays in `web/shared/willow/`. A generator
compiles it into `cli/src/willow-shared/` (committed, marked generated, drift-tested),
so the independent `cli/` package has its own copy without hand-mirroring. The agent
opens a second WebSocket, `/api/willow/sync`, authenticated with its agent token, and
runs the same `SyncSession` as the browser. The agent is a device of the drive owner,
certified by aindrive when the agent authenticates.

**Tech Stack:** as Plans 1–2; `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/markdown`,
`@tiptap/y-tiptap` headless in Node (verified by a spike: markdown ⇄ Yjs round-trips
with the editor's own serializer).

**Spec:** `docs/superpowers/specs/2026-09-26-willow-local-first-docs-design.md` (§3 D8, §7 Disk, §8 Migration).

## Global Constraints

- Everything from Plans 1–2.
- Packages stay independent: `cli/` never imports from `web/`; it gets generated copies.
- The agent writes a file only through `safeResolve` (`cli/src/rpc.js`), and only for a
  document whose path is canonical (`normalizePath` form) and whose `"~u"` sits right
  after the doc path (Plan 2 review minor, due here).
- Materialise at most every 2 s per document; never write when the content is unchanged.
- An agent's own writes must not come back as disk edits (the existing self-write
  suppression in `rpc.js`).

## Review Focus

1. **The file on disk and the Willow document disagree when the agent starts** (someone
   edited the file while the agent was off): the disk edit becomes a signed update;
   nothing is lost on either side.
2. **A disk edit and a browser edit to the same document within the same 2 s**: both
   survive (merge through Yjs, not last-writer-wins on the file).
3. **A document path that is not canonical, or climbs out of the folder**: never written.
4. **An old agent (no Willow) serves the drive**: browsers keep saving files themselves.
5. **A markdown file with syntax the editor does not model**: materialisation must not
   silently drop content the user never touched in the editor.

---

### Task 1: Materialise — Yjs ⇄ file text (pure, shared)

**Files:**
- Create: `web/shared/willow/materialize.ts`
- Test: `web/lib/__tests__/willow-materialize.test.ts`

**Interfaces:**
- Produces: `kindFor(path: string): "markdown" | "text"`, `docToFile(doc: Y.Doc, kind): string`,
  `fileToUpdate(doc: Y.Doc, kind, text: string): Uint8Array | null` (the Yjs update that turns
  `doc`'s content into `text`, minimal for plain text: common prefix/suffix; for markdown:
  replace the fragment only when the rendered markdown differs; null when nothing changes).

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/__tests__/willow-materialize.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { kindFor, docToFile, fileToUpdate } from "@/shared/willow/materialize";

describe("materialize", () => {
  it("picks markdown for .md", () => {
    expect(kindFor("a/b.md")).toBe("markdown");
    expect(kindFor("x.ts")).toBe("text");
  });

  it("plain text round trip, and a disk edit is a minimal update that keeps concurrent typing", () => {
    const a = new Y.Doc(); a.getText("content").insert(0, "hello world");
    expect(docToFile(a, "text")).toBe("hello world");
    const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText("content").insert(11, "!"); // someone typing in a browser
    const u = fileToUpdate(a, "text", "hello brave world")!; // the disk edit
    Y.applyUpdate(b, u); Y.applyUpdate(a, u);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(a.getText("content").toString()).toBe("hello brave world!");
    expect(fileToUpdate(a, "text", "hello brave world!")).toBeNull();
  });

  it("markdown round trip through the editor's schema", () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, fileToUpdate(d, "markdown", "# Notes\n\nstart **bold**\n")!);
    expect(docToFile(d, "markdown")).toBe("# Notes\n\nstart **bold**");
    expect(fileToUpdate(d, "markdown", "# Notes\n\nstart **bold**\n")).toBeNull(); // same rendering: no update
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npx vitest run lib/__tests__/willow-materialize.test.ts`
Expected: FAIL: `Cannot find module '@/shared/willow/materialize'`.

- [ ] **Step 3: Write `materialize.ts`**

```ts
// web/shared/willow/materialize.ts
// A collaborative document ⇄ the file on disk (spec D8). Plain text lives in
// Y.Text("content") (Monaco); markdown in XmlFragment("prosemirror") (Tiptap),
// rendered with the editor's own schema and serializer, headless.
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { yXmlFragmentToProseMirrorRootNode, prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";

export type Kind = "markdown" | "text";
export const kindFor = (path: string): Kind => (/\.(md|markdown)$/i.test(path) ? "markdown" : "text");

// the same extensions as components/editors/rich-text-editor.tsx (minus the collaboration ones)
const extensions = [StarterKit.configure({ undoRedo: false }), Markdown];
let cached: { schema: ReturnType<typeof getSchema>; mm: MarkdownManager } | null = null;
const md = () => (cached ??= { schema: getSchema(extensions), mm: new MarkdownManager({ extensions } as never) });

export function docToFile(doc: Y.Doc, kind: Kind): string {
  if (kind === "text") return doc.getText("content").toString();
  const { schema, mm } = md();
  return mm.serialize(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("prosemirror"), schema).toJSON());
}

export function fileToUpdate(doc: Y.Doc, kind: Kind, text: string): Uint8Array | null {
  const before = Y.encodeStateVector(doc);
  if (kind === "text") {
    const t = doc.getText("content");
    const cur = t.toString();
    if (cur === text) return null;
    let p = 0;
    while (p < cur.length && p < text.length && cur[p] === text[p]) p++;
    let s = 0;
    while (s < cur.length - p && s < text.length - p && cur[cur.length - 1 - s] === text[text.length - 1 - s]) s++;
    doc.transact(() => {
      t.delete(p, cur.length - p - s);
      t.insert(p, text.slice(p, text.length - s));
    });
  } else {
    const { schema, mm } = md();
    if (docToFile(doc, "markdown").trimEnd() === mm.serialize(mm.parse(text)).trimEnd()) return null;
    const frag = doc.getXmlFragment("prosemirror");
    doc.transact(() => {
      frag.delete(0, frag.length);
      prosemirrorJSONToYXmlFragment(schema, mm.parse(text), frag);
    });
  }
  return Y.encodeStateAsUpdate(doc, before);
}
```

- [ ] **Step 4: Run it until it passes**, then **Step 5: Commit**
  (`git add web/shared/willow/materialize.ts web/lib/__tests__/willow-materialize.test.ts && git commit -m "feat(willow): materialize — Yjs ⇄ file text, headless"`).

---

### Task 2: Generated copy of the shared Willow code for the CLI

**Files:**
- Create: `web/scripts/mirror-willow-to-cli.mjs`, `cli/src/willow-shared/*.js` (generated), `web/lib/__tests__/willow-mirror.test.ts`
- Modify: `cli/package.json` (devDependencies: `@noble/ed25519`, `@noble/hashes`, `@jsr/earthstar__willow-utils`, `yjs`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/markdown`, `@tiptap/y-tiptap`, versions as in `web/package.json`)

**Interfaces:**
- Produces: `cli/src/willow-shared/{bytes,keys,schemes,cert,policy,doc,wire,session,y-binding,materialize}.js`,
  `cli/src/willow-shared/chunks.js` (from `web/shared/media/chunks.ts`), each starting with
  `// GENERATED from web/shared/… by web/scripts/mirror-willow-to-cli.mjs — do not edit.`

- [ ] **Step 1: Write the failing drift test**

```ts
// web/lib/__tests__/willow-mirror.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mirror } from "../../scripts/mirror-willow-to-cli.mjs";

describe("cli's generated copy of web/shared/willow", () => {
  it("matches what the generator produces now (run: node web/scripts/mirror-willow-to-cli.mjs)", async () => {
    const out = await mirror({ write: false });
    for (const [file, text] of Object.entries(out)) expect(readFileSync(join(__dirname, "../../..", file), "utf8"), file).toBe(text);
  });
});
```

- [ ] **Step 2: Run it to see it fail** (`Cannot find module '../../scripts/mirror-willow-to-cli.mjs'`).

- [ ] **Step 3: Write the generator**

```js
// web/scripts/mirror-willow-to-cli.mjs
// cli/ is an independent package (CLAUDE.md): it may not import web/. The Willow
// code must still be the same bytes on both sides, so this compiles each shared
// TypeScript module to plain JS (no bundling: imports stay imports, "./x" → "./x.js")
// into cli/src/willow-shared/. A web test fails when the copy drifts.
import { transform } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCES = [
  ...["bytes", "keys", "schemes", "cert", "policy", "doc", "wire", "session", "y-binding", "materialize"].map((n) => [`web/shared/willow/${n}.ts`, `${n}.js`]),
  ["web/shared/media/chunks.ts", "chunks.js"],
];

export async function mirror({ write = true } = {}) {
  const out = {};
  for (const [src, name] of SOURCES) {
    const ts = readFileSync(join(repo, src), "utf8");
    const { code } = await transform(ts, { loader: "ts", format: "esm", target: "node20" });
    const js = code
      .replace(/from "\.\/([\w-]+)"/g, 'from "./$1.js"')
      .replace(/from "\.\.\/willow\/([\w-]+)"/g, 'from "./$1.js"');
    const file = `cli/src/willow-shared/${name}`;
    out[file] = `// GENERATED from ${src} by web/scripts/mirror-willow-to-cli.mjs — do not edit.\n${js}`;
  }
  if (write) {
    mkdirSync(join(repo, "cli/src/willow-shared"), { recursive: true });
    for (const [file, text] of Object.entries(out)) writeFileSync(join(repo, file), text);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) await mirror();
```

- [ ] **Step 4:** `node web/scripts/mirror-willow-to-cli.mjs`, add the CLI devDependencies
  (`cd cli && npm install -D …`), run the drift test (PASS) and a smoke import in the CLI:
  `cd cli && node -e 'import("./src/willow-shared/session.js").then((m) => console.log(typeof m.SyncSession))'` → `function`.

- [ ] **Step 5: Commit** (generator, generated files, test, `cli/package.json` + lock).

---

### Task 3: The agent authenticates to Willow sync and gets its certificate

**Files:**
- Modify: `web/lib/willow/peer.ts` (`onWillowSync` accepts an agent), `web/server.js` (pass the `Authorization` header), `web/app/api/willow/cert/route.ts` (agent bearer)
- Create: `web/lib/willow/agent-auth.ts`
- Test: `web/lib/__tests__/willow-agent-auth.test.ts`

**Interfaces:**
- Produces: `agentUser(driveId: string, authorization: string | undefined): Promise<string | null>` — the drive owner's id when `Authorization: Bearer <agentToken>` matches the drive's `agent_token_hash` (bcrypt, the same check as `onAgentConnect`), else null. `onWillowSync(ws, req, query, userId)` is called with `userId = cookieUser ?? await agentUser(drive, auth)`. `POST /api/willow/cert` accepts the same bearer (label "agent on <hostname>").

- [ ] **Step 1:** test: a drive row with a known agent token hash → `agentUser(drive, "Bearer <token>")` is the owner; wrong token → null; missing header → null.
- [ ] **Step 2:** run, see it fail.
- [ ] **Step 3:** implement `agent-auth.ts` (reuse the query and `bcrypt.compare` from `web/lib/agents.js:onAgentConnect`), wire `server.js` and the cert route (`getUser()` first, else `agentUser`).
- [ ] **Step 4:** tests pass; rebuild the peer bundle; smoke: a WS with the right bearer is not closed with 4401.
- [ ] **Step 5:** commit.

---

### Task 4: The agent peer — store, key, certificate, sync session

**Files:**
- Create: `cli/src/willow-peer.js`, `cli/src/willow-payload-fs.js` (generated? no: a small hand-written copy of `web/lib/willow/payload-driver-fs.ts` in JS, marked `// Mirrors web/lib/willow/payload-driver-fs.ts`)
- Modify: `cli/src/agent.js` (start the peer after the RPC socket connects; stop `attachSync`)
- Test: `cli/test/willow-peer.test.mjs`

**Interfaces:**
- Produces: `startWillowPeer({ root, drive, server, log }): { store, key, stop() }` — device key at `<root>/.aindrive/device.key` (0600), store in `<root>/.aindrive/willow.sqlite` + `willow-payloads/`, certificate from `POST /api/willow/cert` with the agent bearer (written once as `_id/cert`), a `SyncSession` over `wss://…/api/willow/sync?drive=` with the bearer, reconnect with backoff.

- [ ] **Step 1:** test with an in-process fake server channel: `startWillowPeer` with an injected `connect()` returns a store; an entry appended on the fake server side arrives; the device key file is created 0600 and reused on restart.
- [ ] **Step 2:** fail. **Step 3:** implement (`KvDriverSqlite` from `cli/src/willow/kv-driver-sqlite.js`, schemes from `willow-shared/schemes.js`, `SyncSession` from `willow-shared/session.js`). **Step 4:** pass. **Step 5:** commit.

---

### Task 5: Materialise to disk

**Files:**
- Create: `cli/src/willow-materializer.js`
- Test: `cli/test/willow-materializer.test.mjs`

**Interfaces:**
- Consumes: `startWillowPeer` (Task 4), `loadDoc` / `readUpdates` (generated doc.js), `kindFor` / `docToFile` (generated materialize.js), `safeResolve` + self-write marking from `cli/src/rpc.js`
- Produces: `startMaterializer({ root, store, log }): { stop(), flush(): Promise<void> }` — on every `entrypayloadset` / `payloadingest` for a `doc/…/~u/…` path: canonical-path check (refuse `..`, non-canonical, `.aindrive/`), debounce 2 s per doc, `docToFile`, write only if different from the file, mark as self-write.

- [ ] Steps as usual; tests: a remote update makes the file change within 2.5 s; an identical render does not touch mtime; `doc/../x/~u/1` and `doc/.aindrive/x/~u/1` are never written.

---

### Task 6: Disk edits become signed updates; startup reconcile; migration

**Files:**
- Modify: `cli/src/agent.js` (the fs watcher calls the reconciler for known docs), `cli/src/willow-materializer.js`
- Create: `cli/src/willow-import.js`
- Test: `cli/test/willow-disk-edit.test.mjs`

**Interfaces:**
- Produces: `reconcileFile(root, store, key, relPath): Promise<"none" | "updated">` — loads the doc, `fileToUpdate(doc, kind, fileText)`, appends it signed by the agent (seq `disk-<µs>`); runs from the watcher (not for self-writes) and once per known doc at startup (Review Focus 1). `importLegacy(root, store, key)` — once (marker `.aindrive/willow-imported`): every `yjs_entries` document becomes one update authored by the agent.

- [ ] Steps as usual; tests: editing the file adds exactly one entry whose text matches; a browser update concurrent with a disk edit keeps both (Review Focus 2); a legacy `yjs_entries` doc imports once; a markdown file with an HTML block survives an untouched round trip (Review Focus 5 — if the serializer would drop it, `reconcileFile` must not replace the fragment: compare `mm.serialize(mm.parse(text))` with `text` and, when lossy, keep the file as the truth and skip).

---

### Task 7: Browsers stop writing files when the agent materialises

**Files:**
- Modify: `cli/src/agent.js` (`agent-hello` gains `capabilities: ["willow"]`), `web/lib/agents.js` (remember capabilities per drive), `web/app/api/drives/[driveId]/route.ts` (expose `willowAgent: boolean`), `web/components/viewer.tsx`, `web/components/editors/rich-text-editor.tsx` (autosave only when `!willowAgent`), `web/e2e/willow-offline.spec.ts` (the file on disk ends up with the offline edit, written by the agent)

- [ ] Steps as usual: unit test for the capability flag in `agents.js`; E2E asserts `a.md` on disk contains `offline-edit-1` within 10 s of reconnect while no browser posted `fs/write` (count requests with `page.on("request")`).
