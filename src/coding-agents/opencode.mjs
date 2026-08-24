import { randomUUID } from 'node:crypto';

import { executionError, runProcess } from './process.mjs';

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
  const args = ['run', '--auto', '--format', 'json', '--dir', workspace];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--session', sessionId);
  if (title) args.push('--title', title);
  args.push(prompt);
  return args;
}

async function findSession(binary, workspace, title, env, signal) {
  const result = await runProcess({
    binary,
    args: ['session', 'list', '--format', 'json', '--max-count', '1000'],
    cwd: workspace,
    env,
    signal
  });
  if (result.code !== 0) return null;
  try {
    const sessions = JSON.parse(result.stdout);
    return String(sessions.find((entry) => entry?.title === title)?.id || '').trim() || null;
  } catch {
    return null;
  }
}

export async function runOpenCode({ binary, prompt, workspace, continuation, model, env, signal }) {
  const title = continuation?.sessionId ? null : `ala-${randomUUID()}`;
  const args = buildOpenCodeArguments({ prompt, workspace, sessionId: continuation?.sessionId, title, model });
  const result = await runProcess({ binary, args, cwd: workspace, env, signal });
  if (result.code !== 0) throw executionError('OpenCode', result);
  const sessionId = continuation?.sessionId || await findSession(binary, workspace, title, env, signal);
  if (!sessionId) throw new Error('OpenCode completed without a resumable session identifier.');
  const outputText = parseOpenCodeOutput(result.stdout);
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

export async function listOpenCodeModels({ binary, cwd, env, signal }) {
  const result = await runProcess({ binary, args: ['models'], cwd, env, signal });
  if (result.code !== 0) throw executionError('OpenCode model listing', result);
  return parseOpenCodeModels(result.stdout);
}
