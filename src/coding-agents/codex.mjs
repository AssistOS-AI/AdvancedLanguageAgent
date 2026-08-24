import { spawn } from 'node:child_process';

import { executionError, runProcess } from './process.mjs';

export function buildCodexArguments({ prompt, continuation = null, model = null }) {
  const common = [];
  if (model) common.push('--model', model);
  common.push('--sandbox', 'workspace-write', '--ask-for-approval', 'never', 'exec');
  if (continuation?.threadId) {
    return [...common, 'resume', '--json', '--skip-git-repo-check', continuation.threadId, prompt];
  }
  return [...common, '--json', '--skip-git-repo-check', prompt];
}

export function parseCodexOutput(stdout, previousThreadId = '') {
  let threadId = previousThreadId;
  let outputText = '';
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = String(event.thread_id || event.threadId || '').trim();
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      outputText = String(event.item.text || '');
    }
  }
  return { outputText: outputText.trim(), continuation: threadId ? { threadId } : null };
}

export async function runCodex({ binary, prompt, workspace, continuation, model, env, signal }) {
  const result = await runProcess({
    binary,
    args: buildCodexArguments({ prompt, continuation, model }),
    cwd: workspace,
    env,
    signal
  });
  if (result.code !== 0) throw executionError('Codex', result);
  const parsed = parseCodexOutput(result.stdout, continuation?.threadId);
  if (!parsed.outputText) throw new Error('Codex completed without a final agent message.');
  return parsed;
}

export function listCodexModels({ binary, cwd, env = process.env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
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
