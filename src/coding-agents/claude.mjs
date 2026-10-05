import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

import { requireSandbox, runProcess, spawnProcess } from './process.mjs';

// Claude Code runs headless with stream-json on stdin and stdout. Prompts are
// `user` records; permission prompts, interrupts and the model list use the
// control requests the Claude Agent SDK exchanges with the same CLI.
const MINIMUM_VERSION = [2, 1, 0];
const RECORD_LIMIT = 16 * 1024 * 1024;
const prerequisite = `Claude Code >=${MINIMUM_VERSION.join('.')} is required. `
  + 'Install @anthropic-ai/claude-code or configure CLAUDE_BIN to a compatible executable.';

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Coding-agent execution was interrupted.'), { name: 'AbortError' });
}

export async function requireClaudeVersion(input) {
  const result = await runProcess({ binary: input.binary, args: ['--version'], cwd: input.workspace,
    env: input.env, signal: input.signal, sandbox: input.sandbox });
  const version = result.stdout.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const parts = match ? match.slice(1, 4).map(Number) : null;
  const supported = parts && (parts[0] - MINIMUM_VERSION[0] || parts[1] - MINIMUM_VERSION[1]
    || parts[2] - MINIMUM_VERSION[2]) >= 0;
  if (result.code !== 0 || !supported) throw new Error(`Selected Claude Code version ${version || '(unknown)'} is incompatible. ${prerequisite}`);
  return version;
}

export function buildClaudeArguments({ sessionId, resume = false, model = null, effort = null,
  permissionMode = 'full-access', mcpServers = [] }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', resume ? '--resume' : '--session-id', sessionId];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // Full access inside the ALA sandbox; otherwise every permission prompt is
  // answered by the host through the stdio control channel.
  if (permissionMode === 'full-access') args.push('--permission-mode', 'bypassPermissions');
  else args.push('--permission-mode', 'default', '--permission-prompt-tool', 'stdio');
  if (mcpServers.length) {
    const servers = Object.fromEntries(mcpServers.map(({ name, url }) => [name, { type: 'http', url }]));
    args.push('--mcp-config', JSON.stringify({ mcpServers: servers }), '--strict-mcp-config');
  }
  return args;
}

function userRecord(text) {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
}

function openClaudeChannel(input, args) {
  const spawnImpl = input.spawnImpl || spawnProcess;
  if (spawnImpl === spawnProcess) requireSandbox(input.sandbox);
  const events = new EventEmitter();
  const child = spawnImpl({ ...input, args, cwd: input.workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let failure = null;
  let exited = false;
  const exit = new Promise((resolve) => child.on('close', (code, signal) => { exited = true; resolve({ code, signal }); }));
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    events.emit('failure', error);
  };
  child.on('error', fail);
  child.on('close', (code) => fail(Object.assign(new Error(`Claude Code exited${code === null ? '' : ` with ${code}`}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : '.'}`), { code: 'CLAUDE_EXITED' })));
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
  child.stdout.on('data', (chunk) => {
    if (failure) return;
    buffer += decoder.write(chunk);
    if (buffer.length > RECORD_LIMIT) return fail(new Error('Claude Code protocol record too large.'));
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { return fail(new Error('Invalid Claude Code JSON record.')); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) return fail(new Error('Invalid Claude Code JSON record.'));
      if (record.type === 'control_response') {
        const response = record.response || {};
        const entry = pending.get(response.request_id);
        if (!entry) continue;
        pending.delete(response.request_id);
        if (response.subtype === 'success') entry.resolve(response.response || {});
        else entry.reject(new Error(response.error || 'Claude Code rejected a control request.'));
      } else if (record.type === 'control_request') events.emit('control', record);
      else events.emit('record', record);
      if (failure) return;
    }
  });
  const send = (value) => {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    events, send, exit,
    get stderr() { return stderr; },
    control(request, timeoutMs = 30000) {
      if (failure) return Promise.reject(failure);
      const id = `ala-${randomUUID()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Claude Code control request timed out.')); }, timeoutMs);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        send({ type: 'control_request', request_id: id, request });
      });
    },
    respond(requestId, response) {
      send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    },
    respondError(requestId, error) {
      send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
    },
    endInput() { if (!child.stdin.destroyed) child.stdin.end(); },
    async close() {
      if (!child.stdin.destroyed) child.stdin.end();
      if (exited) return;
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exit;
      clearTimeout(timer); clearTimeout(killTimer);
    }
  };
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n');
  return '';
}

// Turns stream-json records into visible text: streamed assistant text keyed by
// the message id, and tool calls and results as plain output.
export function createClaudeOutputParser({ onText }) {
  let messageId = null;
  let textInMessage = false;
  const emit = (text, metadata) => onText?.(text, metadata);
  return {
    push(record) {
      if (record.type === 'stream_event') {
        const event = record.event || {};
        if (event.type === 'message_start') { messageId = event.message?.id || null; textInMessage = false; }
        else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          textInMessage = true;
          emit(event.delta.text, { outputKind: 'assistant', ...(messageId ? { outputId: messageId } : {}) });
        } else if (event.type === 'message_stop' && textInMessage) {
          emit('', { outputKind: 'assistant', ...(messageId ? { outputId: messageId } : {}), outputComplete: true });
          textInMessage = false;
        }
      } else if (record.type === 'assistant') {
        for (const block of record.message?.content || []) {
          if (block?.type !== 'tool_use') continue;
          const input = JSON.stringify(block.input ?? {});
          emit(`${block.name}: ${input.length > 2000 ? `${input.slice(0, 2000)}…` : input}\n`, { outputKind: 'output' });
        }
      } else if (record.type === 'user') {
        for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
          if (block?.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          if (text) emit(text.endsWith('\n') ? text : `${text}\n`, { outputKind: 'output' });
        }
      }
    }
  };
}

function permissionBridge(input, channel, interrupt) {
  const handled = new Map();
  const answer = async (record) => {
    const request = record.request || {};
    if (request.subtype !== 'can_use_tool') {
      channel.respondError(record.request_id, `Unsupported control request: ${request.subtype}`);
      return;
    }
    const tool = String(request.display_name || request.tool_name || 'tool');
    if (!input.permissionRequests) {
      channel.respond(record.request_id, { behavior: 'deny', message: 'No host can approve this operation.' });
      return;
    }
    const result = input.permissionRequests.request({ agent: 'claude', method: 'can_use_tool',
      title: `Claude Code: ${tool}`, message: String(request.description || request.decision_reason || `Allow ${tool}?`),
      detail: JSON.stringify(request.input ?? {}, null, 2),
      options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] },
    { signal: input.signal, onCancel: () => interrupt() });
    handled.set(record.request_id, result.id);
    const optionId = await result;
    handled.delete(record.request_id);
    channel.respond(record.request_id, optionId === 'allow'
      ? { behavior: 'allow', updatedInput: request.input ?? {} }
      : { behavior: 'deny', message: optionId === 'deny' ? 'The user denied this operation.' : 'The approval was cancelled.' });
  };
  const receive = (record) => { answer(record).catch(() => {}); };
  channel.events.on('control', receive);
  return { close() {
    channel.events.off('control', receive);
    for (const id of handled.values()) input.permissionRequests?.cancel(id, 'backend-resolved');
    handled.clear();
  } };
}

export async function runClaude(input) {
  checkAbort(input.signal);
  await requireClaudeVersion(input);
  checkAbort(input.signal);
  const previous = input.continuation?.sessionId;
  if (input.continuation && typeof previous !== 'string') throw new Error('Claude Code continuation has no session id.');
  const sessionId = previous || randomUUID();
  const channel = openClaudeChannel(input, buildClaudeArguments({ sessionId, resume: Boolean(previous),
    model: input.model, effort: input.effort, permissionMode: input.permissionMode, mcpServers: input.mcpServers || [] }));
  const parser = createClaudeOutputParser({ onText: input.onVisibleText });
  let interruptTimer;
  const interrupt = () => {
    void channel.control({ subtype: 'interrupt' }, 5000).catch(() => {});
    interruptTimer ||= setTimeout(() => { void channel.close(); }, 3000);
  };
  const approvals = permissionBridge(input, channel, interrupt);
  // One result per prompt: the turn prompt plus each message delivered while it runs.
  let expectedResults = 1;
  let results = 0;
  let finalText = null;
  let resultError = null;
  let sessionReported = false;
  const done = new Promise((resolve, reject) => {
    channel.events.on('failure', reject);
    channel.events.on('record', (record) => {
      parser.push(record);
      if (record.type === 'system' && record.subtype === 'init' && !sessionReported) {
        if (record.session_id !== sessionId) { reject(new Error('Claude Code did not open the requested session.')); return; }
        sessionReported = true;
        Promise.resolve(input.onSession?.({ sessionId })).catch(reject);
      }
      if (record.type !== 'result') return;
      results += 1;
      if (record.is_error || record.subtype !== 'success') {
        resultError = new Error(`Claude Code turn failed: ${record.result || (record.errors || []).join('; ') || record.subtype}`);
      } else finalText = typeof record.result === 'string' ? record.result : '';
      if (results >= expectedResults) {
        input.setMessageHandler?.(null);
        resolve();
      }
    });
  });
  done.catch(() => {});
  const abort = () => interrupt();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    channel.send(userRecord(input.prompt));
    input.setMessageHandler?.(async (message) => {
      expectedResults += 1;
      channel.send(userRecord(message));
      return { delivery: 'delivered' };
    });
    if (input.signal?.aborted) abort();
    await done;
    checkAbort(input.signal);
    channel.endInput();
    if (resultError) throw resultError;
    if (!finalText) throw new Error('Claude Code completed without a final assistant message.');
    return { outputText: finalText, continuation: { sessionId } };
  } catch (error) {
    if (input.signal?.aborted) checkAbort(input.signal);
    if (sessionReported || previous) error.continuation = { sessionId };
    throw error;
  } finally {
    clearTimeout(interruptTimer);
    input.setMessageHandler?.(null);
    input.signal?.removeEventListener('abort', abort);
    approvals.close();
    await channel.close();
  }
}

// The model list comes from the CLI's initialize control response, without a
// model call.
export async function listClaudeModels(input) {
  checkAbort(input.signal);
  const channel = openClaudeChannel({ ...input, workspace: input.workspace || input.cwd },
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  const abort = () => { void channel.close(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await channel.control({ subtype: 'initialize' });
    if (!Array.isArray(response.models)) throw new Error(`Claude Code did not report its models. ${prerequisite}`);
    const models = response.models.filter((model) => typeof model?.value === 'string' && model.value);
    return input.details
      ? models.map((model) => ({ id: model.value, label: model.displayName || model.value,
        efforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((level) => typeof level === 'string') : [] }))
      : models.map((model) => model.value);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await channel.close();
  }
}
