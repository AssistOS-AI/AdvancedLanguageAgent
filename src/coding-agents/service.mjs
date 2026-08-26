import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { listCodexModels, runCodex } from './codex.mjs';
import {
  removeFolderRecord,
  resolveFolderRequest,
  SANDBOX_FOLDERS_DIRECTORY,
  SANDBOX_WORKSPACE,
  upsertFolder
} from './folders.mjs';
import { listOpenCodeModels, runOpenCode } from './opencode.mjs';
import { listPiModels, runPi } from './pi.mjs';
import { canMountPrivateProc, findBubblewrap } from './sandbox.mjs';

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

async function syncWorkspaceLayout(workspace, skills, folders) {
  await validateSkills(skills);
  await syncMountPointDirectories(join(workspace, '.agents', 'skills'), skills.map((skill) => skill.name));
  await syncMountPointDirectories(join(workspace, '.ala', 'folders'), folders.map((folder) => folder.alias));
  const manifest = {
    version: 1,
    folders: folders.map(({ alias, sourcePath, workspacePath, access }) => ({
      alias, sourcePath, workspacePath, access
    }))
  };
  await writeFile(join(workspace, '.ala', 'folders.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600
  });
}

function sandboxMounts(skills, folders) {
  return [
    ...skills.map((skill) => ({
      source: skill.directoryPath,
      target: `${SANDBOX_WORKSPACE}/.agents/skills/${skill.name}`,
      writable: false,
      purpose: 'task-skill'
    })),
    ...folders.map((folder) => ({
      source: folder.sourcePath,
      target: folder.workspacePath,
      writable: folder.writable,
      purpose: 'folder'
    }))
  ];
}

function folderPrompt(prompt, folders) {
  if (folders.length === 0) return prompt;
  const entries = folders.map((folder) => (
    `- ${folder.workspacePath} (${folder.access}; alias ${folder.alias})`
  )).join('\n');
  return `ALA mounted the following user-authorized folders inside the Bubblewrap sandbox:\n${entries}\nRead ${SANDBOX_WORKSPACE}/.ala/folders.json for the complete mapping. Treat read-only mounts as immutable and write only to mounts marked read-write. Unmounted host paths are unavailable.\n\nUser request:\n${prompt}`;
}

export function createCodingAgentService({
  agents,
  skills = [],
  folders = [],
  models = {},
  websearch = false,
  cwd = process.cwd(),
  env = process.env,
  logger = null,
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
  let activeFolders = folders;
  let workspace = null;
  let activeName = null;
  let continuation = null;
  const configuredModels = { ...models };
  let websearchEnabled = Boolean(websearch);
  let outputSink = null;

  async function prepareWorkspace() {
    const nextWorkspace = await mkdtemp(join(tmpdir(), 'ala-agent-'));
    try {
      await syncWorkspaceLayout(nextWorkspace, activeSkills, activeFolders);
      workspace = nextWorkspace;
    } catch (error) {
      await rm(nextWorkspace, { recursive: true, force: true });
      throw error;
    }
  }

  async function ensureWorkspace() {
    if (!workspace) await prepareWorkspace();
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
        mounts: sandboxMounts(activeSkills, activeFolders),
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
      let emitted = false;
      let endsWithNewline = true;
      const onVisibleText = outputSink ? (value) => {
        const text = String(value || '');
        if (!text) return;
        emitted = true;
        endsWithNewline = text.endsWith('\n');
        outputSink(text);
      } : null;
      try {
        const result = await runners[selected.name]({
          binary: selected.binary,
          prompt: folderPrompt(prompt, activeFolders),
          ...executionContext(selected),
          continuation,
          model: configuredModels[selected.name] || null,
          websearch: websearchEnabled,
          env,
          signal,
          onVisibleText
        });
        continuation = result.continuation;
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
    listFolders() {
      return activeFolders.map((folder) => ({ ...folder }));
    },
    async addFolder(path, writable = false) {
      if (available.length === 0) {
        throw new ALAError('Active folders require an available coding agent.', EXIT_CODES.execution);
      }
      const record = await resolveFolderRequest({ path, writable }, cwd);
      const previous = activeFolders;
      activeFolders = upsertFolder(activeFolders, record);
      try {
        if (workspace) await syncWorkspaceLayout(workspace, activeSkills, activeFolders);
      } catch (error) {
        activeFolders = previous;
        if (workspace) await syncWorkspaceLayout(workspace, activeSkills, activeFolders).catch(() => {});
        throw error;
      }
      return record;
    },
    async removeFolder(value) {
      const previous = activeFolders;
      activeFolders = await removeFolderRecord(activeFolders, value, cwd);
      try {
        if (workspace) await syncWorkspaceLayout(workspace, activeSkills, activeFolders);
      } catch (error) {
        activeFolders = previous;
        if (workspace) await syncWorkspaceLayout(workspace, activeSkills, activeFolders).catch(() => {});
        throw error;
      }
    },
    async refreshSkills(nextSkills) {
      await validateSkills(nextSkills);
      const previous = activeSkills;
      activeSkills = nextSkills;
      try {
        if (workspace) await syncWorkspaceLayout(workspace, activeSkills, activeFolders);
      } catch (error) {
        activeSkills = previous;
        if (workspace) await syncWorkspaceLayout(workspace, activeSkills, activeFolders).catch(() => {});
        throw error;
      }
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

export { SANDBOX_FOLDERS_DIRECTORY };
