// web/lib/__tests__/willow-store-node.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { generateDeviceKey } from "@/shared/willow/keys";
import { appendUpdate, loadDoc } from "@/shared/willow/doc";
import { openDriveStore, closeDriveStores } from "@/lib/willow/store-node";

describe("server drive store", () => {
  it("keeps entries and payloads across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "willow-store-"));
    const kp = await generateDeviceKey();
    const d = new Y.Doc(); d.getText("content").insert(0, "persisted");
    await appendUpdate(openDriveStore("drive-1", dir), kp, ["a.md"], Y.encodeStateAsUpdate(d), 1);
    closeDriveStores();
    expect((await loadDoc(openDriveStore("drive-1", dir), ["a.md"])).getText("content").toString()).toBe("persisted");
    closeDriveStores();
  });
});
