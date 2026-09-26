import { describe, expect, it } from "vitest";
import { mentionFolders, mentionTokenAt, parseMentions } from "../mention";

const drives = [
  { id: "d1", name: "folder name", hostname: "S21", online: true },
  { id: "d2", name: "Photos", hostname: "Galaxy S21+ 5G", online: true },
  { id: "d3", name: "Photos", hostname: "Galaxy S21+ 5G", online: false },
  { id: "d4", name: "Theirs", hostname: "mac.local", online: true, owned: false },
];
const agents = [{ name: "aindrive-cloud" }, { name: "Notes agent" }];

describe("@folder mentions in Folder Chat", () => {
  const folders = mentionFolders(drives);
  it("names each owned drive <name>-in-<device>, numbering repeats", () => {
    expect(folders.map((f) => f.handle)).toEqual(["folder-name-in-S21", "Photos-in-Galaxy-S21+-5G", "Photos-in-Galaxy-S21+-5G-2"]);
  });
  it("reads an agent and folders from the start of the message", () => {
    const r = parseMentions("@aindrive-cloud @folder-name-in-s21 what is inside this folder?", agents, folders)!;
    expect(r.agent?.name).toBe("aindrive-cloud");
    expect(r.folders.map((f) => f.drive.id)).toEqual(["d1"]);
    expect(r.text).toBe("what is inside this folder?");
  });
  it("takes folders alone, and stops at the first unknown word", () => {
    const r = parseMentions("@Photos-in-Galaxy-S21+-5G, @nobody hi", agents, folders)!;
    expect(r.agent).toBeUndefined();
    expect(r.folders.map((f) => f.drive.id)).toEqual(["d2"]);
    expect(r.text).toBe("@nobody hi");
  });
  it("matches an agent by prefix and ignores plain text", () => {
    expect(parseMentions("@notes hi", agents, folders)?.agent?.name).toBe("Notes agent");
    expect(parseMentions("hello @aindrive-cloud", agents, folders)).toBeNull();
  });
  it("finds the @word under the caret", () => {
    expect(mentionTokenAt("ask @pho", 8)).toEqual({ start: 4, text: "pho" });
    expect(mentionTokenAt("a@b", 3)).toBeNull();
  });
});
