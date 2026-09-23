import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decryptOoxml, isEncryptedOoxml, OfficePasswordError } from "./office-crypto";

// Fixtures (lib/__fixtures__/office/): tiny.docx / tiny.xlsx are the
// plaintext packages; agile.* were encrypted with msoffcrypto-tool's
// ECMA376Agile (SHA-512 / AES-256, 100k spins); standard.docx (AES-128) and
// standard256.xlsx (AES-256) with an ECMA-376 Standard encryptor whose output
// msoffcrypto-tool decrypts back to the same bytes. Password: Passw0rd.
const fx = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "__fixtures__/office", name)));
const PASSWORD = "Passw0rd";

describe("office-crypto", () => {
  it("detects encrypted OOXML but not plain zips", () => {
    expect(isEncryptedOoxml(fx("agile.docx"))).toBe(true);
    expect(isEncryptedOoxml(fx("standard.docx"))).toBe(true);
    expect(isEncryptedOoxml(fx("tiny.docx"))).toBe(false);
    expect(isEncryptedOoxml(new Uint8Array(10))).toBe(false);
  });

  it.each([
    ["agile.docx", "tiny.docx"],
    ["agile.xlsx", "tiny.xlsx"],
    ["standard.docx", "tiny.docx"],
    ["standard256.xlsx", "tiny.xlsx"],
  ])("decrypts %s to the original package", async (enc, plain) => {
    const out = await decryptOoxml(fx(enc), PASSWORD);
    expect(Array.from(out.subarray(0, 2))).toEqual([0x50, 0x4b]); // "PK"
    expect(Buffer.from(out).equals(Buffer.from(fx(plain)))).toBe(true);
  });

  it.each(["agile.xlsx", "standard.docx"])("rejects a wrong password for %s", async (enc) => {
    await expect(decryptOoxml(fx(enc), "wrong")).rejects.toBeInstanceOf(OfficePasswordError);
  });
});
