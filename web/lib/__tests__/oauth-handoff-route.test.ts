import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'drive-handoff-route-'));
process.env.AINDRIVE_PUBLIC_URL = 'https://drive.test';
const { db } = await import('../db.js');
const { registerClient } = await import('../oauth');
const { verifyAccountToken } = await import('../account-tokens');
const { POST } = await import('../../app/api/oauth/handoff/route');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const client = registerClient('AinCode practice', ['https://ainize.ai/code/_practice/drive/callback']);
process.env.AINDRIVE_IDENTITY_HANDOFF_CLIENTS = JSON.stringify({
  [client.client_id]: { issuer: 'https://ainize.ai', keys: [publicKey.export({ format: 'jwk' })] },
});
process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${client.client_id}=drives:read+drives:write`;
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('person', 'person@example.com', 'Person', 'unused');
db.prepare('INSERT INTO account_google (sub, account_id, email) VALUES (?, ?, ?)').run('verified-sub', 'person', 'person@example.com');

function proof(sub = 'verified-sub') {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ainize-drive-handoff+jwt' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://ainize.ai', aud: 'https://drive.test', azp: client.client_id,
    sub: `google:${sub}`, auth_type: 'google', iat: now, exp: now + 60, jti: randomBytes(32).toString('base64url') })).toString('base64url');
  const data = `${header}.${body}`;
  return `${data}.${sign(null, Buffer.from(data), privateKey).toString('base64url')}`;
}
const request = (token: string) => new Request('https://drive.test/api/oauth/handoff', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ proof: token, scope: 'wallet:pay drives:sell', userId: 'attacker' }),
});

it('issues a real account grant without cookies, ignores requested authority, and rejects replay', async () => {
  const token = proof();
  const response = await POST(request(token));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const pair = await response.json();
  expect(verifyAccountToken(pair.access_token)).toMatchObject({ userId: 'person', clientId: client.client_id, scopes: ['drives:read', 'drives:write'] });
  expect((await POST(request(token))).status).toBe(401);
  expect(db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get()).toEqual({ n: 1 });
});

it('refuses unknown provider subjects and insufficient registered scope ceilings', async () => {
  expect((await POST(request(proof('unknown-sub')))).status).toBe(401);
  process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${client.client_id}=drives:read`;
  expect((await POST(request(proof()))).status).toBe(401);
  expect(db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get()).toEqual({ n: 1 });
});

it('rolls back nonce consumption when token persistence fails', async () => {
  process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${client.client_id}=drives:read+drives:write`;
  const token = proof();
  db.exec("CREATE TRIGGER fail_handoff_grant BEFORE INSERT ON account_tokens BEGIN SELECT RAISE(ABORT, 'test grant failure'); END");
  await expect(POST(request(token))).rejects.toThrow('test grant failure');
  db.exec('DROP TRIGGER fail_handoff_grant');
  expect((await POST(request(token))).status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get()).toEqual({ n: 2 });
});
