import { executionError, runProcess } from './process.mjs';

export function buildCodexArguments({ prompt, continuation = null }) {
  const common = ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', 'exec'];
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

export async function runCodex({ binary, prompt, workspace, continuation, env, signal }) {
  const result = await runProcess({
    binary,
    args: buildCodexArguments({ prompt, continuation }),
    cwd: workspace,
    env,
    signal
  });
  if (result.code !== 0) throw executionError('Codex', result);
  const parsed = parseCodexOutput(result.stdout, continuation?.threadId);
  if (!parsed.outputText) throw new Error('Codex completed without a final agent message.');
  return parsed;
}
