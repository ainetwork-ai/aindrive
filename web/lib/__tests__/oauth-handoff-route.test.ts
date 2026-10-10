import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'drive-handoff-route-'));
process.env.AINDRIVE_PUBLIC_URL = 'https://drive.test';
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
const agent = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../rpc', () => ({
  AgentError: class extends Error {},
  callAgent: async (_drive: string, _secret: string, req: Record<string, unknown>) => {
    agent.calls.push(req);
    if (req.method !== 'git-advertise') throw new Error('unexpected agent operation');
    return { exists: true, data: Buffer.from('0000').toString('base64') };
  },
}));
const { db } = await import('../db.js');
const { registerClient } = await import('../oauth');
const { verifyAccountToken } = await import('../account-tokens');
const { POST } = await import('../../app/api/oauth/handoff/route');
const { gitHttpGET } = await import('../git-http');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const client = registerClient('AinCode practice', ['https://ainize.ai/code/_practice/drive/callback']);
process.env.AINDRIVE_IDENTITY_HANDOFF_CLIENTS = JSON.stringify({
  [client.client_id]: { issuer: 'https://ainize.ai', keys: [publicKey.export({ format: 'jwk' })] },
});
process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${client.client_id}=drives:read+drives:write`;
db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run('person', 'person@example.com', 'Person', 'unused');
db.prepare('INSERT INTO account_google (sub, account_id, email) VALUES (?, ?, ?)').run('verified-sub', 'person', 'person@example.com');

function proof(sub = 'verified-sub', sso = false, wallet = false) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ainize-drive-handoff+jwt' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://ainize.ai', aud: 'https://drive.test', azp: client.client_id,
    sub: wallet ? sub : `google:${sub}`, auth_type: wallet ? 'wallet' : sso ? 'sso' : 'google', ...(sso ? { sso_sub: sub } : {}), iat: now, exp: now + 60, jti: randomBytes(32).toString('base64url') })).toString('base64url');
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

it('refuses malformed provider subjects and insufficient registered scope ceilings', async () => {
  expect((await POST(request(proof('invalid subject')))).status).toBe(401);
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

it('prepares a first-time SSO account without cookies and reuses its exact subject mapping', async () => {
  process.env.AINDRIVE_SSO_ISSUER = 'https://auth.test';
  process.env.AINDRIVE_SSO_CLIENT_ID = 'drive';
  const first = await POST(request(proof('first-time-sso', true)));
  expect(first.status).toBe(200);
  const pair = await first.json();
  const grant = verifyAccountToken(pair.access_token)!;
  const mapping = db.prepare('SELECT user_id FROM sso_identities WHERE issuer = ? AND subject = ?')
    .get('https://auth.test', 'first-time-sso') as { user_id: string };
  expect(mapping.user_id).toBe(grant.userId);
  expect(grant.userId).not.toBe('person');
  const second = await POST(request(proof('first-time-sso', true)));
  expect(second.status).toBe(200);
  expect(verifyAccountToken((await second.json()).access_token)?.userId).toBe(grant.userId);
  expect(db.prepare('SELECT COUNT(*) AS n FROM sso_identities WHERE issuer = ? AND subject = ?')
    .get('https://auth.test', 'first-time-sso')).toEqual({ n: 1 });
  db.prepare('INSERT INTO sso_memberships (issuer, org_id, subject, user_id, status, applied_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('https://auth.test', 'org', 'first-time-sso', grant.userId, 'suspended', 1, Date.now());
  expect((await POST(request(proof('first-time-sso', true)))).status).toBe(401);
  expect(db.prepare('SELECT COUNT(*) AS n FROM sso_identities WHERE issuer = ? AND subject = ?')
    .get('https://auth.test', 'first-time-sso')).toEqual({ n: 1 });
});

it('rolls back a newly prepared SSO account if grant persistence fails', async () => {
  db.exec("CREATE TRIGGER fail_new_handoff BEFORE INSERT ON account_tokens BEGIN SELECT RAISE(ABORT, 'new account grant failure'); END");
  await expect(POST(request(proof('rollback-sso', true)))).rejects.toThrow('new account grant failure');
  db.exec('DROP TRIGGER fail_new_handoff');
  expect(db.prepare('SELECT user_id FROM sso_identities WHERE issuer = ? AND subject = ?')
    .get('https://auth.test', 'rollback-sso')).toBeUndefined();
});

it('uses the cookie-free handoff grant at the actual Git HTTP route and enforces live revocation', async () => {
  db.prepare('INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?, ?, ?, ?, ?)')
    .run('handoff-drive', 'person', 'Practice', 'unused', 'test-secret');
  const pair = await (await POST(request(proof()))).json();
  const gitRequest = (service: string, basic = false) => new Request(
    `https://drive.test/api/drives/handoff-drive/git/repositories/docs/info/refs?service=git-${service}`,
    { headers: { authorization: basic
      ? `Basic ${Buffer.from('x-access-token:' + pair.access_token).toString('base64')}`
      : `Bearer ${pair.access_token}` } },
  );
  for (const [service, basic] of [['upload-pack', false], ['receive-pack', true]] as const) {
    const response = await gitHttpGET('handoff-drive', ['repositories', 'docs', 'info', 'refs'], gitRequest(service, basic));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(`application/x-git-${service}-advertisement`);
    expect(await response.text()).toContain(`# service=git-${service}`);
    expect(agent.calls.at(-1)).toMatchObject({ method: 'git-advertise', repo: 'repositories/docs.git', service });
  }
  const calls = agent.calls.length;
  db.prepare('UPDATE account_tokens SET revoked_at = ? WHERE user_id = ?').run(Date.now(), 'person');
  expect((await gitHttpGET('handoff-drive', ['repositories', 'docs', 'info', 'refs'], gitRequest('receive-pack'))).status).toBe(401);
  expect(agent.calls).toHaveLength(calls);
});

it('prepares an unknown wallet account but refuses a linked payment-only wallet', async () => {
  const address = '0x' + 'a'.repeat(40);
  const first = await POST(request(proof(address, false, true)));
  expect(first.status).toBe(200);
  const grant = verifyAccountToken((await first.json()).access_token)!;
  expect(db.prepare('SELECT account_id, login_enabled FROM account_wallets WHERE wallet_address = ?').get(address))
    .toEqual({ account_id: grant.userId, login_enabled: 1 });
  const again = await POST(request(proof(address, false, true)));
  expect(verifyAccountToken((await again.json()).access_token)?.userId).toBe(grant.userId);
  db.prepare('UPDATE account_wallets SET login_enabled = 0 WHERE wallet_address = ?').run(address);
  expect((await POST(request(proof(address, false, true)))).status).toBe(401);
  expect(db.prepare('SELECT login_enabled FROM account_wallets WHERE wallet_address = ?').get(address))
    .toEqual({ login_enabled: 0 });
});

it('rolls back a new wallet identity when grant persistence fails', async () => {
  const address = '0x' + 'b'.repeat(40);
  db.exec("CREATE TRIGGER fail_wallet_handoff BEFORE INSERT ON account_tokens BEGIN SELECT RAISE(ABORT, 'wallet grant failure'); END");
  await expect(POST(request(proof(address, false, true)))).rejects.toThrow('wallet grant failure');
  db.exec('DROP TRIGGER fail_wallet_handoff');
  expect(db.prepare('SELECT account_id FROM account_wallets WHERE wallet_address = ?').get(address)).toBeUndefined();
  expect(db.prepare('SELECT id FROM users WHERE email = ?').get(address + '@wallet.aindrive.local')).toBeUndefined();
});

it('prepares and reuses a Google subject without trusting a supplied email', async () => {
  const response = await POST(request(proof('first-time-google')));
  expect(response.status).toBe(200);
  const grant = verifyAccountToken((await response.json()).access_token)!;
  expect(grant.userId).not.toBe('person');
  const account = db.prepare('SELECT email FROM users WHERE id = ?').get(grant.userId) as { email: string };
  expect(account.email).toMatch(/^google-[a-f0-9]{40}@sso\.aindrive\.local$/);
  const again = await POST(request(proof('first-time-google')));
  expect(verifyAccountToken((await again.json()).access_token)?.userId).toBe(grant.userId);
  expect(db.prepare('SELECT COUNT(*) AS n FROM account_google WHERE sub = ?').get('first-time-google')).toEqual({ n: 1 });
});

it('rolls back a first-time Google account if grant persistence fails', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  db.exec("CREATE TRIGGER fail_google_handoff BEFORE INSERT ON account_tokens BEGIN SELECT RAISE(ABORT, 'google grant failure'); END");
  await expect(POST(request(proof('rollback-google')))).rejects.toThrow('google grant failure');
  db.exec('DROP TRIGGER fail_google_handoff');
  expect(db.prepare('SELECT account_id FROM account_google WHERE sub = ?').get('rollback-google')).toBeUndefined();
  expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual(before);
});
