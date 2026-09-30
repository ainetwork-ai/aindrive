// Plan task 06.5, bytes half (names and the shared lists: visibility-rule.test.ts):
// preview (fs/read), thumbnail, stream and download follow the same rule as the
// listing. For every file of the fixture drive and every caller, "open" is
// derived from fs/list; each byte route must serve exactly the open files and
// refuse the rest before the agent is asked for a single byte, with a refusal
// that names nothing beyond the path the caller typed.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-visibility-bytes-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";

vi.mock("next/headers", async () => (await import("./visibility-fixture")).nextHeadersMock());
vi.mock("../rpc", async () => (await import("./visibility-fixture")).rpcMock());
const { FILES, ALL_FILES, IMAGES, agentCalls, seed, ctx, get, signInAs, listingView: walkListing } = await import("./visibility-fixture");

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const listRoute = await import("../../app/api/drives/[driveId]/fs/list/route.js");
const readRoute = await import("../../app/api/drives/[driveId]/fs/read/route.js");
const thumbRoute = await import("../../app/api/drives/[driveId]/fs/thumbnail/route.js");
const streamRoute = await import("../../app/api/drives/[driveId]/fs/stream/route.js");
const downloadRoute = await import("../../app/api/drives/[driveId]/fs/download/route.js");

beforeAll(() => { seed(db); });
beforeEach(() => { agentCalls.length = 0; });
const as = (userId: string | null) => signInAs(sign, userId);
const listingView = () => walkListing(listRoute);

describe("06.5: one rule for bytes — preview, thumbnail, stream, download follow the listing", () => {
  for (const who of ["vic", "ed", "bob", null] as const) {
    it(`${who ?? "anonymous"}: a file is readable on every byte route iff the listing shows it open`, async () => {
      await as(who);
      const view = who && who !== "bob" ? await listingView() : new Map();
      const openFiles = new Set(ALL_FILES.filter((p) => view.has(p) && !view.get(p)!.locked));
      // Everything under a locked folder is closed too (the walk never listed it).
      for (const p of ALL_FILES) {
        agentCalls.length = 0;
        const expectOpen = openFiles.has(p);
        const routes: [string, () => Promise<Response>][] = [
          ["read", () => readRoute.GET(get("read", p), ctx)],
          ["stream", () => streamRoute.GET(get("stream", p), ctx)],
          ["download", () => downloadRoute.GET(get("download", p), ctx)],
        ];
        if (IMAGES.includes(p)) routes.push(["thumbnail", () => thumbRoute.GET(get("thumbnail", p), ctx)]);
        for (const [name, call] of routes) {
          const res = await call();
          if (expectOpen) {
            expect([name, p, res.status]).toEqual([name, p, 200]);
            const bytes = Buffer.from(await res.arrayBuffer()).toString();
            if (name !== "thumbnail") expect(bytes).toContain(FILES[p]);
          } else {
            expect([name, p, res.status >= 400]).toEqual([name, p, true]);
            // A refusal names nothing beyond the path the caller typed: a paywall
            // body (R-VIS-PAID-002) carries the gate at that path or an ancestor
            // of it, never another hidden name, never content.
            const text = await res.text();
            for (const other of ["hidden/y.png", "hidden2.png", ".aindrive/config.json", "listed/x.png"]) {
              if (other !== p && !p.startsWith(other.split("/")[0])) expect(text).not.toContain(other.split("/")[0] === "hidden" ? "y.png" : other);
            }
            expect(text).not.toContain(FILES[p]);
          }
        }
        if (!expectOpen) {
          // No byte-producing RPC ran for a closed file.
          expect(agentCalls.filter((c) => c.path === p && ["read", "thumbnail", "download-chunk", "stat"].includes(c.method))).toEqual([]);
        }
      }
    });
  }
});

