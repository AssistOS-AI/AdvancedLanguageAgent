import { executionError, requireSandbox, runProcess } from '../../process.mjs';
import { startOpenCodeServer } from './server.mjs';
import { executeOpenCodeTurn } from './turn.mjs';
import { executeOpenCodeV2Turn } from './v2-turn.mjs';
import { openCodeV2Models } from './v2-contract.mjs';

export async function runOpenCode(input) {
  requireSandbox(input.sandbox);
  const server = await startOpenCodeServer(input);
  try { return await (!server.version.startsWith('1.') ? executeOpenCodeV2Turn : executeOpenCodeTurn)(server, input); }
  finally { await server.stop(); }
}

export function parseOpenCodeModels(stdout) {
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
  return stdout.replace(ansi, '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export async function listOpenCodeModels({ binary, cwd, env, signal, sandbox, details = false }) {
  if (details) {
    const server = await startOpenCodeServer({ binary, workspace: cwd, env, signal, sandbox });
    try {
      if (server.version.startsWith('1.')) return openCodeModelDetails(await server.request('/provider'));
      const plugins = await server.request('/api/plugin');
      if (plugins.data?.some(plugin => plugin.state?.status === 'failed')) {
        throw new Error('OpenCode plugin initialization failed; model catalog is unavailable.');
      }
      return openCodeV2Models(await server.request('/api/model'));
    }
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
