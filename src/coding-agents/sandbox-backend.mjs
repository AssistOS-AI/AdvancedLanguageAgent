import * as bubblewrap from './sandbox.mjs';
import * as seatbelt from './seatbelt.mjs';
import { ALAError, EXIT_CODES } from '../errors.mjs';

// The one place that chooses how a coding-agent process is confined. Linux uses Bubblewrap exactly as before;
// macOS uses Seatbelt (sandbox-exec). No environment variable selects or disables a backend, and every other
// platform is refused: there is no unsandboxed fallback.
export function sandboxBackend({ platform = process.platform } = {}) {
  if (platform === 'linux') return 'bubblewrap';
  if (platform === 'darwin') return 'seatbelt';
  throw new ALAError('Coding-agent execution requires Linux (Bubblewrap) or macOS (Seatbelt); '
    + 'no unsandboxed fallback is permitted.', EXIT_CODES.execution);
}

export function sandboxLabel(options = {}) {
  return sandboxBackend(options) === 'seatbelt' ? 'Seatbelt' : 'Bubblewrap';
}

// privateProc is read lazily so the Bubblewrap probes run at the same point of service creation as before.
export function sandboxCapabilities(env = process.env, { platform = process.platform } = {}) {
  if (sandboxBackend({ platform }) === 'seatbelt') {
    return { backend: 'seatbelt', launcher: seatbelt.findSeatbelt(), privateProc: true, bindDescriptors: false };
  }
  const launcher = bubblewrap.findBubblewrap(env);
  const bindDescriptors = bubblewrap.canBindDescriptors(launcher);
  let privateProc;
  return {
    backend: 'bubblewrap',
    launcher,
    bindDescriptors,
    get privateProc() {
      privateProc ??= bubblewrap.canMountPrivateProc(launcher);
      return privateProc;
    }
  };
}

export function canStartSandbox(env = process.env, { platform = process.platform } = {}) {
  if (sandboxBackend({ platform }) === 'seatbelt') return seatbelt.canStartSeatbelt(seatbelt.findSeatbelt());
  return bubblewrap.canStartBubblewrap(bubblewrap.findBubblewrap(env));
}

// One launch description for spawnProcess: { command, args, options: { cwd, env, stdio, detached }, attach(child) }.
export function buildSandboxLaunch({ sandbox, binary, args, cwd, env, stdio }, {
  platform = process.platform,
  buildSandboxArgs = bubblewrap.buildSandboxArgs,
  findBubblewrap = bubblewrap.findBubblewrap
} = {}) {
  if (sandboxBackend({ platform }) === 'seatbelt') {
    return seatbelt.buildSeatbeltLaunch({ sandbox, binary, args, cwd, env, stdio });
  }
  const bwrap = sandbox.bwrap || findBubblewrap(env);
  return {
    command: bwrap || '/usr/bin/bwrap',
    args: buildSandboxArgs({
      workspace: sandbox.hostWorkspace,
      workspaceFd: sandbox.workspaceFd ?? null,
      workspaceTarget: sandbox.workspaceTarget,
      backend: sandbox.backend,
      binary,
      args,
      env,
      bwrap,
      privateProc: sandbox.privateProc,
      ...(sandbox.newSession === false ? { newSession: false } : {}),
      home: sandbox.home,
      folders: sandbox.folders,
      ignoredPaths: sandbox.ignoredPaths,
      ...(sandbox.runtimeBinaries?.length ? { runtimeBinaries: sandbox.runtimeBinaries } : {}),
      ...(sandbox.fileMounts?.length ? { fileMounts: sandbox.fileMounts } : {}),
      chdir: cwd
    }),
    options: {
      // Bubblewrap changes directory inside the sandbox; a pinned workspace's host path is never entered.
      cwd: sandbox.workspaceFd !== undefined ? '/' : sandbox.hostWorkspace,
      env,
      stdio: [...stdio, ...bubblewrap.sandboxDescriptors(sandbox)],
      detached: false
    },
    attach() {}
  };
}
