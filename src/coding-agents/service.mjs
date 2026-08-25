import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { listCodexModels, runCodex } from './codex.mjs';
import { listOpenCodeModels, runOpenCode } from './opencode.mjs';
import { listPiModels, runPi } from './pi.mjs';

const adapters = Object.freeze({ codex: runCodex, opencode: runOpenCode, pi: runPi });
const modelAdapters = Object.freeze({ codex: listCodexModels, opencode: listOpenCodeModels, pi: listPiModels });

async function replaceSkillLinks(workspace, skills) {
  const agentsPath = join(workspace, '.agents');
  const skillsPath = join(agentsPath, 'skills');
  await mkdir(agentsPath, { recursive: true, mode: 0o700 });
  const stagedPath = await mkdtemp(join(agentsPath, '.skills-refresh-'));
  const previousPath = join(agentsPath, `.skills-previous-${randomUUID()}`);
  let previousMounted = false;
  try {
    for (const skill of skills) {
      await symlink(
        skill.directoryPath,
        join(stagedPath, skill.name),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    }
    try {
      await rename(skillsPath, previousPath);
      previousMounted = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(stagedPath, skillsPath);
    } catch (error) {
      if (previousMounted) await rename(previousPath, skillsPath);
      throw error;
    }
    if (previousMounted) await rm(previousPath, { recursive: true, force: true }).catch(() => {});
  } finally {
    await rm(stagedPath, { recursive: true, force: true });
  }
}

export function createCodingAgentService({
  agents,
  skills = [],
  models = {},
  websearch = false,
  cwd = process.cwd(),
  env = process.env,
  logger = null,
  runners = adapters,
  modelListers = modelAdapters
}) {
  const available = agents.filter((record) => record.available);
  let activeSkills = skills;
  let workspace = null;
  let activeName = null;
  let continuation = null;
  const configuredModels = { ...models };
  let websearchEnabled = Boolean(websearch);

  async function prepareWorkspace() {
    const nextWorkspace = await mkdtemp(join(tmpdir(), 'ala-agent-'));
    try {
      if (activeSkills.length > 0) await replaceSkillLinks(nextWorkspace, activeSkills);
      workspace = nextWorkspace;
    } catch (error) {
      await rm(nextWorkspace, { recursive: true, force: true });
      throw error;
    }
  }

  function select(requested = 'auto') {
    if (activeName) {
      if (requested !== 'auto' && requested !== activeName) {
        throw new ALAError(`Coding-agent session is already pinned to ${activeName}.`, EXIT_CODES.usage);
      }
      return available.find((record) => record.name === activeName);
    }
    const selected = requested === 'auto'
      ? available[0]
      : available.find((record) => record.name === requested);
    if (!selected) {
      throw new ALAError(`Coding agent is not available: ${requested}`, EXIT_CODES.execution);
    }
    return selected;
  }

  return {
    agents,
    async execute(prompt, { agent = 'auto', signal = null } = {}) {
      const selected = select(agent);
      if (!workspace) await prepareWorkspace();
      activeName = selected.name;
      logger?.debug?.(`coding-agent: backend=${selected.name}, workspace=${workspace}`);
      const result = await runners[selected.name]({
        binary: selected.binary,
        prompt,
        workspace,
        continuation,
        model: configuredModels[selected.name] || null,
        websearch: websearchEnabled,
        env,
        signal
      });
      continuation = result.continuation;
      return result.outputText;
    },
    async listModels(name, { signal = null } = {}) {
      const selected = available.find((record) => record.name === name);
      if (!selected) throw new ALAError(`Coding agent is not available: ${name}`, EXIT_CODES.execution);
      return modelListers[name]({ binary: selected.binary, cwd, env, signal });
    },
    setModel(name, model) {
      if (!['codex', 'opencode', 'pi'].includes(name)) {
        throw new ALAError(`Unknown coding agent: ${name}`, EXIT_CODES.usage);
      }
      configuredModels[name] = model;
    },
    setWebsearch(enabled) {
      websearchEnabled = Boolean(enabled);
    },
    async refreshSkills(nextSkills) {
      if (workspace) await replaceSkillLinks(workspace, nextSkills);
      activeSkills = nextSkills;
    },
    cancel() {},
    async close() {
      if (workspace) await rm(workspace, { recursive: true, force: true });
      workspace = null;
      continuation = null;
      activeName = null;
    }
  };
}
