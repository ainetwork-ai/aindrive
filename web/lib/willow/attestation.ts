// web/lib/willow/attestation.ts
// aindrive's attestation key (spec §4): signs certificates for devices of people
// signed in with email/Google ("vouched by aindrive"). Used for nothing else.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { verifyMessage } from "viem";
import { fromHex, toHex } from "@/shared/willow/bytes";
import { issueAttestedCert, type Cert, type Trust } from "@/shared/willow/cert";
import { nowMicros } from "@/shared/willow/schemes";
import type { DeviceKeypair } from "@/shared/willow/keys";
import { dataDir } from "@/lib/env";

ed.hashes.sha512 = sha512;

let cached: DeviceKeypair | null = null;

export function attestationKey(): DeviceKeypair {
  if (cached) return cached;
  const fromEnv = process.env.AINDRIVE_ATTESTATION_KEY?.trim();
  let secret: Uint8Array;
  if (fromEnv) secret = fromHex(fromEnv);
  else {
    const file = join(dataDir(), "attestation.key");
    if (existsSync(file)) secret = fromHex(readFileSync(file, "utf8").trim());
    else { secret = ed.utils.randomSecretKey(); writeFileSync(file, toHex(secret)); chmodSync(file, 0o600); }
  }
  if (secret.length !== 32) throw new Error("attestation key must be 32 bytes");
  cached = { secretKey: secret, publicKey: ed.getPublicKey(secret) };
  return cached;
}

export function trust(): Trust {
  return {
    attestationKeys: [toHex(attestationKey().publicKey)],
    verifyWallet: async (message, signature) => {
      const m = /^(0x[0-9a-fA-F]{40})$/m.exec(message);
      if (!m) return null;
      const ok = await verifyMessage({ address: m[1] as `0x${string}`, message, signature: signature as `0x${string}` }).catch(() => false);
      return ok ? m[1].toLowerCase() : null;
    },
  };
}

export async function certify(userId: string, deviceKeyHex: string, label: string): Promise<Cert> {
  const key = fromHex(deviceKeyHex);
  if (key.length !== 32) throw new Error("device key must be 32 bytes");
  return issueAttestedCert(attestationKey(), key, userId, label.slice(0, 80), nowMicros());
}
