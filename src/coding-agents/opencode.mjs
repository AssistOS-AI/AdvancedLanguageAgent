import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { executionError, requireSandbox, runProcess } from './process.mjs';
import { appendBoundedTail } from './streaming.mjs';

const SEMANTIC_FAILURE_PATTERNS = Object.freeze([
  /permission requested:\s*external_directory/iu,
  /auto-rejecting/iu,
  /the user rejected permission/iu,
  /read \. failed/iu
]);

function textFromEvent(event) {
  if (event?.type === 'text') return String(event.part?.text || event.text || '');
  if (event?.type === 'message' && event.role === 'assistant') return String(event.content || '');
  return '';
}

export function parseOpenCodeOutput(stdout) {
  let outputText = '';
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const text = textFromEvent(JSON.parse(line));
      if (text) outputText += text;
    } catch {
      outputText += `${line}\n`;
    }
  }
  return outputText.trim();
}

export function buildOpenCodeArguments({ prompt, workspace, sessionId = null, title = null, model = null }) {
  const args = ['run', '--auto', '--dir', workspace];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--session', sessionId);
  if (title) args.push('--title', title);
  args.push(prompt);
  return args;
}

async function findSession(binary, workspace, title, env, signal, sandbox) {
  const result = await runProcess({
    binary,
    args: ['session', 'list', '--format', 'json', '--max-count', '1000'],
    cwd: workspace,
    env,
    signal,
    sandbox
  });
  if (result.code !== 0) return null;
  try {
    const sessions = JSON.parse(result.stdout);
    const expected = resolve(workspace);
    const match = sessions.find((entry) => (
      entry?.title === title && resolve(String(entry?.directory || '')) === expected
    ));
    return String(match?.id || '').trim() || null;
  } catch {
    return null;
  }
}

async function findSessionFromDatabase(workspace, title, env, signal, sandbox) {
  const script = `
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
const database = new DatabaseSync(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'), { readOnly: true });
try {
  const row = database.prepare('SELECT id FROM session WHERE title = ? AND directory = ? ORDER BY time_updated DESC LIMIT 1')
    .get(process.argv[1], resolve(process.argv[2]));
  if (row?.id) process.stdout.write(String(row.id));
} finally {
  database.close();
}`;
  try {
    const result = await runProcess({
      binary: process.execPath,
      args: ['--input-type=module', '-e', script, title, workspace],
      cwd: workspace,
      env,
      signal,
      sandbox
    });
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function resolveSession(binary, workspace, title, env, signal, sandbox) {
  return await findSession(binary, workspace, title, env, signal, sandbox)
    || await findSessionFromDatabase(workspace, title, env, signal, sandbox);
}

async function exportSession(binary, workspace, sessionId, env, signal, sandbox) {
  const result = await runProcess({
    binary,
    args: ['export', sessionId],
    cwd: workspace,
    env,
    signal,
    sandbox
  });
  if (result.code !== 0) throw executionError('OpenCode session export', result);
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) throw new Error('OpenCode returned an invalid session export.');
  try {
    return JSON.parse(result.stdout.slice(jsonStart));
  } catch {
    throw new Error('OpenCode returned an invalid session export.');
  }
}

async function finalSessionText(binary, workspace, sessionId, env, signal, sandbox) {
  const exported = await exportSession(binary, workspace, sessionId, env, signal, sandbox);
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  const assistant = messages.findLast((message) => message?.info?.role === 'assistant');
  if (!assistant || !Array.isArray(assistant.parts)) return '';
  return appendBoundedTail('', assistant.parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')).trim();
}

export function detectOpenCodeSemanticFailure(result) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  return SEMANTIC_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

export async function configureOpenCodeWebsearch(workspace, websearch) {
  const policy = websearch ? 'allow' : 'deny';
  await writeFile(join(workspace, 'opencode.json'), `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: { websearch: policy, webfetch: policy }
  }, null, 2)}\n`, { mode: 0o600 });
}

export function openCodeEnvironment(env, websearch) {
  return { ...env, OPENCODE_ENABLE_EXA: websearch ? '1' : '0' };
}

export async function runOpenCode({
  binary, prompt, workspace, hostWorkspace, continuation, model, websearch, env, signal, sandbox, onVisibleText
}) {
  requireSandbox(sandbox);
  await configureOpenCodeWebsearch(hostWorkspace, websearch);
  const executionEnv = openCodeEnvironment(env, websearch);
  const title = continuation?.sessionId ? null : `ala-${randomUUID()}`;
  const args = buildOpenCodeArguments({ prompt, workspace, sessionId: continuation?.sessionId, title, model });
  const result = await runProcess({
    binary, args, cwd: workspace, env: executionEnv, signal, sandbox,
    onStdout: (chunk) => onVisibleText?.(chunk.toString('utf8')),
    onStderr: (chunk) => onVisibleText?.(chunk.toString('utf8'))
  });
  const sessionId = continuation?.sessionId
    || await resolveSession(binary, workspace, title, executionEnv, signal, sandbox);
  const semanticFailure = detectOpenCodeSemanticFailure(result);
  if (result.code !== 0 || semanticFailure) {
    const error = result.code !== 0
      ? executionError('OpenCode', result)
      : new Error('OpenCode execution failed despite returning exit code 0.');
    error.continuation = sessionId ? { sessionId } : null;
    throw error;
  }
  if (!sessionId) throw new Error('OpenCode completed without a resumable session identifier.');
  let outputText = '';
  try {
    outputText = await finalSessionText(binary, workspace, sessionId, executionEnv, signal, sandbox);
  } catch {
    outputText = parseOpenCodeOutput(result.stdout) || result.stdout.trim();
  }
  if (!outputText) throw new Error('OpenCode completed without a final response.');
  return {
    outputText,
    continuation: { sessionId }
  };
}

export function parseOpenCodeModels(stdout) {
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
  return stdout.replace(ansi, '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export async function listOpenCodeModels({ binary, cwd, env, signal, sandbox }) {
  requireSandbox(sandbox);
  const result = await runProcess({ binary, args: ['models'], cwd, env, signal, sandbox });
  if (result.code !== 0) throw executionError('OpenCode model listing', result);
  return parseOpenCodeModels(result.stdout);
}
