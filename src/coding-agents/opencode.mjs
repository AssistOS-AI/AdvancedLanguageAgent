import { executionError, requireSandbox, runProcess } from './process.mjs';
import { startOpenCodeServer } from './opencode-server.mjs';
import { executeOpenCodeTurn } from './opencode-turn.mjs';

export async function runOpenCode(input) {
  requireSandbox(input.sandbox);
  const server = await startOpenCodeServer(input);
  try { return await executeOpenCodeTurn(server, input); }
  finally { await server.stop(); }
}

export function parseOpenCodeModels(stdout) {
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
  return stdout.replace(ansi, '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export async function listOpenCodeModels({ binary, cwd, env, signal, sandbox, details = false }) {
  if (details) {
    const server = await startOpenCodeServer({ binary, workspace: cwd, env, signal, sandbox });
    try { return openCodeModelDetails(await server.request('/provider')); }
    finally { await server.stop(); }
  }
  requireSandbox(sandbox);
  const result = await runProcess({ binary, args: ['models'], cwd, env, signal, sandbox });
  if (result.code !== 0) throw executionError('OpenCode model listing', result);
  return parseOpenCodeModels(result.stdout);
}

export function openCodeModelDetails(catalog) {
  return (catalog.all || []).filter((provider) => catalog.connected?.includes(provider.id))
    .flatMap((provider) => Object.values(provider.models || {}).map((model) => ({
      id: provider.id + '/' + model.id, label: model.name || model.id,
      efforts: Object.keys(model.variants || {})
    })));
}
