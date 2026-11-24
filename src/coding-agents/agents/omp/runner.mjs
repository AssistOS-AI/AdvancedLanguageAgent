import { fullAccessPolicy } from '../../native-interactive.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { executionError, requireSandbox, runProcess } from '../../process.mjs';
import { createPiEventParser } from '../pi/runner.mjs';
import { requirePiVersion } from '../pi/version.mjs';

// OMP (Oh My Pi) speaks the Pi stream and RPC protocol. Only its one-shot CLI
// surface differs: prompts ride on -p with --auto-approve and sessions resume
// by identifier, so no native --session-id continuation exists to pin.
export function buildOmpArguments({ prompt, sessionDir, model = null, effort = null }) {
  const args = ['--mode', 'json', '--session-dir', sessionDir];
  if (model) args.push('--model', model);
  if (effort) args.push('--thinking', effort);
  args.push(...fullAccessPolicy('omp').args, '-p', prompt);
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

const MODEL_CATALOG_LIMIT = 32 * 1024 * 1024;

// One OMP catalog entry as ALA's model detail: the selector OMP accepts in --model, its display name, and the
// thinking levels it accepts in --thinking when it reasons.
export function ompModelDetails(model) {
  const id = typeof model?.selector === 'string' && model.selector ? model.selector : `${model?.provider}/${model?.id}`;
  return {
    id,
    label: typeof model?.name === 'string' && model.name ? model.name : String(model?.id || id),
    efforts: model?.reasoning && Array.isArray(model.thinking)
      ? model.thinking.filter((level) => typeof level === 'string' && /^[A-Za-z0-9_-]+$/u.test(level)) : []
  };
}

export function parseOmpModels(text) {
  let catalog;
  try { catalog = JSON.parse(text); } catch { throw new Error('OMP returned an invalid model catalog.'); }
  const models = Array.isArray(catalog?.models) ? catalog.models : Array.isArray(catalog) ? catalog : null;
  if (!models) throw new Error('OMP returned an invalid model catalog.');
  return models.filter((model) => model && typeof model === 'object' && (model.kind === undefined || model.kind === 'chat')
    && typeof model.provider === 'string' && typeof model.id === 'string').map(ompModelDetails);
}

// OMP answers its RPC model request in one frame of at most 1 MiB, which a full catalog exceeds, and its releases
// dropped Pi's --list-models flag. `omp models --json` prints the same chat catalog without a frame limit, so it is
// read whole here instead of through the bounded tail that ordinary process output keeps.
export async function listOmpModels({ binary, cwd, env, signal, sandbox }) {
  requireSandbox(sandbox);
  const chunks = [];
  let size = 0;
  let oversized = false;
  const result = await runProcess({
    binary, args: ['models', '--json', '--no-extensions'], cwd, env, signal, sandbox,
    onStdout: (chunk) => {
      size += chunk.length;
      if (size > MODEL_CATALOG_LIMIT) oversized = true;
      else chunks.push(Buffer.from(chunk));
    }
  });
  if (result.code !== 0) throw executionError('OMP model listing', result);
  if (oversized) throw new Error('OMP model catalog is too large.');
  return parseOmpModels(Buffer.concat(chunks).toString('utf8'));
}
