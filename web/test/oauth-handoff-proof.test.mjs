import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyIdentityHandoff } from '../lib/oauth-handoff.js';

test('only pinned, correctly addressed, short-lived identity proofs verify', () => {
  const keys = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const options = { clients: { practice: { issuer: 'https://ainize.ai', keys: [publicKey] } }, audience: 'https://aindrive.ainetwork.ai', now: 1000 };
  const claims = { iss: 'https://ainize.ai', aud: options.audience, azp: 'practice', sub: 'google:123456', auth_type: 'google', iat: 1000, exp: 1060, jti: 'n'.repeat(43) };
  const token = (changes = {}, header = {}, key = keys.privateKey) => {
    const parts = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ainize-drive-handoff+jwt', ...header })).toString('base64url'), Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')];
    const message = parts.join('.');
    return message + '.' + sign(null, Buffer.from(message), key).toString('base64url');
  };
  assert.equal(verifyIdentityHandoff(token(), options)?.principal, claims.sub);
  for (const changes of [{ iss: 'https://attacker.example' }, { aud: 'https://other.example' }, { azp: 'untrusted' }, { exp: 1000 }, { exp: 2000 }, { iat: 1006 }, { jti: 'short' }, { auth_type: 'email' }, { sub: 'person@example.com' }, { auth_type: 'wallet' }, { auth_type: 'sso' }]) {
    assert.equal(verifyIdentityHandoff(token(changes), options), null);
  }
  assert.equal(verifyIdentityHandoff(token({}, { typ: 'at+jwt' }), options), null);
  assert.equal(verifyIdentityHandoff(token({}, { alg: 'HS256' }), options), null);
  assert.equal(verifyIdentityHandoff(token({}, {}, other.privateKey), options), null);
  assert.equal(verifyIdentityHandoff(token().replace(/.$/, '!'), options), null);
  assert.equal(verifyIdentityHandoff(token({ sub: '0x' + 'a'.repeat(40), auth_type: 'wallet' }), options)?.authType, 'wallet');
  assert.equal(verifyIdentityHandoff(token({ auth_type: 'sso', sso_sub: 'acc_verified' }), options)?.ssoSubject, 'acc_verified');
  assert.equal(verifyIdentityHandoff(token(), { ...options, clients: { practice: { issuer: claims.iss, keys: [keys.privateKey.export({ format: 'jwk' })] } } }), null);
})
