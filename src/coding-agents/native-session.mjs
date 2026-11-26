import path from 'node:path';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { buildInteractiveCommand } from './native-interactive.mjs';
import { prepareNativeInstructions } from './native-instructions.mjs';
import { getAgent } from './registry.mjs';
import { buildSandboxLaunch } from './sandbox-backend.mjs';
import { canMountPrivateProc, findBubblewrap } from './sandbox.mjs';

// An interactive session is the second execution lifetime ALA exposes: one coding agent runs in its own
// terminal inside the same fail-closed sandbox as one-shot execution. ALA builds that sandbox and starts the
// agent; it reads no standard input, takes no turn prompt, and writes no transcript, because the terminal, its
// signals and its exit status belong to the coding agent. This module only builds the launch.

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/u;
// The session owns the caller's terminal, so nothing is piped: all three descriptors are inherited.
const INHERIT = Object.freeze(['inherit', 'inherit', 'inherit']);

function requireAbsolute(what, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new ALAError(`${what} must be an absolute path.`, EXIT_CODES.usage);
  }
  return value;
}

function requireTokens(nativeArgs) {
  if (!Array.isArray(nativeArgs)) throw new TypeError('nativeArgs must be an array.');
  for (const arg of nativeArgs) {
    if (typeof arg !== 'string' || !TOKEN.test(arg)) {
      throw new ALAError('--native-arg accepts one token of letters, digits, dashes or underscores.',
        EXIT_CODES.usage);
    }
  }
  return nativeArgs;
}

// The agent's own argv: the full-access policy when the caller grants it, otherwise the agent's native
// approval UI, which only a backend with an approval flow may run.
function agentArgv({ agent, binary, nativeArgs, permissions }) {
  if (permissions === 'full-access') return buildInteractiveCommand({ agent, binary, args: nativeArgs });
  const record = getAgent(agent);
  if (!record?.capabilities.approvals) {
    throw new ALAError(`${record?.label || agent} supports full-access only; select full-access.`,
      EXIT_CODES.usage);
  }
  return [binary, ...nativeArgs];
}

// Programs a session starts by path are mounted read-only, so the agent and the shell that may precede it
// exist inside the sandbox at the same absolute paths.
function sessionRuntimeBinaries({ runtimeBinaries, binary, argv }) {
  const programs = [...runtimeBinaries];
  for (const program of [binary, argv[0]]) {
    if (!programs.includes(program)) programs.push(program);
  }
  return programs;
}

export function buildNativeSessionLaunch({
  agent,
  binary,
  nativeArgs = [],
  systemPrompt = null,
  permissions = 'full-access',
  loginShell = null,
  home = null,
  workspace,
  workspaceFd = null,
  workspaceTarget = null,
  folders = [],
  ignoredPaths = [],
  runtimeBinaries = [],
  env = process.env,
  chdir = null,
  bwrap = null,
  stdio = INHERIT,
  probePrivateProc = canMountPrivateProc,
  launch = buildSandboxLaunch
}) {
  if (process.platform !== 'linux') {
    throw new ALAError('An interactive session requires Linux Bubblewrap; the macOS Seatbelt backend cannot '
      + 'hand the caller\'s terminal to the coding agent.', EXIT_CODES.execution);
  }
  const launcher = bwrap || findBubblewrap(env);
  if (!launcher) {
    throw new ALAError('An interactive session requires Bubblewrap (bwrap at /usr/bin/bwrap, /bin/bwrap '
      + 'or ALA_BWRAP); no unsandboxed fallback is permitted.', EXIT_CODES.execution);
  }
  if (!probePrivateProc(launcher)) {
    throw new ALAError('An interactive session requires a private /proc inside Bubblewrap, but the '
      + 'capability probe failed. The host must allow a new procfs in a user namespace.', EXIT_CODES.execution);
  }
  const argv = agentArgv({
    agent,
    binary: requireAbsolute('The coding-agent executable', binary),
    nativeArgs: requireTokens(nativeArgs),
    permissions
  });
  const instructions = prepareNativeInstructions(agent, systemPrompt, env);
  argv.push(...instructions.args);
  if (Object.keys(instructions.env).length) {
    argv.unshift('/usr/bin/env', ...Object.entries(instructions.env).map(([key, value]) => `${key}=${value}`));
  }
  try {
    // A caller-supplied login shell starts first so the agent inherits the caller's prepared profile. It is the
    // only program the sandbox starts before the agent, and it is replaced by the agent.
    const shell = loginShell === null ? null : requireAbsolute('--login-shell', loginShell);
    const command = shell || argv[0];
    const commandArgs = shell
      ? [shell.endsWith('/bash') ? '--login' : '-l', '-c', 'exec "$0" "$@"', ...argv]
      : argv.slice(1);
    const result = launch({
      sandbox: {
        hostWorkspace: workspace,
        ...(workspaceFd !== null ? { workspaceFd } : {}),
        workspaceTarget,
        backend: agent,
        ...(home ? { home } : {}),
        folders,
        fileMounts: instructions.fileMounts,
        ignoredPaths,
        bwrap: launcher,
        privateProc: true,
        runtimeBinaries: sessionRuntimeBinaries({ runtimeBinaries, binary, argv }),
        // A terminal keeps the process group it was started in.
        newSession: false
      },
      binary: command,
      args: commandArgs,
      cwd: chdir,
      env,
      stdio
    });
    return { ...result, cleanup: instructions.cleanup };
  } catch (error) { instructions.cleanup(); throw error; }
}
