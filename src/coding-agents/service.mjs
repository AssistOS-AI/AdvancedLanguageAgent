import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { runCodex } from './codex.mjs';
import { runOpenCode } from './opencode.mjs';
import { runPi } from './pi.mjs';

const adapters = Object.freeze({ codex: runCodex, opencode: runOpenCode, pi: runPi });

export function createCodingAgentService({ agents, skills = [], env = process.env, logger = null, runners = adapters }) {
  const available = agents.filter((record) => record.available);
  let workspace = null;
  let activeName = null;
  let continuation = null;

  async function prepareWorkspace() {
    workspace = await mkdtemp(join(tmpdir(), 'ala-agent-'));
    if (skills.length === 0) return;
    const skillsPath = join(workspace, '.agents', 'skills');
    await mkdir(skillsPath, { recursive: true, mode: 0o700 });
    for (const skill of skills) {
      await symlink(
        skill.directoryPath,
        join(skillsPath, skill.name),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
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
        env,
        signal
      });
      continuation = result.continuation;
      return result.outputText;
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
