// A wallet sign-in also certifies the browser's device key (plan 4): the key rides
// in the SIWE message's resources, so the signature the person already makes vouches
// for the device. The certificate carries that message + signature, and a link
// (wallet address ↔ account) signed by aindrive's attestation key.
import { issueWalletCert, signLink, type Cert } from "@/shared/willow/cert";
import { fromHex } from "@/shared/willow/bytes";
import { nowMicros } from "@/shared/willow/schemes";
import { attestationKey } from "./attestation";

export async function walletCertFromLogin(o: { message: string; signature: string; address: string; userId: string; label: string }): Promise<Cert | null> {
  const m = /^\s*-\s*urn:aindrive:device:ed25519:([0-9a-f]{64})\s*$/m.exec(o.message);
  if (!m) return null;
  const link = await signLink(attestationKey(), o.address, o.userId);
  return issueWalletCert({ deviceKey: fromHex(m[1]), userId: o.userId, label: o.label.slice(0, 80), at: nowMicros(), address: o.address, message: o.message, signature: o.signature, link });
}
