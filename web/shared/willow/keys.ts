// web/shared/willow/keys.ts
// A device's signing key (spec D2): Ed25519, the device's Willow subspace id.
// The browser keeps it non-extractable (Plan 2); this module only does the math.
import * as ed from "@noble/ed25519";

export type DeviceKeypair = { publicKey: Uint8Array; secretKey: Uint8Array };

export async function generateDeviceKey(): Promise<DeviceKeypair> {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { secretKey, publicKey };
}

export const sign = (kp: DeviceKeypair, msg: Uint8Array): Promise<Uint8Array> => ed.signAsync(msg, kp.secretKey);

export async function verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try { return await ed.verifyAsync(sig, msg, pub); } catch { return false; }
}
