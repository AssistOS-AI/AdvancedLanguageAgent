import fs from 'node:fs/promises';
import path from 'node:path';
import { openJsonChannel } from './json-channel.mjs';
import { codexMcpOverrides } from './mcp-servers.mjs';
import { createPiEventParser } from './pi.mjs';

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Coding-agent execution was interrupted.'), { name: 'AbortError' });
}

export async function runCodexLive(input) {
  checkAbort(input.signal);
  const rpc = openJsonChannel(input, [...codexMcpOverrides(input.mcpServers || []),
    '--config', `web_search=${JSON.stringify(input.websearch ? 'live' : 'disabled')}`, 'app-server']);
  let threadId = input.continuation?.threadId;
  let turnId = null;
  let finalText = '';
  let cancelTimer;
  const abort = () => {
    cancelTimer ||= setTimeout(() => { void rpc.close(); }, 1500);
    if (turnId) void rpc.request({ method: 'turn/interrupt', params: { threadId, turnId } }).catch(() => {});
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  rpc.events.on('event', (event) => {
    if (event.method === 'turn/started') turnId = event.params?.turn?.id;
    if (event.method === 'item/agentMessage/delta') input.onVisibleText?.(event.params?.delta || '');
    if (event.method === 'item/commandExecution/outputDelta') input.onVisibleText?.(event.params?.delta || '');
    if (event.method === 'item/completed' && event.params?.item?.type === 'agentMessage') {
      finalText = event.params.item.text || '';
    }
  });
  try {
    await rpc.request({ method: 'initialize', params: { clientInfo: { name: 'ala', version: '1' } } });
    rpc.send({ method: 'initialized', params: {} });
    checkAbort(input.signal);
    const thread = await rpc.request({ method: threadId ? 'thread/resume' : 'thread/start', params: {
      ...(threadId ? { threadId } : {}), cwd: input.workspace,
      approvalPolicy: 'never', sandbox: 'danger-full-access',
      ...(input.model ? { model: input.model } : {})
    } });
    if (!thread.thread?.id || (threadId && thread.thread.id !== threadId)) {
      throw new Error('Codex did not restore the requested native thread.');
    }
    threadId = thread.thread.id;
    await input.onSession?.({ threadId });
    checkAbort(input.signal);
    const complete = rpc.wait((event) => event.method === 'turn/completed' && event.params?.threadId === threadId);
    const started = await rpc.request({ method: 'turn/start', params: {
      threadId, input: [{ type: 'text', text: input.prompt }]
    } });
    turnId = started.turn.id;
    if (input.signal?.aborted) abort();
    input.setMessageHandler?.(async (message) => {
      await rpc.request({ method: 'turn/steer', params: {
        threadId, expectedTurnId: turnId, input: [{ type: 'text', text: message }]
      } });
      return { delivery: 'delivered' };
    });
    const ended = await complete;
    input.setMessageHandler?.(null);
    checkAbort(input.signal);
    if (ended.params.turn.status !== 'completed') throw new Error(ended.params.turn.error?.message || 'Codex turn failed.');
    if (!finalText) throw new Error('Codex completed without a final assistant message.');
    return { outputText: finalText, continuation: { threadId } };
  } finally {
    clearTimeout(cancelTimer);
    input.setMessageHandler?.(null);
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}

export async function runPiLive(input) {
  checkAbort(input.signal);
  const sessionDir = `${input.workspace}/.ala-pi-sessions`;
  await fs.mkdir(path.join(input.hostWorkspace, '.ala-pi-sessions'), { recursive: true, mode: 0o700 });
  const previous = input.continuation?.sessionFile;
  if (input.continuation && !previous) throw new Error('Pi continuation has no session file.');
  if (previous) {
    if (!previous.startsWith(`${sessionDir}/`) || path.basename(previous) !== previous.slice(sessionDir.length + 1)) {
      throw new Error('Invalid Pi session file.');
    }
    await fs.access(path.join(input.hostWorkspace, '.ala-pi-sessions', path.basename(previous)));
  }
  const rpc = openJsonChannel(input, ['--mode', 'rpc', '--session-dir', sessionDir, '--approve',
    ...(previous ? ['--session', previous] : []), ...(input.model ? ['--model', input.model] : [])]);
  const parser = createPiEventParser({ onText: input.onVisibleText });
  rpc.events.on('event', (event) => parser.push(Buffer.from(`${JSON.stringify(event)}\n`)));
  let cancelTimer;
  const abort = () => {
    cancelTimer ||= setTimeout(() => { void rpc.close(); }, 1500);
    void rpc.request({ type: 'clear_queue' }).then(() => rpc.request({ type: 'abort' })).catch(() => {});
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const state = await rpc.request({ type: 'get_state' });
    if (!state.sessionFile || !state.sessionId) throw new Error('Pi did not expose a persistent session.');
    if (previous && (state.sessionFile !== previous || state.sessionId !== input.continuation.sessionId)) {
      throw new Error('Pi did not restore the requested native session.');
    }
    const continuation = { sessionId: state.sessionId, sessionFile: state.sessionFile };
    await input.onSession?.(continuation);
    checkAbort(input.signal);
    const complete = rpc.wait((event) => event.type === 'agent_settled');
    await rpc.request({ type: 'prompt', message: input.prompt });
    if (input.signal?.aborted) abort();
    input.setMessageHandler?.(async (message) => {
      await rpc.request({ type: 'steer', message });
      return { delivery: 'delivered' };
    });
    await complete;
    parser.finish();
    checkAbort(input.signal);
    if (parser.errorMessage()) throw new Error(parser.errorMessage());
    if (!parser.finalText()) throw new Error('Pi completed without a final assistant message.');
    return { outputText: parser.finalText(), continuation };
  } finally {
    clearTimeout(cancelTimer);
    input.setMessageHandler?.(null);
    input.signal?.removeEventListener('abort', abort);
    await rpc.close();
  }
}
