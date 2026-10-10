import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'aindrive-git-oauth-'));
process.env.AINDRIVE_PUBLIC_URL = 'http://drive.test';
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
const { db } = await import('../db.js');
const oauth = await import('../oauth');
const { issueAccountTokens } = await import('../account-tokens');
const { requireDriveRole } = await import('../require-access');
let clientId = '';
beforeAll(() => {
  const user = db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)');
  user.run('owner', 'owner@example.com', 'Owner', 'x');
  user.run('viewer', 'viewer@example.com', 'Viewer', 'x');
  db.prepare('INSERT INTO drives (id,owner_id,name,agent_token_hash,drive_secret) VALUES (?,?,?,?,?)').run('d1', 'owner', 'Practice', 'h', 's');
  db.prepare('INSERT INTO drive_members (id,drive_id,user_id,path,role) VALUES (?,?,?,?,?)').run('m1', 'd1', 'viewer', 'repositories/docs', 'viewer');
  clientId = oauth.registerClient('AinCode documentation practice', ['https://ainize.ai/code/_practice/drive/callback']).client_id;
});
const token = (userId: string, scope: string) => issueAccountTokens({ userId, clientId, clientName: 'AinCode documentation practice', scopes: oauth.parseAccountScopes(scope) }).access_token;
const gate = (bearer: string, min: 'viewer' | 'editor', path = 'repositories/docs') => requireDriveRole('d1', path, { min, oauthGit: true, req: new Request('http://drive.test/comcom/git/docs/info/refs', { headers: { authorization: `Bearer ${bearer}` } }) });
const status = (result: Awaited<ReturnType<typeof gate>>) => result instanceof Response ? result.status : 200;
describe('OAuth Git uses the existing live Drive role and explicit scopes', () => {
  it('read scope can clone but cannot push even when the account owns the drive', async () => {
    const read = token('owner', 'drives:read');
    expect(status(await gate(read, 'viewer'))).toBe(200);
    expect(status(await gate(read, 'editor'))).toBe(403);
  });
  it('write scope permits push only to paths the account may edit', async () => {
    expect(status(await gate(token('owner', 'drives:read drives:write'), 'editor'))).toBe(200);
    expect(status(await gate(token('viewer', 'drives:read drives:write'), 'editor'))).toBe(403);
    expect(status(await gate(token('viewer', 'drives:read'), 'viewer', 'repositories/elsewhere'))).toBe(403);
  });
  it('revocation and the reserved subtree are enforced before reaching Git', async () => {
    const access = token('owner', 'drives:read drives:write');
    db.prepare('UPDATE account_tokens SET revoked_at=? WHERE user_id=?').run(Date.now(), 'owner');
    expect(status(await gate(access, 'editor'))).toBe(401);
    expect(status(await gate(token('owner', 'drives:read drives:write'), 'editor', '.aindrive/keys'))).toBe(403);
  });
});
