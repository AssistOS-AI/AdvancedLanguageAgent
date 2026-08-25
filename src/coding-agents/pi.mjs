import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { executionError, requireSandbox, runProcess } from './process.mjs';
import { appendBoundedTail, contentText, createLineDecoder, unseenText } from './streaming.mjs';

export function parsePiOutput(stdout) {
  const parser = createPiEventParser();
  parser.push(Buffer.from(stdout));
  parser.finish();
  return parser.finalText();
}

function assistantError(message) {
  if (!message || message.role !== 'assistant' || message.stopReason !== 'error') return '';
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
  return [message.errorMessage, message.error?.message,
    ...diagnostics.map((entry) => entry?.errorMessage),
    ...diagnostics.map((entry) => entry?.error?.message)]
    .find((value) => typeof value === 'string' && value.trim())?.trim()
    || 'Pi assistant stopped with an error.';
}

export function createPiEventParser({ onText = () => {} } = {}) {
  const emit = typeof onText === 'function' ? onText : () => {};
  const toolOutput = new Map();
  let currentAssistantText = '';
  let finalAssistantText = '';
  let errorMessage = '';
  const lines = createLineDecoder((line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      emit(`${line}\n`);
      return;
    }
    if (event?.type === 'message_start' && event.message?.role === 'assistant') {
      currentAssistantText = '';
      return;
    }
    if (event?.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        currentAssistantText = appendBoundedTail(currentAssistantText, update.delta);
        emit(update.delta);
      }
      return;
    }
    if (event?.type === 'message_end' && event.message?.role === 'assistant') {
      const complete = contentText(event.message.content);
      const suffix = unseenText(currentAssistantText, complete);
      if (suffix) emit(suffix);
      if (complete) finalAssistantText = appendBoundedTail('', complete);
      errorMessage ||= assistantError(event.message);
      currentAssistantText = '';
      return;
    }
    if (event?.type === 'tool_execution_update' || event?.type === 'tool_execution_end') {
      const id = String(event.toolCallId || '');
      const previous = toolOutput.get(id) || '';
      const value = event.type === 'tool_execution_update' ? event.partialResult : event.result;
      const complete = contentText(value);
      const suffix = unseenText(previous, complete);
      if (suffix) emit(suffix);
      if (event.type === 'tool_execution_end') toolOutput.delete(id);
      else toolOutput.set(id, appendBoundedTail(previous, suffix));
    }
  });
  return {
    push: lines.push,
    finish: lines.finish,
    finalText: () => finalAssistantText.trim(),
    errorMessage: () => errorMessage
  };
}

export function buildPiArguments({ prompt, sessionId, sessionDir, model = null }) {
  const args = [
    '--mode', 'json', '--session-id', sessionId, '--session-dir', sessionDir,
    '--no-context-files'
  ];
  if (model) args.push('--model', model);
  args.push('--approve', prompt);
  return args;
}

export async function runPi({
  binary, prompt, workspace, hostWorkspace, continuation, model, env, signal, sandbox, onVisibleText
}) {
  requireSandbox(sandbox);
  const sessionId = continuation?.sessionId || randomUUID();
  const hostSessionDir = join(hostWorkspace, '.ala-pi-sessions');
  const sessionDir = join(workspace, '.ala-pi-sessions');
  await mkdir(hostSessionDir, { recursive: true, mode: 0o700 });
  const args = buildPiArguments({ prompt, sessionId, sessionDir, model });
  const parser = createPiEventParser({ onText: onVisibleText });
  const result = await runProcess({
    binary, args, cwd: workspace, env, signal, sandbox,
    onStdout: parser.push,
    onStderr: (chunk) => onVisibleText?.(chunk.toString('utf8'))
  });
  parser.finish();
  const outputText = parser.finalText();
  if (result.code !== 0 || parser.errorMessage()) {
    const error = result.code !== 0
      ? executionError('Pi', result)
      : new Error(`Pi execution failed: ${parser.errorMessage()}`);
    error.continuation = { sessionId };
    throw error;
  }
  if (!outputText) throw new Error('Pi completed without a final assistant message.');
  return { outputText, continuation: { sessionId } };
}

export function parsePiModels(stdout) {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines[0]?.startsWith('provider')) lines.shift();
  return lines.map((line) => {
    const [provider, model] = line.split(/\s+/u);
    return provider && model ? `${provider}/${model}` : '';
  }).filter(Boolean);
}

export async function listPiModels({ binary, cwd, env, signal, sandbox }) {
  requireSandbox(sandbox);
  const result = await runProcess({ binary, args: ['--list-models'], cwd, env, signal, sandbox });
  if (result.code !== 0) throw executionError('Pi model listing', result);
  return parsePiModels(result.stdout);
}
