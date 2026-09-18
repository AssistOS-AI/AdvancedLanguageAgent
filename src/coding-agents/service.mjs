import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { createPermissionRequestManager, validatePermissionMode } from '../permission-requests.mjs';
import { listCodexModels, runCodex } from './codex.mjs';
import { listOpenCodeModels, runOpenCode } from './opencode.mjs';
import { listPiModels, runPi } from './pi.mjs';
import { resolveFolderMounts } from './folders.mjs';
import { canMountPrivateProc, findBubblewrap } from './sandbox.mjs';
import { parseMcpServers } from './mcp-servers.mjs';
import { runCodexLive, runPiLive } from './live-agents.mjs';

const adapters = Object.freeze({ codex: runCodex, opencode: runOpenCode, pi: runPi });
const modelAdapters = Object.freeze({ codex: listCodexModels, opencode: listOpenCodeModels, pi: listPiModels });

export function createCodingAgentService({
  agents,
  workspace: requestedWorkspace = null,
  workspaceTarget = null,
  home = null,
  folders = [],
  mcpServers = null,
  models = {},
  efforts = {},
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
  const folderMounts = resolveFolderMounts(folders, cwd);
  permissionRequests ??= createPermissionRequestManager({ eventSink, logger });
  let activeController = null;
  const available = agents.filter((record) => record.available);
  const bwrap = findBubblewrap();
  const sandboxCapabilities = {
    bwrap,
    privateProc: canMountPrivateProc(bwrap)
  };
  let workspace = requestedWorkspace;
  let sandboxWorkspace = workspaceTarget;
  let workspacePrepared = false;
  const configuredMcpServers = parseMcpServers(mcpServers);
  let activeName = sessionState?.record.agent || null;
  let continuation = sessionState?.record.continuation || null;
  let sendLive = null;
  let executing = false;
  const configuredModels = { ...models };
  const configuredEfforts = { ...efforts };
  let websearchEnabled = Boolean(websearch);
  let outputSink = null;

  async function prepareWorkspace() {
    // A caller-supplied cwd is used as-is. Without one ALA retains an owned
    // temporary directory so the execution can be inspected after it finishes.
    if (!workspace) workspace = await mkdtemp(join(tmpdir(), 'ala-agent-'));
    if (!sandboxWorkspace) sandboxWorkspace = workspace;
    workspacePrepared = true;
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
      workspace: sandboxWorkspace,
      sandbox: {
        hostWorkspace: workspace,
        workspaceTarget: sandboxWorkspace,
        backend: selected.name,
        ...(home ? { home } : {}),
        folders: folderMounts,
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
      const turnModel = configuredModels[selected.name] || null;
      const turnEffort = configuredEfforts[selected.name] || null;
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
        if (turnEffort) {
          const catalog = await modelListers[selected.name]({ binary: selected.binary,
            cwd: sandboxWorkspace, env, signal: controller.signal, details: true, ...executionContext(selected) });
          if (!catalog.find((entry) => entry.id === turnModel)?.efforts?.includes(turnEffort)) {
            throw new ALAError('The selected model does not advertise this effort: ' + turnEffort, EXIT_CODES.usage);
          }
        }
        activeName = selected.name;
        await sessionState?.save({ agent: activeName });
        controller.signal.throwIfAborted();
        logger?.debug?.(`coding-agent: backend=${selected.name}, workspace=${sandboxWorkspace}`);
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
          model: turnModel,
          effort: turnEffort,
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
    async listModels(name, { signal = null, details = false } = {}) {
      const selected = available.find((record) => record.name === name);
      if (!selected) throw new ALAError(`Coding agent is not available: ${name}`, EXIT_CODES.execution);
      await ensureWorkspace();
      return modelListers[name]({
        binary: selected.binary,
        details,
        cwd: sandboxWorkspace,
        env,
        signal,
        ...executionContext(selected)
      });
    },
    setModel(name, model, effort = null) {
      if (!['codex', 'opencode', 'pi'].includes(name)) {
        throw new ALAError(`Unknown coding agent: ${name}`, EXIT_CODES.usage);
      }
      if (effort) configuredEfforts[name] = effort;
      else delete configuredEfforts[name];
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
    cancel(reason = 'cancelled') {
      activeController?.abort(new ALAError(`Execution interrupted: ${reason}`, EXIT_CODES.interrupted));
      permissionRequests.cancelAll('cancelled');
    },
    async close() {
      this.cancel('closed');
      permissionRequests.setReplyCapability(false);
      continuation = null;
      activeName = null;
    }
  };
}
