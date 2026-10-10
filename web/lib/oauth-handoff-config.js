import { createPublicKey } from 'node:crypto';

/** Operator-only public keys. Invalid configuration enables no handoff clients. */
export function parseHandoffClients(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    const result = Object.create(null);
    for (const [id, client] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !client || typeof client.issuer !== 'string') return {};
      const issuer = new URL(client.issuer);
      if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) return {};
      if (!Array.isArray(client.keys) || !client.keys.length || client.keys.length > 4) return {};
      const keys = client.keys.map(key => {
        if (!key || key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || Object.hasOwn(key, 'd')) throw new Error('invalid public key');
        const publicKey = { kty: key.kty, crv: key.crv, x: key.x };
        if (createPublicKey({ key: publicKey, format: 'jwk' }).asymmetricKeyType !== 'ed25519') throw new Error('invalid key type');
        return publicKey;
      });
      result[id] = { issuer: client.issuer, keys };
    }
    return result;
  } catch { return {}; }
}
