import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { executionError, requireSandbox, runProcess } from '../../process.mjs';
import { createPiEventParser, listPiModels } from '../pi/runner.mjs';
import { requirePiVersion } from '../pi/version.mjs';

// OMP (Oh My Pi) speaks the Pi stream and RPC protocol. Only its one-shot CLI
// surface differs: prompts ride on -p with --auto-approve and sessions resume
// by identifier, so no native --session-id continuation exists to pin.
export function buildOmpArguments({ prompt, sessionDir, model = null, effort = null }) {
  const args = ['--mode', 'json', '--session-dir', sessionDir];
  if (model) args.push('--model', model);
  if (effort) args.push('--thinking', effort);
  args.push('--auto-approve', '-p', prompt);
  return args;
}

export async function runOmp({
  binary, prompt, workspace, hostWorkspace, model, effort, env, signal, sandbox, onVisibleText
}) {
  requireSandbox(sandbox);
  await requirePiVersion({ binary, workspace, env, signal, sandbox });
  const hostSessionDir = join(hostWorkspace, '.ala-omp-sessions');
  const sessionDir = join(workspace, '.ala-omp-sessions');
  await mkdir(hostSessionDir, { recursive: true, mode: 0o700 });
  const args = buildOmpArguments({ prompt, sessionDir, model, effort });
  const parser = createPiEventParser({ onText: onVisibleText });
  const result = await runProcess({
    binary, args, cwd: workspace, env, signal, sandbox,
    onStdout: parser.push,
    onStderr: (chunk) => onVisibleText?.(chunk.toString('utf8'))
  });
  parser.finish();
  const outputText = parser.finalText();
  if (result.code !== 0) throw executionError('OMP', result);
  if (parser.errorMessage()) throw new Error(`OMP execution failed: ${parser.errorMessage()}`);
  if (!outputText) throw new Error('OMP completed without a final assistant message.');
  return { outputText };
}

export async function listOmpModels(input) {
  // OMP releases dropped Pi's --list-models flag; the RPC catalog is the
  // stable surface shared by every version.
  return listPiModels({ ...input, details: true });
}
