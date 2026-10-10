import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { WebSocketServer } from 'ws';

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'drive-ws-git-db-'));
process.env.AINDRIVE_PUBLIC_URL = 'https://drive.test';
process.env.AINDRIVE_LOG_LEVEL = 'silent';
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
// Project publication is outside this private storage roundtrip.
vi.mock('../git-project-hooks', () => ({ notifyProjectOfPush: async () => undefined }));
const { db } = await import('../db.js');
const { registerClient } = await import('../oauth');
const { createDrive } = await import('../drives');
const { onAgentConnect, isAgentConnected } = await import('../agents.js');
const { POST } = await import('../../app/api/oauth/handoff/route');
const { GET: driveList } = await import('../../app/api/oauth/drives/route');
const { gitHttpGET, gitHttpPOST } = await import('../git-http');

function git(cwd: string, args: string[], token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args], {
      cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString().trim())
      : reject(new Error(`git exited ${code}: ${Buffer.concat(err).toString()}`)));
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
  await closed; clearTimeout(force);
}

it('restores a private practice through real authenticated WebSocket RPC and lists online/offline storage accurately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drive-ws-git-'));
  const storage = join(root, 'storage');
  await mkdir(join(storage, '.aindrive'), { recursive: true });
  let driveId = '';
  let agent: ChildProcess | undefined;
  const methods: string[] = [];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024 * 1024 });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body: Buffer[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      const url = new URL(incoming.url!, 'http://127.0.0.1');
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const req = new Request(url, { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(body) } : {}) });
      const response = url.pathname === '/api/oauth/handoff' ? await POST(req)
        : url.pathname === '/api/oauth/drives' ? driveList(req)
        : url.pathname.startsWith('/git/') ? await (incoming.method === 'GET' ? gitHttpGET : gitHttpPOST)(driveId, url.pathname.slice(5).split('/'), req)
        : new Response('not found', { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500); outgoing.end('isolated handler failed');
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname !== '/api/agent/connect') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'response' && typeof frame.result?.method === 'string') methods.push(frame.result.method);
      });
      void onAgentConnect(ws, req, Object.fromEntries(url.searchParams)).catch(() => ws.close(1011));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const client = registerClient('WebSocket practice', ['https://ainize.ai/code/_practice/drive/callback']);
    process.env.AINDRIVE_IDENTITY_HANDOFF_CLIENTS = JSON.stringify({
      [client.client_id]: { issuer: 'https://ainize.ai', keys: [publicKey.export({ format: 'jwk' })] },
    });
    process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS = `${client.client_id}=drives:read+drives:write`;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ainize-drive-handoff+jwt' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'https://ainize.ai', aud: 'https://drive.test', azp: client.client_id,
      sub: 'google:websocket-subject', auth_type: 'google', iat: now, exp: now + 60,
      jti: randomBytes(32).toString('base64url') })).toString('base64url');
    const input = `${header}.${body}`;
    const proof = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    const handoff = await fetch(base + '/api/oauth/handoff', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof }),
    });
    expect(handoff.status).toBe(200);
    const { access_token: token } = await handoff.json();
    const owner = db.prepare('SELECT account_id FROM account_google WHERE sub = ?').get('websocket-subject') as { account_id: string };
    const drive = await createDrive(owner.account_id, 'Private WebSocket practice');
    driveId = drive.driveId;
    const config = { ...drive, serverUrl: base };
    const configFile = join(storage, '.aindrive/config.json');
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const list = async () => {
      const response = await fetch(base + '/api/oauth/drives', { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200); return (await response.json()).drives;
    };
    expect(await list()).toEqual([expect.objectContaining({ id: driveId, online: false, role: 'owner' })]);
    const entry = new URL('../../../cli/src/agent.js', import.meta.url).href;
    const script = `import fs from 'node:fs'; import {runAgent} from ${JSON.stringify(entry)}; const config=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); await runAgent({root:process.argv[2],drive:config,server:config.serverUrl});`;
    agent = spawn(process.execPath, ['--input-type=module', '--eval', script, configFile, storage], {
      cwd: root, env: { ...process.env, AINDRIVE_LOG_LEVEL: 'silent', AINDRIVE_TRACE: 'off' }, stdio: 'ignore',
    });
    await vi.waitFor(() => expect(isAgentConnected(driveId)).toBe(true), { timeout: 15_000 });
    expect(await list()).toEqual([expect.objectContaining({ id: driveId, online: true, role: 'owner' })]);
    const remote = base + '/git/repositories/ainize-docs-practice';
    const source = join(root, 'source'), restored = join(root, 'restored');
    await git(root, ['init', '-q', '--initial-branch=main', source], token);
    const progress = JSON.stringify({ doc: 'how-to/build-for-ainteams', step: 'step-1', status: 'command-passed' }) + '\n';
    const bytes = randomBytes(5 * 1024 * 1024);
    await writeFile(join(source, 'progress.json'), progress);
    await writeFile(join(source, 'artifact.bin'), bytes);
    await git(source, ['add', '.'], token);
    await git(source, ['-c', 'user.name=Practice test', '-c', 'user.email=practice@example.test', 'commit', '-qm', 'Save private practice'], token);
    await git(source, ['push', remote, 'main'], token);
    await git(root, ['clone', '-q', remote, restored], token);
    expect(await git(restored, ['rev-parse', 'HEAD'], token)).toBe(await git(source, ['rev-parse', 'HEAD'], token));
    expect(await readFile(join(restored, 'progress.json'), 'utf8')).toBe(progress);
    expect(await readFile(join(restored, 'artifact.bin'))).toEqual(bytes);
    expect(await readFile(join(storage, 'repositories/ainize-docs-practice/progress.json'), 'utf8')).toBe(progress);
    expect(methods.filter(m => m === 'upload-chunk').length).toBeGreaterThan(1);
    expect(methods.filter(m => m === 'git-service').length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(async () => expect(await readdir(join(storage, '.aindrive/uploads/git'))).toEqual([]));
    await stop(agent);
    await vi.waitFor(() => expect(isAgentConnected(driveId)).toBe(false));
    expect(await list()).toEqual([expect.objectContaining({ id: driveId, online: false })]);
  } finally {
    await stop(agent);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(process.env.AINDRIVE_DATA_DIR!, { recursive: true, force: true });
  }
}, 90_000);
