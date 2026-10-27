import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ALAError, EXIT_CODES } from './errors.mjs';
import { discoverCodingAgents, discoverProviderAgents } from './coding-agents/discovery.mjs';
import { createCodingAgentService } from './coding-agents/service.mjs';
import { resolveVirtualHome } from './coding-agents/virtual-paths.mjs';
import { createDiagnosticLogger } from './runtime.mjs';

// Lists one agent's native model catalog, the same query as the interactive /agent <name> models, without opening
// a conversation. The query runs through the execution provider with a private temporary working directory: the
// standalone provider's directory is removed afterwards, and an embedding provider's belongs to its execution.
// --json returns each model with the efforts it advertises, so hosts can offer valid choices.
export async function listAgentModels(options, io, env, handle) {
  const embedded = handle.embedded;
  const home = embedded ? resolveVirtualHome(options.home)
    : options.home ? await realpath(resolve(io.cwd, options.home)) : null;
  if (home && !embedded && !(await stat(home)).isDirectory()) {
    throw new ALAError('--home must reference an existing directory.', EXIT_CODES.usage);
  }
  const agentEnv = home && !embedded ? { ...env, HOME: home, CODEX_HOME: resolve(home, '.codex') } : env;
  const agents = embedded ? await discoverProviderAgents(handle.get()) : await discoverCodingAgents({ env: agentEnv });
  if (!agents.some((agent) => agent.name === options.agent && agent.available)) {
    throw new ALAError(`Coding agent is not available: ${options.agent}`, EXIT_CODES.execution);
  }
  const workspace = embedded ? null : await mkdtemp(join(tmpdir(), 'ala-models-'));
  const controller = new AbortController();
  const interrupt = () => controller.abort(new ALAError('Interrupted', EXIT_CODES.interrupted));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const service = createCodingAgentService({ agents, workspace, home, provider: handle.get(), cwd: workspace || io.cwd,
    env: agentEnv, logger: createDiagnosticLogger(io.stderr, env) });
  try {
    const models = (await service.listModels(options.agent, { signal: controller.signal, details: true }))
      .map((entry) => typeof entry === 'string' ? { id: entry, efforts: [] }
        : { id: entry.id, efforts: entry.efforts || [], ...(entry.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}) });
    if (options.json) io.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    else io.stdout.write(models.map((model) => `${model.id}\n`).join(''));
    return EXIT_CODES.success;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await service.close();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
