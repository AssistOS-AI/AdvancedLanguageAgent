import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { resolveFolderMounts } from './folders.mjs';
import { ignoredMountTargets } from './ignored-paths.mjs';
import { SANDBOX_HOME } from './paths.mjs';
import { AGENTS, getAgent } from './registry.mjs';

const PROBE_CACHE_TTL_MS = 30_000;
const privateProcSupport = new Map();
const privateProcModes = new Map();
const sandboxSupport = new Map();
const probeDiagnostics = new Map();
// The probe command; minimal images keep `true` only in /bin.
const PROBE_TRUE = ['/usr/bin/true', '/bin/true'].find((candidate) => fs.existsSync(candidate)) || '/usr/bin/true';

const SHARED_ENVIRONMENT = Object.freeze([
  'LANG', 'LANGUAGE', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
]);

// ALA_BWRAP names an explicit Bubblewrap binary, for example a static build shipped beside the coding agents
// for a container that has no bwrap of its own. When it is set but unusable, no other binary is tried.
export function findBubblewrap(env = process.env) {
  const explicit = typeof env?.ALA_BWRAP === 'string' ? env.ALA_BWRAP.trim() : '';
  for (const candidate of explicit ? [explicit] : ['/usr/bin/bwrap', '/bin/bwrap']) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = fs.realpathSync(candidate);
      const metadata = fs.statSync(resolved);
      fs.accessSync(resolved, fs.constants.X_OK);
      if (metadata.isFile()) return resolved;
    } catch {}
  }
  return null;
}

export function canMountPrivateProc(bwrap = findBubblewrap(), dependencies = {}) {
  if (!bwrap) return false;
  const userNamespaceArgs = ['--die-with-parent', '--unshare-user', '--unshare-pid'];
  addSystemMounts(userNamespaceArgs);
  userNamespaceArgs.push('--proc', '/proc', '--', PROBE_TRUE);
  if (probeBubblewrap(privateProcSupport, bwrap, userNamespaceArgs, dependencies)) {
    privateProcModes.set(bwrap, 'userns');
    return true;
  }
  const outerCapabilityArgs = ['--die-with-parent', '--unshare-pid', '--cap-drop', 'ALL'];
  addSystemMounts(outerCapabilityArgs);
  outerCapabilityArgs.push('--proc', '/proc', '--', PROBE_TRUE);
  if (probeBubblewrap(privateProcSupport, bwrap, outerCapabilityArgs, dependencies)) {
    privateProcModes.set(bwrap, 'outer-cap');
    return true;
  }
  privateProcModes.delete(bwrap);
  return false;
}

export function canStartBubblewrap(bwrap = findBubblewrap(), dependencies = {}) {
  if (!bwrap) return false;
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid'];
  addSystemMounts(args);
  args.push('--dir', '/proc', '--', PROBE_TRUE);
  return probeBubblewrap(sandboxSupport, bwrap, args, dependencies);
}

export function bubblewrapProbeDiagnostic(bwrap) {
  return probeDiagnostics.get(bwrap) || '';
}

function probeBubblewrap(cache, bwrap, args, dependencies = {}) {
  const now = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
  const spawn = typeof dependencies.spawnSyncImpl === 'function' ? dependencies.spawnSyncImpl : spawnSync;
  const cacheKey = JSON.stringify([bwrap, args]);
  const cached = cache.get(cacheKey);
  if (cached?.expiresAt > now) return true;
  cache.delete(cacheKey);
  let diagnostic = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawn(bwrap, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      maxBuffer: 64 * 1024,
      timeout: 5000
    });
    if (result.status === 0 && !result.error) {
      cache.set(cacheKey, { expiresAt: now + PROBE_CACHE_TTL_MS });
      probeDiagnostics.delete(bwrap);
      return true;
    }
    diagnostic = String(result.error?.message || result.stderr || result.stdout
      || `exit ${result.status ?? 'unknown'}`).replace(/[\r\n\t]+/gu, ' ').trim().slice(-512);
  }
  probeDiagnostics.set(bwrap, diagnostic);
  return false;
}

function resolveExisting(value) {
  if (!value) return null;
  try { return fs.realpathSync(path.resolve(value)); } catch { return null; }
}

function systemPath(value) {
  return ['/usr', '/bin', '/sbin', '/lib', '/lib64'].some((root) => (
    value === root || value.startsWith(`${root}/`)
  ));
}

export function collectAgentRuntimeMounts(binary) {
  const resolved = resolveExisting(binary);
  if (!resolved || systemPath(resolved)) return [];
  const nodeModulesMarker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const markerIndex = resolved.indexOf(nodeModulesMarker);
  if (markerIndex >= 0) return [resolved.slice(0, markerIndex)];
  const localModulesMarker = `${path.sep}node_modules${path.sep}`;
  const localMarkerIndex = resolved.indexOf(localModulesMarker);
  if (localMarkerIndex >= 0) {
    return [resolved.slice(0, localMarkerIndex + localModulesMarker.length - 1)];
  }
  if (path.basename(resolved) === 'node' && path.basename(path.dirname(resolved)) === 'bin') {
    return [path.dirname(path.dirname(resolved))];
  }
  // An agent that installs under its own marked directory needs that whole directory.
  for (const { sandbox: { installMarker } } of AGENTS) {
    const marker = `${path.sep}${installMarker}${path.sep}`;
    const index = installMarker ? resolved.indexOf(marker) : -1;
    if (index >= 0) return [resolved.slice(0, index + marker.length - 1)];
  }
  return [path.dirname(resolved)];
}

function stateMount(source, target) {
  const resolved = resolveExisting(source);
  return resolved ? { source: resolved, target, writable: true, purpose: 'agent-state' } : null;
}

export function collectAgentStateMounts(backend, env = process.env) {
  const home = path.resolve(env.HOME || homedir());
  const state = getAgent(backend)?.state(env, home) || [];
  return state.map(({ source, target }) => stateMount(source, target)).filter(Boolean);
}

function runtimeSearchPaths(runtimeMounts) {
  const candidates = [];
  for (const mount of runtimeMounts) {
    for (const relative of ['bin', '']) {
      const candidate = path.join(mount.target, relative);
      if (fs.existsSync(path.join(mount.source || mount.target, relative)) && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

export function sandboxRuntimeMounts(sources, sandboxWorkspace = null) {
  return [...sources].map((source, index) => ({
    source,
    // The workspace bind may hide prefixes installed below it.
    target: sandboxWorkspace && (source === sandboxWorkspace || source.startsWith(`${sandboxWorkspace}/`))
      ? `/run/ala-agent-runtime/${index}/${path.basename(source)}` : source,
    writable: false,
    purpose: 'agent-runtime'
  }));
}

export function sandboxEnvironment(backend, runtimeMounts = [], env = process.env) {
  const values = {};
  const agent = getAgent(backend);
  const allowed = new Set([...SHARED_ENVIRONMENT, ...(agent?.sandbox.envAllow || [])]);
  for (const name of allowed) {
    if (typeof env[name] === 'string' && env[name]) values[name] = env[name];
  }
  Object.assign(values, {
    HOME: SANDBOX_HOME,
    USER: 'ala',
    LOGNAME: 'ala',
    SHELL: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh',
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config`,
    XDG_DATA_HOME: `${SANDBOX_HOME}/.local/share`,
    XDG_CACHE_HOME: `${SANDBOX_HOME}/.cache`,
    XDG_STATE_HOME: `${SANDBOX_HOME}/.local/state`,
    PATH: [...runtimeSearchPaths(runtimeMounts), '/usr/local/bin', '/usr/bin', '/bin'].join(':')
  });
  Object.assign(values, agent?.sandbox.envSet);
  return values;
}

function addSystemMounts(args) {
  for (const candidate of ['/usr', '/etc']) {
    if (fs.existsSync(candidate)) args.push('--ro-bind', candidate, candidate);
  }
  for (const candidate of ['/bin', '/sbin', '/lib', '/lib64']) {
    if (!fs.existsSync(candidate)) continue;
    const metadata = fs.lstatSync(candidate);
    if (metadata.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(candidate), candidate);
    else args.push('--ro-bind', candidate, candidate);
  }
}

function addResolverMount(args) {
  const resolver = resolveExisting('/etc/resolv.conf');
  if (!resolver || resolver === '/etc/resolv.conf' || resolver.startsWith('/etc/')) return;
  addParentDirs(args, resolver);
  args.push('--ro-bind', resolver, resolver);
}

function addParentDirs(args, target) {
  const parts = path.resolve(target).split(path.sep).filter(Boolean);
  let current = '';
  for (const part of parts.slice(0, -1)) {
    current += `${path.sep}${part}`;
    args.push('--dir', current);
  }
}

function normalizedMounts(mounts) {
  const seen = new Set();
  const result = [];
  for (const mount of mounts) {
    const source = resolveExisting(mount.source);
    const target = path.resolve(mount.target);
    if (!source) throw new ALAError(`Sandbox mount source is unavailable: ${mount.source}`, EXIT_CODES.execution);
    const key = `${source}\0${target}\0${Boolean(mount.writable)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...mount, source, target, writable: Boolean(mount.writable) });
  }
  return result;
}

export function buildSandboxArgs({
  workspace,
  workspaceTarget = null,
  backend,
  binary,
  args = [],
  env = process.env,
  bwrap = findBubblewrap(env),
  privateProc = canMountPrivateProc(bwrap),
  home = null,
  folders = [],
  ignoredPaths = [],
  chdir = null
}) {
  if (!bwrap) {
    throw new ALAError(
      'Coding-agent execution requires Bubblewrap (bwrap at /usr/bin/bwrap, /bin/bwrap or ALA_BWRAP); no unsandboxed fallback is permitted.',
      EXIT_CODES.execution
    );
  }
  if (process.platform !== 'linux') {
    throw new ALAError(
      'Coding-agent execution through Bubblewrap is supported only on Linux.',
      EXIT_CODES.execution
    );
  }
  const hostWorkspace = resolveExisting(workspace);
  const command = resolveExisting(binary);
  const folderMounts = resolveFolderMounts(folders, process.cwd());
  if (!hostWorkspace || !command) {
    throw new ALAError('Coding-agent sandbox workspace or executable is unavailable.', EXIT_CODES.execution);
  }
  const agent = getAgent(backend);
  if (agent?.capabilities.privateProc && !privateProc) {
    const diagnostic = probeDiagnostics.get(bwrap);
    throw new ALAError(
      `${agent.label} requires a private /proc inside Bubblewrap, but the capability probe failed${diagnostic ? ` (${diagnostic})` : ''}. `
        + 'The container running ALA must allow a new procfs in a user namespace (for Podman: --security-opt unmask=/proc/*).',
      EXIT_CODES.execution
    );
  }
  const target = workspaceTarget ? path.resolve(workspaceTarget) : hostWorkspace;
  if (folderMounts.some((mount) => mount.target === target)) {
    throw new ALAError('A mounted folder duplicates the working directory.', EXIT_CODES.execution);
  }
  const outerCapabilityProc = privateProcModes.get(bwrap) === 'outer-cap';
  const sandboxArgs = ['--die-with-parent', '--new-session'];
  if (!outerCapabilityProc) sandboxArgs.push('--unshare-user');
  sandboxArgs.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--share-net');
  if (outerCapabilityProc) sandboxArgs.push('--cap-drop', 'ALL');
  sandboxArgs.push('--clearenv');
  addSystemMounts(sandboxArgs);
  addResolverMount(sandboxArgs);
  if (privateProc) sandboxArgs.push('--proc', '/proc');
  else sandboxArgs.push('--dir', '/proc');
  sandboxArgs.push('--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home');
  const explicitHome = resolveExisting(home);
  if (home && !explicitHome) throw new ALAError('Coding-agent home is unavailable.', EXIT_CODES.execution);
  if (explicitHome) sandboxArgs.push('--bind', explicitHome, SANDBOX_HOME);
  else sandboxArgs.push('--tmpfs', SANDBOX_HOME);

  const runtimeSources = new Set([
    ...collectAgentRuntimeMounts(command),
    ...collectAgentRuntimeMounts(process.execPath)
  ]);
  const runtimeMounts = sandboxRuntimeMounts(runtimeSources, target);
  for (const mount of normalizedMounts(runtimeMounts)) {
    addParentDirs(sandboxArgs, mount.target);
    sandboxArgs.push('--ro-bind', mount.source, mount.target);
  }

  const stateMounts = explicitHome ? [] : collectAgentStateMounts(backend, env).map((mount) => ({ ...mount }));
  for (const mount of normalizedMounts(stateMounts)) {
    addParentDirs(sandboxArgs, mount.target);
    sandboxArgs.push(mount.writable ? '--bind' : '--ro-bind', mount.source, mount.target);
  }

  // Mount ancestors before their descendants so a read-only parent cannot hide
  // the writable working directory mounted below it.
  const orderedMounts = [
    { source: hostWorkspace, target, writable: true, purpose: 'workspace' },
    ...folderMounts
  ].sort((left, right) => left.target.length - right.target.length);
  for (const mount of normalizedMounts(orderedMounts)) {
    addParentDirs(sandboxArgs, mount.target);
    sandboxArgs.push(mount.writable ? '--bind' : '--ro-bind', mount.source, mount.target);
  }
  const exposedMounts = [...runtimeMounts, ...stateMounts, ...orderedMounts,
    ...(explicitHome ? [{ source: explicitHome, target: SANDBOX_HOME }] : [])];
  for (const ignored of ignoredMountTargets(ignoredPaths, exposedMounts, chdir || target)) {
    sandboxArgs.push('--perms', '0555', '--tmpfs', ignored, '--remount-ro', ignored);
  }
  sandboxArgs.push('--remount-ro', '/');
  for (const [name, value] of Object.entries(sandboxEnvironment(backend, runtimeMounts, env))) {
    sandboxArgs.push('--setenv', name, value);
  }
  const commandMount = runtimeMounts.filter((mount) => command.startsWith(`${mount.source}/`))
    .sort((left, right) => right.source.length - left.source.length)[0];
  const sandboxCommand = commandMount
    ? path.join(commandMount.target, path.relative(commandMount.source, command)) : command;
  sandboxArgs.push('--chdir', chdir || target, '--', sandboxCommand, ...args);
  return sandboxArgs;
}
