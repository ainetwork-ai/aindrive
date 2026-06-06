// Unit tests for handleRpc dispatch: write, rename, delete, and the
// rename-root / delete-root guard paths (rpc.js:173, rpc.js:181).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { handleRpc } from "../rpc.js";

let tmp;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "rpc-dispatch-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("handleRpc — unknown method", () => {
  it("throws for an unknown method", async () => {
    await expect(handleRpc({ method: "explode" }, tmp)).rejects.toThrow("unknown method");
  });

  it("throws when params is null", async () => {
    await expect(handleRpc(null, tmp)).rejects.toThrow("unknown method");
  });
});

describe("handleRpc — write", () => {
  it("writes a UTF-8 file and returns ok + bytes", async () => {
    const res = await handleRpc({ method: "write", path: "hello.txt", content: "world" }, tmp);
    expect(res).toMatchObject({ method: "write", ok: true, bytes: 5 });
    expect(readFileSync(path.join(tmp, "hello.txt"), "utf8")).toBe("world");
  });

  it("creates intermediate directories", async () => {
    const res = await handleRpc(
      { method: "write", path: "a/b/c.txt", content: "nested" },
      tmp
    );
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(tmp, "a/b/c.txt"))).toBe(true);
  });

  it("writes base64-encoded content", async () => {
    const data = Buffer.from("binary\x00data").toString("base64");
    const res = await handleRpc(
      { method: "write", path: "bin.bin", content: data, encoding: "base64" },
      tmp
    );
    expect(res.ok).toBe(true);
    expect(res.bytes).toBe(11);
  });

  it("rejects a traversal path", async () => {
    await expect(
      handleRpc({ method: "write", path: "../escape.txt", content: "x" }, tmp)
    ).rejects.toThrow("path escapes drive root");
  });
});

describe("handleRpc — rename", () => {
  it("renames a file", async () => {
    await handleRpc({ method: "write", path: "old.txt", content: "data" }, tmp);
    const res = await handleRpc({ method: "rename", from: "old.txt", to: "new.txt" }, tmp);
    expect(res).toMatchObject({ method: "rename", ok: true });
    expect(existsSync(path.join(tmp, "new.txt"))).toBe(true);
    expect(existsSync(path.join(tmp, "old.txt"))).toBe(false);
  });

  it("throws when renaming the drive root (from = root)", async () => {
    // params.from resolves to root itself — rpc.js:173
    await expect(
      handleRpc({ method: "rename", from: "", to: "something" }, tmp)
    ).rejects.toThrow("cannot rename root");
  });

  it("rejects traversal in the 'from' path", async () => {
    await expect(
      handleRpc({ method: "rename", from: "../outside", to: "inside" }, tmp)
    ).rejects.toThrow("path escapes drive root");
  });
});

describe("handleRpc — delete", () => {
  it("deletes a file", async () => {
    await handleRpc({ method: "write", path: "todelete.txt", content: "bye" }, tmp);
    const res = await handleRpc({ method: "delete", path: "todelete.txt" }, tmp);
    expect(res).toMatchObject({ method: "delete", ok: true });
    expect(existsSync(path.join(tmp, "todelete.txt"))).toBe(false);
  });

  it("deletes a directory recursively", async () => {
    await handleRpc({ method: "mkdir", path: "mydir" }, tmp);
    await handleRpc({ method: "write", path: "mydir/file.txt", content: "x" }, tmp);
    await handleRpc({ method: "delete", path: "mydir" }, tmp);
    expect(existsSync(path.join(tmp, "mydir"))).toBe(false);
  });

  it("throws when deleting the drive root (path = root) — rpc.js:181", async () => {
    await expect(
      handleRpc({ method: "delete", path: "" }, tmp)
    ).rejects.toThrow("cannot delete root");
  });

  it("rejects traversal in the delete path", async () => {
    await expect(
      handleRpc({ method: "delete", path: "../sibling" }, tmp)
    ).rejects.toThrow("path escapes drive root");
  });
});
