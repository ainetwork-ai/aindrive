import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-wallet-cert-"));
const { walletCertFromLogin } = await import("../willow/wallet-cert");
const { trust } = await import("../willow/attestation");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { resolvePerson, walletCertMessageLine } = await import("@/shared/willow/cert");
const { toHex } = await import("@/shared/willow/bytes");

const siwe = (address: string, resource?: string) => [
  "aindrive.example wants you to sign in with your Ethereum account:", address, "", "aindrive wants you to sign in with your wallet.", "",
  "URI: https://aindrive.example", "Version: 1", "Chain ID: 8453", "Nonce: abcdefgh12", "Issued At: 2026-09-26T00:00:00.000Z",
  ...(resource ? ["Resources:", `- ${resource}`] : []),
].join("\n");

describe("a wallet sign-in certifies the browser's device key", () => {
  it("issues a wallet-strength cert for the key in the SIWE resources", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const device = await generateDeviceKey();
    const message = siwe(wallet.address, walletCertMessageLine(device.publicKey));
    const signature = await wallet.signMessage({ message });
    const cert = await walletCertFromLogin({ message, signature, address: wallet.address, userId: "u-1", label: "Chrome" });
    expect(cert).not.toBeNull();
    expect(await resolvePerson(toHex(device.publicKey), [cert!], [], trust())).toEqual({ userId: "u-1", strength: "wallet" });
  });

  it("no resource line, no cert", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const message = siwe(wallet.address);
    expect(await walletCertFromLogin({ message, signature: await wallet.signMessage({ message }), address: wallet.address, userId: "u-1", label: "x" })).toBeNull();
  });
});

describe("the sign-in message with a device resource still parses", () => {
  it("parseSiweLoginFields reads address, nonce and chain from a message built like the panel's", async () => {
    const { SiweMessage } = await import("siwe");
    const { parseSiweLoginFields } = await import("../siwe-verify");
    const wallet = privateKeyToAccount(generatePrivateKey());
    const device = await generateDeviceKey();
    const message = new SiweMessage({ domain: "aindrive.example", address: wallet.address, statement: "aindrive wants you to sign in with your wallet.", uri: "https://aindrive.example", version: "1", chainId: 8453, nonce: "abcdefgh12", resources: [walletCertMessageLine(device.publicKey)] }).prepareMessage();
    expect(parseSiweLoginFields(message)).toEqual({ address: wallet.address, nonce: "abcdefgh12", chainId: 8453 });
    const cert = await walletCertFromLogin({ message, signature: await wallet.signMessage({ message }), address: wallet.address, userId: "u-2", label: "x" });
    expect(cert?.deviceKey).toBe(toHex(device.publicKey));
  });
});
