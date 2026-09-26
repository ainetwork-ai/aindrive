import { describe, it, expect } from "vitest";
import { bestMatchingRole, computeEntry, normalizePath, type Role } from "../access-core.js";
import { resolveDriveLocation, locationPath, viewerHistory, type PathKind } from "../drive-location";

// A member's rows → the inputs the drive page hands the resolver (real access-core, no mocks).
function member(grants: Record<string, Role>, opts: { owner?: boolean } = {}) {
  const rows = Object.entries(grants).map(([p, role]) => ({ path: normalizePath(p), role }));
  const isOwner = !!opts.owner;
  return {
    entry: computeEntry(rows, isOwner),
    roleAt: (p: string) => (isOwner ? "owner" as const : bestMatchingRole(rows, normalizePath(p))),
  };
}
const resolve = (
  m: ReturnType<typeof member>,
  requested: string | null,
  requestedKind: PathKind = "unknown",
  entryKind: PathKind = "unknown",
) => resolveDriveLocation({ requested, requestedKind, entry: m.entry, entryKind, roleAt: m.roleAt });

const VIDEO = "특별영상/할머니께_제주영상.mp4";

describe("resolveDriveLocation — a file in ?path opens the viewer instead of listing it as a folder", () => {
  it("owner deep-links a file → its parent folder is listed and the file opens", () => {
    expect(resolve(member({}, { owner: true }), VIDEO, "file")).toEqual({
      kind: "view", folder: "특별영상", open: VIDEO, scopeRoot: "", grantListing: false,
    });
  });

  it("member who bought one file inside an unshared folder → their grant listing, file open", () => {
    const grandma = member({ "사진/제주": "viewer", "앨범": "viewer", "특별영상/미리보기.jpg": "viewer", [VIDEO]: "viewer" });
    expect(resolve(grandma, VIDEO, "file")).toEqual({
      kind: "view", folder: "", open: VIDEO, scopeRoot: "", grantListing: true,
    });
  });

  it("member whose only grant is one file, no ?path → grant listing with that file open", () => {
    const report = "체험학습_보고서.pdf";
    expect(resolve(member({ [report]: "viewer" }), null, "unknown", "file")).toEqual({
      kind: "view", folder: "", open: report, scopeRoot: "", grantListing: true,
    });
  });

  it("file inside a folder the member can list → that folder, file open", () => {
    expect(resolve(member({ docs: "viewer" }), "docs/a.pdf", "file", "dir")).toEqual({
      kind: "view", folder: "docs", open: "docs/a.pdf", scopeRoot: "docs", grantListing: false,
    });
  });
});

describe("resolveDriveLocation — the breadcrumb root is what the user may reach, not where they landed", () => {
  it("owner deep-links a folder → breadcrumb still starts at the drive root", () => {
    expect(resolve(member({}, { owner: true }), "특별영상", "dir")).toEqual({
      kind: "view", folder: "특별영상", open: null, scopeRoot: "", grantListing: false,
    });
  });

  it("single-folder member deep-links below their grant → breadcrumb starts at the grant", () => {
    expect(resolve(member({ docs: "viewer" }), "docs/specs", "dir", "dir")).toEqual({
      kind: "view", folder: "docs/specs", open: null, scopeRoot: "docs", grantListing: false,
    });
  });

  it("multi-grant member opens a granted folder → the drive root stays their grant listing", () => {
    const m = member({ docs: "viewer", photos: "viewer" });
    expect(resolve(m, "photos", "dir")).toEqual({
      kind: "view", folder: "photos", open: null, scopeRoot: "", grantListing: true,
    });
  });
});

describe("resolveDriveLocation — landing without ?path (drive-access entry rules)", () => {
  it("owner → drive root", () => {
    expect(resolve(member({}, { owner: true }), null)).toEqual({
      kind: "view", folder: "", open: null, scopeRoot: "", grantListing: false,
    });
  });

  it("single folder grant → lands in that folder", () => {
    expect(resolve(member({ docs: "viewer" }), null, "unknown", "dir")).toEqual({
      kind: "view", folder: "docs", open: null, scopeRoot: "docs", grantListing: false,
    });
  });

  it("several grants → grant listing", () => {
    expect(resolve(member({ docs: "viewer", photos: "viewer" }), null)).toEqual({
      kind: "view", folder: "", open: null, scopeRoot: "", grantListing: true,
    });
  });

  it("no membership → the drive is denied", () => {
    expect(resolve(member({}), null)).toEqual({ kind: "deny", reason: "drive" });
  });
});

describe("resolveDriveLocation — access and an unreachable agent", () => {
  it("an explicit ?path the user can't read is a hard deny, whatever it is (no path oracle)", () => {
    const m = member({ docs: "viewer" });
    expect(resolve(m, "secret", "dir", "dir")).toEqual({ kind: "deny", reason: "path" });
    expect(resolve(m, "secret/x.pdf", "file", "dir")).toEqual({ kind: "deny", reason: "path" });
  });

  it("?path whose kind is unknown (agent offline) is treated as a folder", () => {
    expect(resolve(member({ docs: "viewer" }), "docs/specs", "unknown", "unknown")).toEqual({
      kind: "view", folder: "docs/specs", open: null, scopeRoot: "docs", grantListing: false,
    });
  });

  it("single grant of unknown kind (agent offline) → lands in it as a folder", () => {
    expect(resolve(member({ docs: "viewer" }), null)).toEqual({
      kind: "view", folder: "docs", open: null, scopeRoot: "docs", grantListing: false,
    });
  });
});

describe("locationPath — the ?path value for what the user is looking at", () => {
  it("an open file wins over the listed folder", () => {
    expect(locationPath("특별영상", VIDEO)).toBe(VIDEO);
  });
  it("no open file → the folder", () => {
    expect(locationPath("docs/specs", null)).toBe("docs/specs");
  });
  it("drive root with nothing open → no ?path at all", () => {
    expect(locationPath("", null)).toBeNull();
  });
});

describe("viewerHistory — one Back always closes the viewer", () => {
  it("opening a file from a folder pushes an entry", () => {
    expect(viewerHistory({ openPushed: false, opening: true, urlChanged: true })).toEqual({ action: "push", openPushed: true });
  });
  it("closing a file opened here steps back over its entry", () => {
    expect(viewerHistory({ openPushed: true, opening: false, urlChanged: true })).toEqual({ action: "back", openPushed: false });
  });
  it("switching to another file while one is open replaces the entry", () => {
    expect(viewerHistory({ openPushed: true, opening: true, urlChanged: true })).toEqual({ action: "replace", openPushed: true });
  });
  it("clicking the row that is already open records nothing and keeps the entry closable", () => {
    expect(viewerHistory({ openPushed: true, opening: true, urlChanged: false })).toEqual({ action: "none", openPushed: true });
  });
  it("closing a file that arrived in the URL pushes the folder", () => {
    expect(viewerHistory({ openPushed: false, opening: false, urlChanged: true })).toEqual({ action: "push", openPushed: false });
  });
  it("a locked row (kept out of the URL) records nothing", () => {
    expect(viewerHistory({ openPushed: false, opening: true, urlChanged: false })).toEqual({ action: "none", openPushed: false });
  });
});
