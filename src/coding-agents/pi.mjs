import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { executionError, runProcess } from './process.mjs';

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('');
  if (value?.type === 'text') return String(value.text || '');
  return '';
}

export function parsePiOutput(stdout) {
  let outputText = '';
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      outputText = contentText(event.message.content);
    }
  }
  return outputText.trim();
}

export function buildPiArguments({ prompt, sessionId, sessionDir }) {
  return [
    '--mode', 'json', '--session-id', sessionId, '--session-dir', sessionDir,
    '--no-context-files', '--approve', prompt
  ];
}

export async function runPi({ binary, prompt, workspace, continuation, env, signal }) {
  const sessionId = continuation?.sessionId || randomUUID();
  const sessionDir = join(workspace, '.ala-pi-sessions');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const args = buildPiArguments({ prompt, sessionId, sessionDir });
  const result = await runProcess({ binary, args, cwd: workspace, env, signal });
  if (result.code !== 0) throw executionError('Pi', result);
  const outputText = parsePiOutput(result.stdout);
  if (!outputText) throw new Error('Pi completed without a final assistant message.');
  return { outputText, continuation: { sessionId } };
}
