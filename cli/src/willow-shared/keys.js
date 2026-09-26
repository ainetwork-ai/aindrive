// GENERATED from web/shared/willow/keys.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import * as ed from "@noble/ed25519";
async function generateDeviceKey() {
  const { secretKey, publicKey } = await ed.keygenAsync();
  return { secretKey, publicKey };
}
const sign = (kp, msg) => ed.signAsync(msg, kp.secretKey);
async function verify(pub, msg, sig) {
  try {
    return await ed.verifyAsync(sig, msg, pub);
  } catch {
    return false;
  }
}
export {
  generateDeviceKey,
  sign,
  verify
};
