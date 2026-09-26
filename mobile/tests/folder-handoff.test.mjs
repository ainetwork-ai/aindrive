import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundle the same TypeScript modules both native shells ship, without loading Capacitor.
const result = await build({
  stdin: { contents: 'export * from "./src/folder-handoff"; export * from "./src/a2a-parts";', resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { prepareFolderHandoff, handoffParts, HANDOFF_MCP_PART } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const entry = (name, isDir = false) => ({ name, path: name, isDir, size: 42, mtimeMs: 1, mime: isDir ? '' : 'text/plain' });
const mcp = { url: 'https://drive.test/mcp/h/grant', token: 'test-grant-token', expiresAt: '2099-01-01T00:00:00Z' };

for (const uri of ['content://test/tree/folder', 'file:///test/folder']) {
  test(`first folder turn carries snapshot and MCP (${uri.split(':')[0]})`, async () => {
    const handed = await prepareFolderHandoff({ uri, label: 'Notes' }, async opts => {
      assert.deepEqual(opts, { folderUri: uri, path: '' });
      return { entries: [entry('note.txt'), entry('photos', true)] };
    }, async files => {
      assert.deepEqual(files, [{ folderUri: uri, path: 'note.txt' }]);
      return { files: [{ uri: 'https://drive.test/api/h/link?k=key', name: 'note.txt', mimeType: 'text/plain' }], mcp, links: [{ id: 'link' }] };
    });
    const parts = handoffParts("what's in this folder?", handed);
    assert.equal(parts[0].text, "what's in this folder?");
    assert.ok(parts.some(p => p.kind === 'text' && p.text.includes('note.txt') && p.text.includes('photos')));
    assert.deepEqual(parts.find(p => p.metadata?.type === HANDOFF_MCP_PART).data.mcpServers[0], {
      name: 'aindrive-handoff', transport: 'streamable-http', url: mcp.url,
      headers: { Authorization: `Bearer ${mcp.token}` }, expiresAt: mcp.expiresAt, tools: ['list_files', 'read_file'],
    });
    assert.equal(parts.find(p => p.metadata?.type === 'ai.aindrive/folder-context').data.folder.totalEntries, 2);
    assert.equal(parts.filter(p => p.kind === 'file').length, 1);
    assert.ok(!JSON.stringify(parts).includes(uri));
    assert.ok(!parts.filter(p => p.kind === 'text').some(p => p.text.includes(mcp.token)));
  });
}

test('empty and directory-only folders still provide a usable listing without an invented MCP link', async () => {
  for (const entries of [[], [entry('archive', true)]]) {
    const handed = await prepareFolderHandoff({ uri: 'local', label: 'Folder' }, async () => ({ entries }), async picked => {
      assert.deepEqual(picked, []);
      return { files: [], links: [] };
    });
    assert.equal(handed.folder.totalEntries, entries.length);
    const parts = handoffParts('list this folder', handed);
    assert.ok(parts.some(p => p.metadata?.type === 'ai.aindrive/folder-context'));
    assert.ok(!parts.some(p => p.metadata?.type === HANDOFF_MCP_PART));
  }
});

test('listing bounds and read grants are explicit and never include directories', async () => {
  const entries = [entry('subfolder', true), ...Array.from({ length: 250 }, (_, i) => entry(`file-${i}.txt`))];
  const handed = await prepareFolderHandoff({ uri: 'selected', label: 'Large folder' }, async () => ({ entries }), async picked => {
    assert.equal(picked.length, 10);
    assert.ok(picked.every(p => p.folderUri === 'selected' && p.path !== 'subfolder'));
    return { files: [], links: [] };
  });
  assert.equal(handed.folder.totalEntries, 251);
  assert.equal(handed.folder.entries.length, 200);
  assert.equal(handed.folder.truncated, true);
  assert.equal(handed.folder.recursive, false);
});

test('a failed native listing or refused handoff never becomes a context-free send', async () => {
  await assert.rejects(prepareFolderHandoff({ uri: 'gone', label: 'Gone' }, async () => { throw new Error('Folder missing'); }, async () => { throw new Error('must not mint'); }), /Folder missing/);
  assert.equal(await prepareFolderHandoff({ uri: 'local', label: 'Folder' }, async () => ({ entries: [entry('a.txt')] }), async () => null), null);
});

test('existing search-result handoffs retain their wire format', () => {
  const parts = handoffParts('summarize these files', { files: [{ uri: 'https://drive.test/h/1', name: 'a.txt', mimeType: 'text/plain' }], mcp });
  assert.equal(parts.length, 3);
  assert.equal(parts[1].kind, 'file');
  assert.equal(parts[2].metadata.type, HANDOFF_MCP_PART);
  assert.deepEqual(handoffParts('hello', { files: [] }), [{ kind: 'text', text: 'hello' }]);
});

test('context does not depend on question keywords or language; the model chooses what to read', async () => {
  const handed = await prepareFolderHandoff({ uri: 'selected', label: 'Folder' }, async () => ({ entries: [entry('a.txt')] }), async () => ({ files: [], mcp }));
  const questions = ["what's in this folder?", 'bonjour', 'hello', 'compare the notes', '이 폴더에 뭐가 있어?'];
  const expected = handoffParts(questions[0], handed).slice(1);
  for (const q of questions) assert.deepEqual(handoffParts(q, handed).slice(1), expected);
});

test('previous selected files remain candidates and are deduplicated', async () => {
  await prepareFolderHandoff({ uri: 'selected', label: 'Folder' }, async () => ({ entries: [entry('other.txt')] }), async picked => {
    assert.deepEqual(picked, [{ folderUri: 'selected', path: 'nested/result.txt' }]);
    return { files: [] };
  }, ['nested/result.txt', 'nested/result.txt']);
});

test('official A2A SDK sends all parts and keeps MCP credentials out of the agent auth header', async () => {
  const built = await build({ stdin: { contents: 'export { send } from "./src/a2a";', resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
  const { send } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const original = globalThis.fetch;
  let outgoing;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://cloud.test/a2a');
    assert.notEqual(new Headers(init.headers).get('authorization'), `Bearer ${mcp.token}`);
    outgoing = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: outgoing.id, result: { kind: 'message', role: 'agent', messageId: 'reply', contextId: 'conversation', parts: [{ kind: 'text', text: 'Listed the folder' }] } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const card = { name: 'Mock cloud', description: 'Test', url: 'https://cloud.test/a2a', version: '1', protocolVersion: '0.3.0', capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [] };
    const binaryFiles = [
      { uri: 'https://drive.test/api/h/photo?k=photo-key', name: 'photo.jpg', mimeType: 'image/jpeg' },
      { uri: 'https://drive.test/api/h/pdf?k=pdf-key', name: 'notes.pdf', mimeType: 'application/pdf' },
    ];
    const handed = await prepareFolderHandoff({ uri: 'local-folder', label: 'Folder' }, async () => ({ entries: binaryFiles.map(f => ({ ...entry(f.name), mime: f.mimeType })) }), async picked => {
      assert.deepEqual(picked.map(f => f.path), ['photo.jpg', 'notes.pdf']);
      return { files: binaryFiles, mcp };
    });
    const reply = await send({ id: 'test', source: card.url, url: card.url, name: card.name, skills: [], card, enabled: true, addedAt: 1 }, "what's in this folder?", 'conversation', undefined, handed);
    assert.equal(outgoing.method, 'message/send');
    assert.equal(outgoing.params.message.contextId, 'conversation');
    assert.ok(outgoing.params.message.parts.some(p => p.metadata?.type === HANDOFF_MCP_PART));
    assert.ok(outgoing.params.message.parts.some(p => p.metadata?.type === 'ai.aindrive/folder-context'));
    assert.deepEqual(outgoing.params.message.parts.filter(p => p.kind === 'file').map(p => p.file), binaryFiles);
    assert.equal(reply.text, 'Listed the folder');
  } finally { globalThis.fetch = original; }
});
