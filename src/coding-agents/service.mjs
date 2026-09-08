import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { createPermissionRequestManager, validatePermissionMode } from '../permission-requests.mjs';
import { listCodexModels, runCodex } from './codex.mjs';
import { SANDBOX_WORKSPACE } from './paths.mjs';
import { listOpenCodeModels, runOpenCode } from './opencode.mjs';
import { listPiModels, runPi } from './pi.mjs';
import { canMountPrivateProc, findBubblewrap, validateRuntimeBridge } from './sandbox.mjs';
import { parseMcpServers } from './mcp-servers.mjs';
import { runCodexLive, runPiLive } from './live-agents.mjs';

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
  runtimeBridge = null,
  ploinkyTask = null,
  isolatedSkills = false,
  mcpServers = null,
  models = {},
  websearch = false,
  cwd = process.cwd(),
  env = process.env,
  logger = null,
  eventSink = null,
  sessionState = null,
  permissionMode = 'full-access',
  permissionRequests = null,
  runners = adapters,
  modelListers = modelAdapters
}) {
  let requestedPermissionMode = validatePermissionMode(permissionMode);
  runtimeBridge = validateRuntimeBridge(runtimeBridge);
  ploinkyTask = validateRuntimeBridge(ploinkyTask);
  const overlaySkills = Boolean(runtimeBridge || ploinkyTask || isolatedSkills);
  permissionRequests ??= createPermissionRequestManager({ eventSink, logger });
  let activeController = null;
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
  let activeName = sessionState?.record.agent || null;
  let continuation = sessionState?.record.continuation || null;
  let sendLive = null;
  let executing = false;
  const configuredModels = { ...models };
  let websearchEnabled = Boolean(websearch);
  let outputSink = null;

  async function prepareWorkspace() {
    const nextWorkspace = requestedWorkspace || await mkdtemp(join(tmpdir(), 'ala-agent-'));
    try {
      if (overlaySkills) await validateSkills(activeSkills);
      else if (ownsWorkspace) await syncWorkspaceLayout(nextWorkspace, activeSkills);
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
      const pinned = available.find((record) => record.name === activeName);
      if (!pinned) throw new Error(`Saved coding agent is unavailable: ${activeName}`);
      return pinned;
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
        ...(runtimeBridge ? { runtimeBridge } : {}),
        ...(ploinkyTask ? { ploinkyTask } : {}),
        isolatedSkills: overlaySkills,
        mounts: sandboxMounts(activeSkills),
        bwrap: sandboxCapabilities.bwrap,
        ...(sandboxCapabilities.privateProc ? { privateProc: true } : {})
      }
    };
  }

  return {
    agents,
    permissionRequests,
    async execute(prompt, { agent = 'auto', signal = null } = {}) {
      if (executing) throw new Error('Coding-agent session is already executing.');
      const selected = select(agent);
      const turnPermissionMode = requestedPermissionMode;
      if (selected.name === 'pi' && turnPermissionMode === 'ask-for-approval') {
        throw new ALAError(
          'Pi does not support ask-for-approval; select full-access or use Codex/OpenCode.',
          EXIT_CODES.usage
        );
      }
      executing = true;
      const controller = new AbortController();
      activeController = controller;
      const abort = () => {
        controller.abort(signal.reason);
        permissionRequests.cancelAll('cancelled');
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
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
        controller.signal.throwIfAborted();
        await ensureWorkspace();
        controller.signal.throwIfAborted();
        activeName = selected.name;
        await sessionState?.save({ agent: activeName });
        controller.signal.throwIfAborted();
        logger?.debug?.(`coding-agent: backend=${selected.name}, workspace=${SANDBOX_WORKSPACE}`);
        eventSink?.({
          type: 'coding-agent-selected',
          agent: selected.name,
          permissionMode: turnPermissionMode,
          ...(configuredModels[selected.name] ? { model: configuredModels[selected.name] } : {})
        });
        const runner = (sessionState || turnPermissionMode === 'ask-for-approval') && runners === adapters
          ? ({ codex: runCodexLive, pi: runPiLive, opencode: runOpenCode })[selected.name]
          : runners[selected.name];
        const result = await runner({
          binary: selected.binary,
          prompt,
          ...executionContext(selected),
          continuation,
          model: configuredModels[selected.name] || null,
          websearch: websearchEnabled,
          permissionMode: turnPermissionMode,
          permissionRequests,
          mcpServers: configuredMcpServers,
          env,
          signal: controller.signal,
          onVisibleText,
          onSession: async (value) => {
            continuation = value;
            await sessionState?.save({ continuation });
          },
          setMessageHandler: (handler) => { sendLive = handler; }
        });
        controller.signal.throwIfAborted();
        continuation = result.continuation;
        await sessionState?.save({ continuation });
        eventSink?.({ type: 'coding-agent-final', agent: selected.name, message: result.outputText });
        return result.outputText;
      } catch (error) {
        if (error?.continuation) {
          continuation = error.continuation;
          await sessionState?.save({ continuation });
        }
        throw error;
      } finally {
        permissionRequests.cancelAll('expired');
        signal?.removeEventListener('abort', abort);
        activeController = null;
        executing = false;
        sendLive = null;
        if (emitted && !endsWithNewline) outputSink?.('\n');
      }
    },
    async sendMessage(message) {
      if (!sendLive) return { delivery: 'queued' };
      return sendLive(message);
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
    setPermissionMode(mode) {
      requestedPermissionMode = validatePermissionMode(mode);
    },
    setOutputSink(nextOutputSink) {
      outputSink = typeof nextOutputSink === 'function' ? nextOutputSink : null;
    },
    async refreshSkills(nextSkills) {
      await validateSkills(nextSkills);
      const previous = activeSkills;
      activeSkills = nextSkills;
      try {
        if (workspace && !overlaySkills) {
          if (ownsWorkspace) await syncWorkspaceLayout(workspace, activeSkills);
          else await ensureSkillMountPoints(workspace, activeSkills);
        }
      } catch (error) {
        activeSkills = previous;
        if (workspace && ownsWorkspace && !overlaySkills) {
          await syncWorkspaceLayout(workspace, activeSkills).catch(() => {});
        }
        throw error;
      }
    },
    cancel(reason = 'cancelled') {
      activeController?.abort(new ALAError(`Execution interrupted: ${reason}`, EXIT_CODES.interrupted));
      permissionRequests.cancelAll('cancelled');
    },
    async close() {
      this.cancel('closed');
      permissionRequests.setReplyCapability(false);
      if (workspace && ownsWorkspace) await rm(workspace, { recursive: true, force: true });
      workspace = null;
      workspacePrepared = false;
      continuation = null;
      activeName = null;
    }
  };
}
