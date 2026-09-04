import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { listCodexModels, runCodex } from './codex.mjs';
import { SANDBOX_WORKSPACE } from './paths.mjs';
import { listOpenCodeModels, runOpenCode } from './opencode.mjs';
import { listPiModels, runPi } from './pi.mjs';
import { canMountPrivateProc, findBubblewrap } from './sandbox.mjs';
import { parseMcpServers } from './mcp-servers.mjs';

const adapters = Object.freeze({ codex: runCodex, opencode: runOpenCode, pi: runPi });
const modelAdapters = Object.freeze({ codex: listCodexModels, opencode: listOpenCodeModels, pi: listPiModels });

async function validateSkills(skills) {
  const names = new Set();
  for (const skill of skills) {
    if (names.has(skill.name)) throw new Error(`Duplicate task skill name: ${skill.name}`);
    names.add(skill.name);
    if (!(await stat(skill.directoryPath)).isDirectory()) {
      throw new Error(`Task skill source is not a directory: ${skill.directoryPath}`);
    }
  }
}

async function syncMountPointDirectories(parent, names) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const expected = new Set(names);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!expected.has(entry.name)) await rm(join(parent, entry.name), { recursive: true, force: true });
  }
  for (const name of expected) await mkdir(join(parent, name), { recursive: true, mode: 0o700 });
}

async function syncWorkspaceLayout(workspace, skills) {
  await validateSkills(skills);
  await syncMountPointDirectories(join(workspace, '.agents', 'skills'), skills.map((skill) => skill.name));
}

async function ensureSkillMountPoints(workspace, skills) {
  await validateSkills(skills);
  for (const skill of skills) {
    await mkdir(join(workspace, '.agents', 'skills', skill.name), { recursive: true, mode: 0o700 });
  }
}

function sandboxMounts(skills) {
  return skills.map((skill) => ({
      source: skill.directoryPath,
      target: `${SANDBOX_WORKSPACE}/.agents/skills/${skill.name}`,
      writable: false,
      purpose: 'task-skill'
    }));
}

export function createCodingAgentService({
  agents,
  skills = [],
  workspace: requestedWorkspace = null,
  home = null,
  mcpServers = null,
  models = {},
  websearch = false,
  cwd = process.cwd(),
  env = process.env,
  logger = null,
  eventSink = null,
  runners = adapters,
  modelListers = modelAdapters
}) {
  const available = agents.filter((record) => record.available);
  const bwrap = findBubblewrap();
  const sandboxCapabilities = {
    bwrap,
    privateProc: canMountPrivateProc(bwrap)
  };
  let activeSkills = skills;
  let workspace = requestedWorkspace;
  const ownsWorkspace = !requestedWorkspace;
  let workspacePrepared = false;
  const configuredMcpServers = parseMcpServers(mcpServers);
  let activeName = null;
  let continuation = null;
  const configuredModels = { ...models };
  let websearchEnabled = Boolean(websearch);
  let outputSink = null;

  async function prepareWorkspace() {
    const nextWorkspace = requestedWorkspace || await mkdtemp(join(tmpdir(), 'ala-agent-'));
    try {
      if (ownsWorkspace) await syncWorkspaceLayout(nextWorkspace, activeSkills);
      else await ensureSkillMountPoints(nextWorkspace, activeSkills);
      workspace = nextWorkspace;
      workspacePrepared = true;
    } catch (error) {
      if (ownsWorkspace) await rm(nextWorkspace, { recursive: true, force: true });
      throw error;
    }
  }

  async function ensureWorkspace() {
    if (!workspacePrepared) await prepareWorkspace();
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
    if (!selected) throw new ALAError(`Coding agent is not available: ${requested}`, EXIT_CODES.execution);
    return selected;
  }

  function executionContext(selected) {
    return {
      hostWorkspace: workspace,
      workspace: SANDBOX_WORKSPACE,
      sandbox: {
        hostWorkspace: workspace,
        backend: selected.name,
        ...(home ? { home } : {}),
        mounts: sandboxMounts(activeSkills),
        bwrap: sandboxCapabilities.bwrap,
        ...(sandboxCapabilities.privateProc ? { privateProc: true } : {})
      }
    };
  }

  return {
    agents,
    async execute(prompt, { agent = 'auto', signal = null } = {}) {
      const selected = select(agent);
      await ensureWorkspace();
      activeName = selected.name;
      logger?.debug?.(`coding-agent: backend=${selected.name}, workspace=${SANDBOX_WORKSPACE}`);
      eventSink?.({
        type: 'coding-agent-selected',
        agent: selected.name,
        ...(configuredModels[selected.name] ? { model: configuredModels[selected.name] } : {})
      });
      let emitted = false;
      let endsWithNewline = true;
      const onVisibleText = outputSink || eventSink ? (value) => {
        const text = String(value || '');
        if (!text) return;
        emitted = true;
        endsWithNewline = text.endsWith('\n');
        outputSink?.(text);
        eventSink?.({ type: 'coding-agent-message', agent: selected.name, message: text });
      } : null;
      try {
        const result = await runners[selected.name]({
          binary: selected.binary,
          prompt,
          ...executionContext(selected),
          continuation,
          model: configuredModels[selected.name] || null,
          websearch: websearchEnabled,
          mcpServers: configuredMcpServers,
          env,
          signal,
          onVisibleText
        });
        continuation = result.continuation;
        eventSink?.({ type: 'coding-agent-final', agent: selected.name, message: result.outputText });
        return result.outputText;
      } catch (error) {
        if (error?.continuation) continuation = error.continuation;
        throw error;
      } finally {
        if (emitted && !endsWithNewline) outputSink?.('\n');
      }
    },
    async listModels(name, { signal = null } = {}) {
      const selected = available.find((record) => record.name === name);
      if (!selected) throw new ALAError(`Coding agent is not available: ${name}`, EXIT_CODES.execution);
      await ensureWorkspace();
      return modelListers[name]({
        binary: selected.binary,
        cwd: SANDBOX_WORKSPACE,
        env,
        signal,
        ...executionContext(selected)
      });
    },
    setModel(name, model) {
      if (!['codex', 'opencode', 'pi'].includes(name)) {
        throw new ALAError(`Unknown coding agent: ${name}`, EXIT_CODES.usage);
      }
      if (model === null || model === undefined || String(model).trim() === '') delete configuredModels[name];
      else configuredModels[name] = String(model).trim();
    },
    setWebsearch(enabled) {
      websearchEnabled = Boolean(enabled);
    },
    setOutputSink(nextOutputSink) {
      outputSink = typeof nextOutputSink === 'function' ? nextOutputSink : null;
    },
    async refreshSkills(nextSkills) {
      await validateSkills(nextSkills);
      const previous = activeSkills;
      activeSkills = nextSkills;
      try {
        if (workspace) {
          if (ownsWorkspace) await syncWorkspaceLayout(workspace, activeSkills);
          else await ensureSkillMountPoints(workspace, activeSkills);
        }
      } catch (error) {
        activeSkills = previous;
        if (workspace && ownsWorkspace) await syncWorkspaceLayout(workspace, activeSkills).catch(() => {});
        throw error;
      }
    },
    cancel() {},
    async close() {
      if (workspace && ownsWorkspace) await rm(workspace, { recursive: true, force: true });
      workspace = null;
      workspacePrepared = false;
      continuation = null;
      activeName = null;
    }
  };
}
