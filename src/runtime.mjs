import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodingAgentService } from './coding-agents/service.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';
import { normalizeResult } from './output.mjs';
import { createPermissionRequestManager, validatePermissionMode } from './permission-requests.mjs';

const internalSkillsDirectory = fileURLToPath(new URL('./internal-skills', import.meta.url));

export function createDiagnosticLogger(stream = process.stderr, env = process.env) {
  const debugEnabled = env.ALA_DEBUG === '1' || env.ALA_DEBUG === 'true';
  return {
    debug(message) { if (debugEnabled) stream.write(`[debug] ${message}\n`); },
    info(message) { if (debugEnabled) stream.write(`[info] ${message}\n`); },
    log(message) { if (debugEnabled) stream.write(`[info] ${message}\n`); },
    warn(message) { stream.write(`[warning] ${message}\n`); },
    error(message) { stream.write(`[error] ${message}\n`); }
  };
}

function runtimeOptions(options, env) {
  const envTags = env.ALA_TAGS ? env.ALA_TAGS.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
  return {
    model: options.model || env.ALA_MODEL || null,
    tags: options.tags.length > 0 ? options.tags : envTags,
    reasoningEffort: options.reasoningEffort || env.ALA_REASONING_EFFORT || null
  };
}

// ALA ships one internal code skill that delegates an execution to the selected
// coding-agent backend. MainAgent discovers it through a temporary registry, so
// no caller-owned skill layout is ever inspected or mounted as a task catalog.
async function createInternalSkillRegistry() {
  const registryPath = await mkdtemp(resolve(tmpdir(), 'ala-skills-'));
  try {
    const wrapperPath = resolve(registryPath, 'source-0');
    await mkdir(wrapperPath);
    await symlink(internalSkillsDirectory, resolve(wrapperPath, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    await rm(registryPath, { recursive: true, force: true });
    throw error;
  }
  return {
    path: registryPath,
    async cleanup() { await rm(registryPath, { recursive: true, force: true }); }
  };
}

export async function createRuntime({
  achillesModule,
  codingAgents = [],
  codingAgentModels = {},
  codingAgentEfforts = {},
  workspace = null,
  workspaceTarget = null,
  home = null,
  mcpServers = null,
  websearch = false,
  permissionMode = 'full-access',
  cwd = process.cwd(),
  options,
  env = process.env,
  diagnostics = process.stderr,
  eventSink = null,
  sessionState = null
}) {
  validatePermissionMode(permissionMode);
  if (typeof achillesModule.MainAgent !== 'function' || typeof achillesModule.discoverSkills !== 'function') {
    throw new ALAError(
      'Resolved AchillesAgentLib does not expose MainAgent and discoverSkills.',
      EXIT_CODES.repository
    );
  }
  const logger = createDiagnosticLogger(diagnostics, env);
  const permissionRequests = createPermissionRequestManager({ eventSink, logger });
  const registry = await createInternalSkillRegistry();
  const invocationModels = { ...codingAgentModels };
  const invocationEfforts = { ...codingAgentEfforts };
  if (options.agent && options.model) {
    const selectedAgent = options.agent === 'auto'
      ? sessionState?.record.agent || codingAgents.find((record) => record.available)?.name
      : options.agent;
    if (selectedAgent) {
      if (options.model !== invocationModels[selectedAgent]) delete invocationEfforts[selectedAgent];
      invocationModels[selectedAgent] = options.model;
    }
  }
  const codingAgentService = createCodingAgentService({
    agents: codingAgents,
    workspace,
    workspaceTarget,
    home,
    folders: options.folders,
    mcpServers,
    models: invocationModels,
    efforts: invocationEfforts,
    websearch,
    permissionMode,
    permissionRequests,
    cwd,
    env,
    logger,
    eventSink,
    sessionState
  });
  const selected = runtimeOptions(options, env);
  let mainAgent;
  try {
    mainAgent = new achillesModule.MainAgent({
      startDir: registry.path,
      logger,
      reasoningEffort: selected.reasoningEffort,
      disableInternalSkills: true,
      supervisor: {
        async approve() { return 'approve'; },
        getOutputWriter() {
          return {
            async write(message) {
              if (message?.type !== 'tool_reason') return;
              const tool = String(message.tool || '').trim();
              const reason = String(message.reason || '').trim();
              if (tool && reason) eventSink?.({ type: 'agentlib-tool', tool, reason });
            }
          };
        }
      }
    });
    await mainAgent.buildSkills();
  } catch (error) {
    await registry.cleanup();
    await codingAgentService.close();
    throw error;
  }

  return {
    codingAgents,
    permissionRequests,
    sendMessage(message) { return codingAgentService.sendMessage(message); },
    listCodingAgents() {
      return codingAgents.filter((record) => record.available).map((record) => record.name);
    },
    listCodingAgentModels(name, options = {}) {
      return codingAgentService.listModels(name, options);
    },
    setCodingAgentModel(name, model) {
      codingAgentService.setModel(name, model);
    },
    setWebsearch(enabled) {
      codingAgentService.setWebsearch(enabled);
    },
    setPermissionMode(mode) {
      codingAgentService.setPermissionMode(mode);
    },
    setCodingAgentOutputSink(outputSink) {
      codingAgentService.setOutputSink(outputSink);
    },
    async executeAgent(prompt, { agent = 'auto', signal = null } = {}) {
      const selectedAgent = agent === 'auto'
        ? codingAgents.find((record) => record.available)
        : codingAgents.find((record) => record.name === agent && record.available);
      if (!selectedAgent) throw new ALAError(`Coding agent is not available: ${agent}`, EXIT_CODES.execution);
      return mainAgent.executeSkill('coding-agent', prompt, {
        signal,
        context: { codingAgentService, codingAgentPreference: agent }
      });
    },
    async execute(prompt, executionOptions = {}) {
      const common = {
        model: selected.model,
        tags: selected.tags.length > 0 ? selected.tags : null,
        reasoningEffort: selected.reasoningEffort,
        signal: executionOptions.signal || null,
        context: {
          codingAgentService,
          codingAgentPreference: options.agent || 'auto'
        }
      };
      if (options.agent || options.folders?.length) {
        return mainAgent.executeSkill('coding-agent', prompt, common);
      }
      return mainAgent.executePrompt(prompt, common);
    },
    cancel(reason = 'cancelled') {
      codingAgentService.cancel(reason);
      mainAgent.cancelCurrentSession(reason);
    },
    async close() {
      permissionRequests.setReplyCapability(false);
      mainAgent.shutdown();
      await codingAgentService.close();
      await registry.cleanup();
    }
  };
}

export function feedbackPrompt(previousResult, feedback) {
  return `Previous result:\n${normalizeResult(previousResult)}\n\nCorrective feedback:\n${feedback}`;
}
