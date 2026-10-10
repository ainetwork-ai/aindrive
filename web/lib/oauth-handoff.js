import { createPublicKey, verify } from 'node:crypto';

/**
 * Mirrors AinCode gateway/src/drive-identity.ts; keys come only from operator configuration.
 * This verifies identity only. Before issuing a grant, the caller must resolve the live account,
 * check the registered client's scope ceiling and consume the nonce in the grant transaction.
 */
export function verifyIdentityHandoff(token, { clients, audience, now = Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!header || header.alg !== 'EdDSA' || header.typ !== 'ainize-drive-handoff+jwt' || !claims) return null;
    if (typeof claims.azp !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.azp)) return null;
    const client = Object.hasOwn(clients, claims.azp) ? clients[claims.azp] : null;
    if (!client || claims.iss !== client.issuer || claims.aud !== audience) return null;
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + 5 || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60) return null;
    if (typeof claims.jti !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(claims.jti)) return null;
    if (typeof claims.sub !== 'string' || !/^(google:|sso:)[A-Za-z0-9._~-]{1,200}$|^0x[0-9a-f]{40}$/.test(claims.sub)) return null;
    if (!['google', 'wallet', 'sso'].includes(claims.auth_type)) return null;
    if (claims.auth_type === 'google' && !claims.sub.startsWith('google:')) return null;
    if (claims.auth_type === 'wallet' && !/^0x[0-9a-f]{40}$/.test(claims.sub)) return null;
    if (claims.auth_type === 'sso' && (typeof claims.sso_sub !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(claims.sso_sub))) return null;
    if (!Array.isArray(client.keys) || !client.keys.length) return null;
    const valid = client.keys.some(jwk => {
      if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || Object.hasOwn(jwk, 'd')) return false;
      return verify(null, Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    });
    if (!valid) return null;
    return { clientId: claims.azp, issuer: claims.iss, principal: claims.sub, authType: claims.auth_type, ssoSubject: claims.sso_sub ?? null, nonce: claims.jti, expires: claims.exp };
  } catch { return null; }
}
