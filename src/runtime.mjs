import { fileURLToPath } from 'node:url';

import { createCodingAgentService } from './coding-agents/service.mjs';
import { createSkillRegistry } from './repositories.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';
import { normalizeResult } from './output.mjs';
import { createSymbolicRouter } from './routing/symbolic.mjs';

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

export async function createRuntime({
  achillesModule,
  repositories,
  codingAgents = [],
  options,
  env = process.env,
  diagnostics = process.stderr
}) {
  if (typeof achillesModule.MainAgent !== 'function' || typeof achillesModule.discoverSkills !== 'function') {
    throw new ALAError(
      'Resolved AchillesAgentLib does not expose MainAgent and discoverSkills.',
      EXIT_CODES.repository
    );
  }
  const logger = createDiagnosticLogger(diagnostics, env);
  const codingAgentService = createCodingAgentService({ agents: codingAgents, env, logger });
  const registry = await createSkillRegistry(repositories, achillesModule, {
    builtInSkillsDirectories: codingAgents.some((record) => record.available) ? [internalSkillsDirectory] : []
  });
  const symbolicRouter = await createSymbolicRouter(registry.skills);
  const selected = runtimeOptions(options, env);
  let mainAgent;
  try {
    mainAgent = new achillesModule.MainAgent({
      startDir: registry.path,
      logger,
      reasoningEffort: selected.reasoningEffort,
      disableInternalSkills: true
    });
    await mainAgent.buildSkills();
  } catch (error) {
    await registry.cleanup();
    await codingAgentService.close();
    throw error;
  }

  return {
    skills: registry.skills,
    codingAgents,
    symbolicDetectionEnabled: false,
    setSymbolicDetection(enabled) { this.symbolicDetectionEnabled = Boolean(enabled); },
    getSymbolicDetection() { return this.symbolicDetectionEnabled; },
    listCodingAgents() {
      return codingAgents.filter((record) => record.available).map((record) => record.name);
    },
    async executeAgent(prompt, { agent = 'auto', signal = null } = {}) {
      const selected = agent === 'auto'
        ? codingAgents.find((record) => record.available)
        : codingAgents.find((record) => record.name === agent && record.available);
      if (!selected) throw new ALAError(`Coding agent is not available: ${agent}`, EXIT_CODES.execution);
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
      if (options.agent) return mainAgent.executeSkill('coding-agent', prompt, common);
      if (options.skill) {
        const record = mainAgent.getSkillRecord(options.skill);
        if (!record) throw new ALAError(`Task skill not found: ${options.skill}`, EXIT_CODES.repository);
        return mainAgent.executeSkill(record.name, prompt, common);
      }
      if (this.symbolicDetectionEnabled) {
        const decision = symbolicRouter.route(executionOptions.instruction || prompt);
        if (decision.skill && ['DETERMINISTIC', 'HIGH'].includes(decision.state)) {
          return mainAgent.executeSkill(decision.skill, prompt, common);
        }
      }
      return mainAgent.executePrompt(prompt, common);
    },
    cancel(reason = 'cancelled') {
      mainAgent.cancelCurrentSession(reason);
    },
    async close() {
      mainAgent.shutdown();
      await codingAgentService.close();
      await registry.cleanup();
    }
  };
}

export function feedbackPrompt(previousResult, feedback) {
  return `Previous result:\n${normalizeResult(previousResult)}\n\nCorrective feedback:\n${feedback}`;
}
