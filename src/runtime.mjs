import { createSkillRegistry } from './repositories.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';
import { normalizeResult } from './output.mjs';

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
  const registry = await createSkillRegistry(repositories, achillesModule);
  const logger = createDiagnosticLogger(diagnostics, env);
  const selected = runtimeOptions(options, env);
  let agent;
  try {
    agent = new achillesModule.MainAgent({
      startDir: registry.path,
      logger,
      reasoningEffort: selected.reasoningEffort,
      disableInternalSkills: true
    });
    await agent.buildSkills();
  } catch (error) {
    await registry.cleanup();
    throw error;
  }

  return {
    skills: registry.skills,
    async execute(prompt, executionOptions = {}) {
      const common = {
        model: selected.model,
        tags: selected.tags.length > 0 ? selected.tags : null,
        reasoningEffort: selected.reasoningEffort,
        signal: executionOptions.signal || null
      };
      if (options.skill) {
        const record = agent.getSkillRecord(options.skill);
        if (!record) throw new ALAError(`A-Skill not found: ${options.skill}`, EXIT_CODES.repository);
        return agent.executeSkill(record.name, prompt, common);
      }
      return agent.executePrompt(prompt, common);
    },
    cancel(reason = 'cancelled') {
      agent.cancelCurrentSession(reason);
    },
    async close() {
      agent.shutdown();
      await registry.cleanup();
    }
  };
}

export function feedbackPrompt(previousResult, feedback) {
  return `Previous result:\n${normalizeResult(previousResult)}\n\nCorrective feedback:\n${feedback}`;
}
