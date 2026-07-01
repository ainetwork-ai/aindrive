import { describe, it, expect } from "vitest";
import { signDownloadToken, verifyDownloadToken } from "../download-token";

// The token authorizes exactly the {driveId, path} it was minted for. These
// roundtrip against whatever session secret the process resolves — only
// consistency matters, so no secret is set here.
describe("download-token", () => {
  it("verifies a token for the exact drive+path it was signed for", async () => {
    const t = await signDownloadToken("drive1", "/a/b.png");
    expect(await verifyDownloadToken(t, "drive1", "/a/b.png")).toBe(true);
  });

  it("rejects a token used for a different path", async () => {
    const t = await signDownloadToken("drive1", "/a/b.png");
    expect(await verifyDownloadToken(t, "drive1", "/a/c.png")).toBe(false);
  });

  it("rejects a token used for a different drive", async () => {
    const t = await signDownloadToken("drive1", "/a/b.png");
    expect(await verifyDownloadToken(t, "drive2", "/a/b.png")).toBe(false);
  });

  it("rejects garbage and tampered tokens", async () => {
    expect(await verifyDownloadToken("not-a-jwt", "drive1", "/a/b.png")).toBe(false);
    const t = await signDownloadToken("drive1", "/a/b.png");
    expect(await verifyDownloadToken(t + "x", "drive1", "/a/b.png")).toBe(false);
  });
});
