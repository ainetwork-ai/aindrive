/**
 * Willow / Meadowcap parameter schemes for aindrive.
 *
 * Concrete choices:
 *   - Namespace keypair = Ed25519 (32-byte pubkey, 32-byte secret, 64-byte sig)
 *   - User (subspace) keypair = Ed25519
 *   - Payload digest = SHA-256 (32 bytes)
 *   - Path scheme = up to 16 components, each ≤ 256 bytes, total ≤ 4 KiB
 *   - All namespaces are OWNED (one owner per drive). isCommunal always returns false.
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// Bridge sha512 into noble ed25519 v3 (it requires consumer to provide a hash impl).
ed.hashes.sha512 = sha512;
ed.hashes.sha512Async = async (m) => sha512(m);

const totalOrderBytes = (a, b) => {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
};

// ──────────────── Ed25519 ────────────────

export async function generateEd25519Keypair() {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = ed.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

const ed25519Signatures = {
  async sign(_publicKey, secretKey, bytestring) {
    return ed.sign(bytestring, secretKey);
  },
  async verify(publicKey, signature, bytestring) {
    try { return ed.verify(signature, bytestring, publicKey); }
    catch { return false; }
  },
};

const fixedBytesEncoding = (length) => ({
  encode: (v) => v,
  decode: (v) => v.slice(0, length),
  encodedLength: () => length,
  async decodeStream(bytes) {
    await bytes.nextAbsolute(length);
    const out = bytes.array.slice(0, length);
    bytes.prune(length);
    return out;
  },
});

const ed25519PubkeyEncoding = fixedBytesEncoding(32);
const ed25519SignatureEncoding = fixedBytesEncoding(64);

export const ed25519KeypairScheme = {
  signatures: ed25519Signatures,
  encodings: {
    publicKey: ed25519PubkeyEncoding,
    signature: ed25519SignatureEncoding,
  },
};

// ──────────────── Schemes for Meadowcap ────────────────

export const namespaceKeypairScheme = ed25519KeypairScheme;

export const userScheme = {
  ...ed25519KeypairScheme,
  order: totalOrderBytes,
};

export const payloadScheme = fixedBytesEncoding(32); // SHA-256

export const pathScheme = {
  maxComponentCount: 16,
  maxComponentLength: 256,
  maxPathLength: 4096,
};

// All aindrive drives are OWNED (each drive has a single owner with the namespace keypair).
export const isCommunal = () => false;
