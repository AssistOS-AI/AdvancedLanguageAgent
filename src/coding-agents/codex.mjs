import { executionError, requireSandbox, runProcess, spawnProcess } from './process.mjs';
import { appendBoundedTail, createLineDecoder } from './streaming.mjs';
import { codexMcpOverrides } from './mcp-servers.mjs';

export function buildCodexArguments({ prompt, continuation = null, model = null, websearch = false, mcpServers = [] }) {
  const common = codexMcpOverrides(mcpServers);
  if (model) common.push('--model', model);
  if (websearch) common.push('--search');
  else common.push('--config', 'web_search="disabled"');
  // ALA already confines Codex with Bubblewrap. Asking Codex to create its own
  // workspace sandbox would require another user namespace and fails in nested
  // container deployments. "danger-full-access" therefore applies only inside
  // ALA's already restricted filesystem and capability boundary.
  common.push('--sandbox', 'danger-full-access', '--ask-for-approval', 'never', 'exec');
  if (continuation?.threadId) {
    return [...common, 'resume', '--json', '--skip-git-repo-check', continuation.threadId, prompt];
  }
  return [...common, '--json', '--skip-git-repo-check', prompt];
}

export function parseCodexOutput(stdout, previousThreadId = '') {
  const parser = createCodexEventParser({ threadId: previousThreadId });
  parser.push(Buffer.from(stdout));
  parser.finish();
  return parser.result();
}

function visibleCodexText(event) {
  if (event?.type === 'item.completed') {
    const item = event.item;
    if (item?.type === 'agent_message') return String(item.text || '');
    if (item?.type === 'command_execution') {
      return String(item.aggregated_output || item.output || item.stdout || '');
    }
  }
  if (event?.type === 'error') {
    return String(event.message || event.error?.message || event.error || '');
  }
  return '';
}

export function createCodexEventParser({ threadId = '', onText = () => {} } = {}) {
  const emit = typeof onText === 'function' ? onText : () => {};
  let resolvedThreadId = threadId;
  let outputText = '';
  let pendingAgentMessage = '';
  const lines = createLineDecoder((line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      emit(`${line}\n`);
      return;
    }
    if (event.type === 'thread.started') {
      resolvedThreadId = String(event.thread_id || event.threadId || '').trim() || resolvedThreadId;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (pendingAgentMessage) emit(pendingAgentMessage);
      pendingAgentMessage = String(event.item.text || '');
      outputText = appendBoundedTail('', pendingAgentMessage);
      return;
    }
    if (pendingAgentMessage && visibleCodexText(event)) {
      emit(pendingAgentMessage);
      pendingAgentMessage = '';
    }
    const visible = visibleCodexText(event);
    if (visible) emit(visible);
  });
  return {
    push: lines.push,
    finish: lines.finish,
    result() {
      return {
        outputText: outputText.trim(),
        continuation: resolvedThreadId ? { threadId: resolvedThreadId } : null
      };
    }
  };
}

export function createCodexStderrParser({ onText = () => {} } = {}) {
  const emit = typeof onText === 'function' ? onText : () => {};
  const lines = createLineDecoder((line) => {
    if (line.trim() === 'Reading additional input from stdin...') return;
    if (line.includes(' ERROR codex_rollout::list: state db returned stale rollout path for thread ')) return;
    emit(`${line}\n`);
  });
  return { push: lines.push, finish: lines.finish };
}

export async function runCodex({
  binary, prompt, workspace, continuation, model, websearch, mcpServers, env, signal, sandbox, onVisibleText
}) {
  requireSandbox(sandbox);
  const parser = createCodexEventParser({ threadId: continuation?.threadId, onText: onVisibleText });
  const stderrParser = createCodexStderrParser({ onText: onVisibleText });
  const result = await runProcess({
    binary,
    args: buildCodexArguments({ prompt, continuation, model, websearch, mcpServers }),
    cwd: workspace,
    env,
    signal,
    sandbox,
    onStdout: parser.push,
    onStderr: stderrParser.push
  });
  parser.finish();
  stderrParser.finish();
  const parsed = parser.result();
  if (result.code !== 0) {
    const error = executionError('Codex', result);
    error.continuation = parsed.continuation;
    throw error;
  }
  if (!parsed.outputText) throw new Error('Codex completed without a final agent message.');
  return parsed;
}

export function listCodexModels({ binary, cwd, env = process.env, signal, sandbox }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      requireSandbox(sandbox);
      child = spawnProcess({
        binary, args: ['app-server', '--stdio'], cwd, env, sandbox, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = '';
    let stderr = '';
    let settled = false;
    let requestId = 1;
    const models = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', abort);
      child.stdin.end();
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      const error = new Error('Coding-agent model listing was interrupted.');
      error.name = 'AbortError';
      finish(error);
    };
    const requestModels = (cursor = null) => {
      requestId += 1;
      child.stdin.write(`${JSON.stringify({
        id: requestId,
        method: 'model/list',
        params: { cursor, limit: 100 }
      })}\n`);
    };
    const handleMessage = (message) => {
      if (message.id === 1) {
        if (message.error) return finish(new Error(`Codex model listing failed: ${message.error.message || 'initialization failed'}`));
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        requestModels();
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) return finish(new Error(`Codex model listing failed: ${message.error.message || 'request failed'}`));
      for (const entry of message.result?.data || []) {
        const model = String(entry?.id || entry?.model || '').trim();
        if (model && !models.includes(model)) models.push(model);
      }
      if (message.result?.nextCursor) requestModels(message.result.nextCursor);
      else finish(null, models);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleMessage(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-65536); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled) finish(new Error(`Codex model listing failed: ${stderr.trim() || `exit code ${code}`}`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    if (!settled) {
      child.stdin.write(`${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'ala', version: '1' } }
      })}\n`);
    }
  });
}
