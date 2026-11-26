import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig, resolveConfigPath } from './config.mjs';
import { discoverCodingAgents } from './coding-agents/discovery.mjs';
import { parseExpectedDirectories, pinDirectory, pinFolderMounts } from './coding-agents/folders.mjs';
import { homeEnvironment } from './coding-agents/logins.mjs';
import { buildNativeSessionLaunch } from './coding-agents/native-session.mjs';
import { workspaceAliasTarget } from './coding-agents/paths.mjs';
import { AGENTS, enumerate } from './coding-agents/registry.mjs';
import { ALAError, EXIT_CODES } from './errors.mjs';

// An interactive session hands the caller's terminal to one coding agent inside the ALA sandbox. This entry
// resolves the same mounts, identities and backend selection as one-shot execution, then waits without reading
// standard input, so the terminal belongs to the agent until it exits.

const SIGNAL_EXIT_CODES = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 });
const TERMINAL_SIGNALS = ['SIGINT', 'SIGQUIT'];

async function requireDirectory(option, value) {
  if (!value || !(await stat(value).catch(() => null))?.isDirectory()) {
    throw new ALAError(`${option} must reference an existing directory.`, EXIT_CODES.usage);
  }
  return value;
}

function selectAgent(requested, available, defaultCodingAgent) {
  if (!available.length) {
    throw new ALAError(`No coding agent is available. Install and authenticate ${enumerate(AGENTS.map((agent) => agent.label))}.`,
      EXIT_CODES.execution);
  }
  if (requested !== 'auto') {
    const selected = available.find((record) => record.name === requested);
    if (!selected) throw new ALAError(`Coding agent is not available: ${requested}`, EXIT_CODES.execution);
    return selected;
  }
  return available.find((record) => record.name === defaultCodingAgent) || available[0];
}

function exitCodeFor(signal) {
  return SIGNAL_EXIT_CODES[signal] || EXIT_CODES.execution;
}

export async function runNativeSession(options, io, env) {
  const expected = parseExpectedDirectories(options.expectedDirectories);
  // An interactive session starts in the folder the caller is already in: `--cwd` only names it explicitly. The
  // home is the coding agent's own and never replaces the folder.
  const requestedCwd = options.cwd ? resolve(io.cwd, options.cwd) : io.cwd;
  const named = new Set([requestedCwd, ...options.folders.map((folder) => resolve(requestedCwd, folder.source))]);
  const unmatched = Object.keys(expected).find((name) => !named.has(name));
  if (unmatched) throw new ALAError(`--expect-dir names no --cwd or --folder: ${unmatched}`, EXIT_CODES.usage);
  for (const [name, identity] of Object.entries(expected)) closeSync(pinDirectory(name, identity).fd);
  const workspaceTarget = workspaceAliasTarget(options.cwdAlias);
  // A checked cwd is canonical and is never resolved again.
  const executionCwd = expected[requestedCwd] ? requestedCwd : await realpath(requestedCwd);
  await requireDirectory('--cwd', executionCwd);
  const executionHome = options.home ? await realpath(resolve(io.cwd, options.home)) : null;
  if (executionHome) await requireDirectory('--home', executionHome);
  const mountCwd = executionCwd;
  const runtimeEnv = executionHome ? homeEnvironment(env, executionHome) : env;
  const configPath = resolveConfigPath({ cliPath: options.configPath, env: runtimeEnv, cwd: mountCwd });
  const config = await loadConfig(configPath);
  const codingAgents = await discoverCodingAgents({ env: runtimeEnv });
  const selected = selectAgent(options.agent || 'auto', codingAgents.filter((agent) => agent.available),
    config.codingAgent || null);
  const pins = [];
  let workspacePin = null;
  const release = () => { for (const fd of pins.splice(0)) closeSync(fd); };
  try {
    // The session's directories are opened once and bound by descriptor, exactly like one-shot execution.
    const pinnedFolders = pinFolderMounts(options.folders, mountCwd, expected);
    pins.push(...pinnedFolders.map((mount) => mount.fd));
    workspacePin = pinDirectory(executionCwd, expected[requestedCwd] ?? null);
    pins.push(workspacePin.fd);
    const sandboxWorkspace = workspaceTarget || executionCwd;
    const spawnEnv = { ...process.env, ...runtimeEnv };
    delete spawnEnv.NODE_TEST_CONTEXT;
    // Only a real terminal can be inherited: a caller's streams belong to this process, not to the child.
    const inherited = [io.stdin, io.stdout, io.stderr].every((stream) => Number.isInteger(stream?.fd));
    const stdio = inherited ? [io.stdin.fd, io.stdout.fd, io.stderr.fd] : ['pipe', 'pipe', 'pipe'];
    const launch = buildNativeSessionLaunch({
      agent: selected.name,
      binary: selected.binary,
      nativeArgs: options.nativeArgs,
      permissions: options.permissionMode,
      loginShell: options.loginShell ?? null,
      home: executionHome,
      workspace: executionCwd,
      workspaceFd: workspacePin.fd,
      workspaceTarget: workspaceTarget || null,
      folders: pinnedFolders,
      ignoredPaths: options.ignoredPaths,
      runtimeBinaries: options.runtimeBinaries,
      env: spawnEnv,
      chdir: sandboxWorkspace,
      stdio
    });
    return await runNativeLaunch(launch, io, inherited);
  } finally {
    release();
  }
}

// A caller that passes its own streams cannot hand them to a child process, so the session is piped to them
// instead. A real terminal is inherited, because only then do window size, signals and the foreground process
// group reach the coding agent.
export function runNativeLaunch(launch, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, inherited = true) {
  return new Promise((settle, fail) => {
    // The terminal's own signals belong to the coding agent; a wrapper that dies first would end the session.
    const ignore = () => {};
    for (const signal of TERMINAL_SIGNALS) process.on(signal, ignore);
    const forwardTerm = () => child?.kill('SIGTERM');
    process.on('SIGTERM', forwardTerm);
    const detach = () => {
      for (const signal of TERMINAL_SIGNALS) process.removeListener(signal, ignore);
      process.removeListener('SIGTERM', forwardTerm);
      if (!inherited && child?.stdin) io.stdin.unpipe(child.stdin);
    };
    let child;
    try {
      child = spawn(launch.command, launch.args, launch.options);
      launch.attach?.(child);
    } catch (error) {
      detach();
      fail(error);
      return;
    }
    if (!inherited) {
      child.stdin.on('error', () => {});
      io.stdin.on('error', () => {});
      io.stdin.pipe(child.stdin);
      child.stdout.on('data', (chunk) => io.stdout.write(chunk));
      child.stderr.on('data', (chunk) => io.stderr.write(chunk));
    }
    child.once('error', (error) => { detach(); fail(error); });
    child.once('close', (code, signal) => { detach(); settle(code ?? exitCodeFor(signal)); });
  });
}
