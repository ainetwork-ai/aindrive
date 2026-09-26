import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// The folding a2a.ts applies to every A2A reply, bundled without Capacitor.
const result = await build({
  stdin: { contents: 'export * from "./src/a2a-stream";', resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { a2aReplyStart, foldA2aEvent, a2aReplyText } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const fold = (events, contextId) => {
  const seen = [];
  let r = a2aReplyStart(contextId);
  for (const e of events) { r = foldA2aEvent(r, e); seen.push(r); if (r.done) break; }
  return { r, seen };
};
const text = (t) => [{ kind: 'text', text: t }];
const chunk = (t, append) => ({ kind: 'artifact-update', taskId: 't', contextId: 'c1', append, artifact: { artifactId: 'answer', parts: text(t) } });

test('a streamed answer grows piece by piece, spaces kept, and the final status is the whole answer', () => {
  const { r, seen } = fold([
    { kind: 'task', id: 't', contextId: 'c1', status: { state: 'submitted' } },
    { kind: 'status-update', taskId: 't', contextId: 'c1', final: false, status: { state: 'working', message: { kind: 'message', role: 'agent', parts: text('Opening attached file 1…') } } },
    chunk('Hello', false), chunk('!', true), chunk(' How', true), chunk(' can I help?', true),
    { kind: 'status-update', taskId: 't', contextId: 'c1', final: true, status: { state: 'completed', message: { kind: 'message', role: 'agent', parts: text('Hello! How can I help?') } } },
  ]);
  assert.equal(seen[1].step, 'Opening attached file 1…', 'the step is shown before any answer text');
  assert.deepEqual(seen.slice(2, 6).map((s) => s.text), ['Hello', 'Hello!', 'Hello! How', 'Hello! How can I help?']);
  assert.equal(seen[2].step, undefined, 'answer text replaces the step');
  assert.equal(r.done, true);
  assert.equal(r.contextId, 'c1');
  assert.equal(a2aReplyText(r), 'Hello! How can I help?');
});

test('a step reported after the answer started does not hide the answer', () => {
  const { seen } = fold([chunk('Part one.', false), { kind: 'status-update', contextId: 'c1', final: false, status: { state: 'working', message: { parts: text('Reading b.pdf…') } } }]);
  assert.equal(seen[1].text, 'Part one.');
  assert.equal(seen[1].step, undefined);
});

test('an agent without streaming answers with one Message or one Task, folded the same way', () => {
  const m = fold([{ kind: 'message', role: 'agent', messageId: 'x', contextId: 'c9', parts: text('Plain reply') }]).r;
  assert.deepEqual([m.done, m.text, m.contextId], [true, 'Plain reply', 'c9']);
  const t = fold([{ kind: 'task', id: 't', contextId: 'c2', status: { state: 'completed', message: { parts: text('Said') } }, artifacts: [{ parts: text('Made') }] }]).r;
  assert.equal(a2aReplyText(t), 'Said\n\nMade');
});

test('a turn that ends without text says how it ended', () => {
  const r = fold([{ kind: 'task', id: 't', contextId: 'c', status: { state: 'input-required' } }]).r;
  assert.equal(a2aReplyText(r), 'The agent needs more input.');
  assert.equal(a2aReplyText(fold([], 'c').r), '(empty reply)');
});
