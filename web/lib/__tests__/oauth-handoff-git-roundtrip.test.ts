import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'drive-real-git-db-'));
process.env.AINDRIVE_PUBLIC_URL = 'https://drive.test';
process.env.AINDRIVE_LOG_LEVEL = 'silent';
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
// Replace only the WebSocket connection. Every filesystem/Git RPC is executed
// by the production CLI dispatcher, against an isolated drive root.
const agent = vi.hoisted(() => ({ root: '', calls: [] as Record<string, unknown>[] }));
vi.mock('../rpc', () => ({
  AgentError: class extends Error {},
  callAgent: async (drive: string, secret: string, req: Record<string, unknown>) => {
    if (drive !== 'real-git-drive' || secret !== 'isolated-agent-secret') throw new Error('wrong agent binding');
    agent.calls.push(req);
    const source = new URL('../../../cli/src/rpc.js', import.meta.url).href;
    const { handleRpc } = await import(/* @vite-ignore */ source);
    return handleRpc(req, agent.root);
  },
}));
vi.mock('../git-project-hooks', () => ({ notifyProjectOfPush: async () => undefined }));
const { db } = await import('../db.js');
const { registerClient } = await import('../oauth');
const { POST } = await import('../../app/api/oauth/handoff/route');
const { gitHttpGET, gitHttpPOST } = await import('../git-http');

function git(cwd: string, args: string[], authorization?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...(authorization ? ['-c', `http.extraHeader=Authorization: Bearer ${authorization}`] : []), ...args], {
      cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString().trim())
      : reject(new Error(`git exited ${code}: ${Buffer.concat(err).toString()}`)));
  });
}

it('pushes and restores practice files through a cookie-free grant and the real storage agent, then refuses a revoked grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drive-real-git-'));
  agent.root = join(root, 'storage');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const client = registerClient('Real Git practice', ['https://ainize.ai/code/_practice/drive/callback']);
  process.env.AINDRIVE_IDENTITY_HANDOFF_CLIENTS = JSON.stringify({
    [client.client_id]: { issuer: 'https://ainize.ai', keys: [publicKey.export({ format: 'jwk' })] },
  });
  process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${client.client_id}=drives:read+drives:write`;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ainize-drive-handoff+jwt' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: 'https://ainize.ai', aud: 'https://drive.test', azp: client.client_id,
    sub: 'google:roundtrip-subject', auth_type: 'google', iat: now, exp: now + 60,
    jti: randomBytes(32).toString('base64url') })).toString('base64url');
  const input = `${header}.${claims}`;
  const proof = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  const handoff = await POST(new Request('https://drive.test/api/oauth/handoff', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof }),
  }));
  expect(handoff.status).toBe(200);
  const { access_token: token } = await handoff.json();
  const owner = db.prepare('SELECT account_id FROM account_google WHERE sub = ?').get('roundtrip-subject') as { account_id: string };
  db.prepare('INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?, ?, ?, ?, ?)')
    .run('real-git-drive', owner.account_id, 'Isolated practice storage', 'unused', 'isolated-agent-secret');
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body: Buffer[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      const url = new URL(incoming.url!, 'http://127.0.0.1');
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const req = new Request(url, { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(body) } : {}) });
      const path = url.pathname.slice('/git/'.length).split('/');
      const response = await (incoming.method === 'GET' ? gitHttpGET : gitHttpPOST)('real-git-drive', path, req);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500); outgoing.end('isolated git handler failed');
    }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const remote = `http://127.0.0.1:${address.port}/git/repositories/ainize-docs-practice`;
    const source = join(root, 'source');
    await git(root, ['init', '-q', '--initial-branch=main', source]);
    const progress = JSON.stringify({ doc: 'how-to/build-for-ainteams', steps: [{ id: 'step-1', status: 'passed' }] }) + '\n';
    const payload = randomBytes(5 * 1024 * 1024); // Exercise multiple 4 MiB upload chunks.
    await writeFile(join(source, 'progress.json'), progress);
    await writeFile(join(source, 'practice-artifact.bin'), payload);
    await git(source, ['add', '.']);
    await git(source, ['-c', 'user.name=Practice test', '-c', 'user.email=practice@example.test', 'commit', '-qm', 'Save practice']);
    const head = await git(source, ['rev-parse', 'HEAD']);
    await git(source, ['push', remote, 'main'], token);
    const restored = join(root, 'restored');
    await git(root, ['clone', '-q', remote, restored], token);
    expect(await git(restored, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await readFile(join(restored, 'progress.json'), 'utf8')).toBe(progress);
    expect(await readFile(join(restored, 'practice-artifact.bin'))).toEqual(payload);
    expect(await readFile(join(agent.root, 'repositories/ainize-docs-practice/progress.json'), 'utf8')).toBe(progress);
    expect(await git(agent.root, ['--git-dir=repositories/ainize-docs-practice.git', 'rev-parse', 'HEAD'])).toBe(head);
    expect(agent.calls.filter(call => call.method === 'upload-chunk').length).toBeGreaterThan(1);
    expect(agent.calls.some(call => call.method === 'git-service' && call.service === 'receive-pack')).toBe(true);
    expect(agent.calls.some(call => call.method === 'git-service' && call.service === 'upload-pack')).toBe(true);
    await vi.waitFor(async () => expect(await readdir(join(agent.root, '.aindrive/uploads/git'))).toEqual([]));
    // The same still-valid account grant follows the current path role.
    db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run('other-owner', 'owner@example.test', 'Other owner', 'unused');
    db.prepare('UPDATE drives SET owner_id = ? WHERE id = ?').run('other-owner', 'real-git-drive');
    db.prepare('INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?, ?, ?, ?, ?)')
      .run('practice-viewer', 'real-git-drive', owner.account_id, 'repositories/ainize-docs-practice', 'viewer');
    await git(root, ['clone', '-q', remote, join(root, 'viewer-restored')], token);
    const viewerCalls = agent.calls.length;
    await expect(git(source, ['push', remote, 'main'], token)).rejects.toThrow('git exited');
    expect(agent.calls).toHaveLength(viewerCalls);
    const calls = agent.calls.length;
    db.prepare('UPDATE account_tokens SET revoked_at = ? WHERE user_id = ?').run(Date.now(), owner.account_id);
    await expect(git(root, ['clone', '-q', remote, join(root, 'denied')], token)).rejects.toThrow('git exited');
    await expect(git(source, ['push', remote, 'main'], token)).rejects.toThrow('git exited');
    expect(agent.calls).toHaveLength(calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(process.env.AINDRIVE_DATA_DIR!, { recursive: true, force: true });
  }
}, 90_000);
