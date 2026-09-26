import { randomUUID } from 'node:crypto';
import { ainuiActivity, ainuiFolderChat, type ChatUpdate, type FolderChatAgent } from 'ain-ui';

/** AG-UI transport with AIN-UI snapshots. Aborting the reader aborts the upstream A2A fetch. */
export function folderChatStream(req: Request, scope: { driveId: string; path: string; agent: FolderChatAgent; q: string }, run: (signal: AbortSignal, update: (u: ChatUpdate) => void) => Promise<ChatUpdate>): Response {
  const controller = new AbortController();
  const signal = AbortSignal.any([req.signal, controller.signal, AbortSignal.timeout(120_000)]);
  const runId = randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(out) {
      const emit = (event: unknown) => { if (!signal.aborted) out.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
      emit({ type: 'RUN_STARTED', threadId: runId, runId });
      const heartbeat = setInterval(() => { if (!signal.aborted) out.enqueue(encoder.encode(': keepalive\n\n')); }, 15000);
      const update = (value: ChatUpdate, busy = true) => {
        emit({ type: 'CUSTOM', name: 'ainui.chat.snapshot', value });
        emit(ainuiActivity(runId, ainuiFolderChat({ ...scope, agents: [scope.agent], agentId: scope.agent.id, busy, messages: [{ role: 'user', text: scope.q }, { role: 'agent', text: value.text }] })));
      };
      void run(signal, update).then(result => {
        update(result, false);
        emit({ type: 'RUN_FINISHED', threadId: runId, runId, result: { contextId: result.contextId } });
      }).catch(error => {
        emit({ type: 'RUN_ERROR', message: error instanceof Error ? error.message : 'Chat failed' });
      }).finally(() => { clearInterval(heartbeat); try { out.close(); } catch { /* reader canceled */ } });
    },
    cancel() { controller.abort(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}
