import { createCodingAgentService } from './coding-agents/service.mjs';
import { applyCodingAgentOverrides } from './config.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';
import { normalizeResult } from './output.mjs';
import { createPermissionRequestManager, validatePermissionMode } from './permission-requests.mjs';

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

// Every execution runs on a coding-agent backend; ALA has no direct model route.
export async function createRuntime({
  codingAgents = [],
  codingAgentModels = {},
  codingAgentEfforts = {},
  workspace = null,
  workspaceTarget = null,
  home = null,
  mcpServers = null,
  defaultCodingAgent = null,
  permissionMode = 'full-access',
  cwd = process.cwd(),
  options,
  env = process.env,
  diagnostics = process.stderr,
  eventSink = null,
  sessionState = null
}) {
  validatePermissionMode(permissionMode);
  const logger = createDiagnosticLogger(diagnostics, env);
  const permissionRequests = createPermissionRequestManager({ eventSink, logger });
  // The configured default agent when it is installed, otherwise the first available.
  const preferredAgent = () => codingAgents.find((record) => record.available && record.name === defaultCodingAgent)
    || codingAgents.find((record) => record.available);
  const overrideAgent = options.agent === 'auto'
    ? sessionState?.record.agent || preferredAgent()?.name
    : options.agent;
  const { models: invocationModels, efforts: invocationEfforts } = applyCodingAgentOverrides(
    { models: codingAgentModels, efforts: codingAgentEfforts },
    { agent: overrideAgent, model: options.model, effort: options.effort }
  );
  const codingAgentService = createCodingAgentService({
    agents: codingAgents,
    workspace,
    workspaceTarget,
    home,
    folders: options.folders,
    ignoredPaths: options.ignoredPaths,
    mcpServers,
    models: invocationModels,
    efforts: invocationEfforts,
    defaultAgent: defaultCodingAgent,
    permissionMode,
    permissionRequests,
    cwd,
    env,
    logger,
    eventSink,
    sessionState
  });
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
    setCodingAgentEffort(name, effort) {
      codingAgentService.setEffort(name, effort);
    },
    setDefaultCodingAgent(name) {
      codingAgentService.setDefaultAgent(name);
      defaultCodingAgent = name;
    },
    setPermissionMode(mode) {
      codingAgentService.setPermissionMode(mode);
    },
    setCodingAgentOutputSink(outputSink) {
      codingAgentService.setOutputSink(outputSink);
    },
    async executeAgent(prompt, { agent = 'auto', signal = null } = {}) {
      const selectedAgent = agent === 'auto'
        ? preferredAgent()
        : codingAgents.find((record) => record.name === agent && record.available);
      if (!selectedAgent) throw new ALAError(`Coding agent is not available: ${agent}`, EXIT_CODES.execution);
      return codingAgentService.execute(prompt, { agent, signal });
    },
    async execute(prompt, executionOptions = {}) {
      return codingAgentService.execute(prompt, { agent: options.agent || 'auto', signal: executionOptions.signal || null });
    },
    cancel(reason = 'cancelled') {
      codingAgentService.cancel(reason);
    },
    async close() {
      permissionRequests.setReplyCapability(false);
      await codingAgentService.close();
    }
  };
}

export function feedbackPrompt(previousResult, feedback) {
  return `Previous result:\n${normalizeResult(previousResult)}\n\nCorrective feedback:\n${feedback}`;
}
