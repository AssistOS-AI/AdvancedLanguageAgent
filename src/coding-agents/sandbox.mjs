import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { SANDBOX_WORKSPACE } from './paths.mjs';

const SANDBOX_HOME = '/home/ala';
const PROBE_CACHE_TTL_MS = 30_000;
const privateProcSupport = new Map();
const privateProcModes = new Map();
const sandboxSupport = new Map();
const probeDiagnostics = new Map();

const SHARED_ENVIRONMENT = Object.freeze([
  'LANG', 'LANGUAGE', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
]);
const PROVIDER_ENVIRONMENT = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_API_KEY', 'COHERE_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION',
  'AWS_DEFAULT_REGION', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD'
]);

export function findBubblewrap() {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
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
  userNamespaceArgs.push('--proc', '/proc', '--', '/usr/bin/true');
  if (probeBubblewrap(privateProcSupport, bwrap, userNamespaceArgs, dependencies)) {
    privateProcModes.set(bwrap, 'userns');
    return true;
  }
  const outerCapabilityArgs = ['--die-with-parent', '--unshare-pid', '--cap-drop', 'ALL'];
  addSystemMounts(outerCapabilityArgs);
  outerCapabilityArgs.push('--proc', '/proc', '--', '/usr/bin/true');
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
  args.push('--dir', '/proc', '--', '/usr/bin/true');
  return probeBubblewrap(sandboxSupport, bwrap, args, dependencies);
}

export function bubblewrapProbeDiagnostic(bwrap) {
  return probeDiagnostics.get(bwrap) || '';
}

function probeBubblewrap(cache, bwrap, args, dependencies = {}) {
  const now = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
  const spawn = typeof dependencies.spawnSyncImpl === 'function' ? dependencies.spawnSyncImpl : spawnSync;
  const cached = cache.get(bwrap);
  if (cached?.expiresAt > now) return true;
  cache.delete(bwrap);
  let diagnostic = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawn(bwrap, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      maxBuffer: 64 * 1024,
      timeout: 5000
    });
    if (result.status === 0 && !result.error) {
      cache.set(bwrap, { expiresAt: now + PROBE_CACHE_TTL_MS });
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
  const openCodeMarker = `${path.sep}.opencode${path.sep}`;
  const openCodeIndex = resolved.indexOf(openCodeMarker);
  if (openCodeIndex >= 0) {
    return [resolved.slice(0, openCodeIndex + openCodeMarker.length - 1)];
  }
  return [path.dirname(resolved)];
}

function stateMount(source, target) {
  const resolved = resolveExisting(source);
  return resolved ? { source: resolved, target, writable: true, purpose: 'agent-state' } : null;
}

export function collectAgentStateMounts(backend, env = process.env) {
  const home = path.resolve(env.HOME || homedir());
  if (backend === 'codex') {
    const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
    return [stateMount(codexHome, `${SANDBOX_HOME}/.codex`)].filter(Boolean);
  }
  if (backend === 'opencode') {
    const configHome = path.resolve(env.XDG_CONFIG_HOME || path.join(home, '.config'));
    const dataHome = path.resolve(env.XDG_DATA_HOME || path.join(home, '.local', 'share'));
    const cacheHome = path.resolve(env.XDG_CACHE_HOME || path.join(home, '.cache'));
    const stateHome = path.resolve(env.XDG_STATE_HOME || path.join(home, '.local', 'state'));
    return [
      stateMount(path.join(configHome, 'opencode'), `${SANDBOX_HOME}/.config/opencode`),
      stateMount(path.join(dataHome, 'opencode'), `${SANDBOX_HOME}/.local/share/opencode`),
      stateMount(path.join(cacheHome, 'opencode'), `${SANDBOX_HOME}/.cache/opencode`),
      stateMount(path.join(stateHome, 'opencode'), `${SANDBOX_HOME}/.local/state/opencode`)
    ].filter(Boolean);
  }
  if (backend === 'pi') {
    const configured = env.PI_CODING_AGENT_DIR
      ? path.resolve(env.PI_CODING_AGENT_DIR)
      : path.join(home, '.pi', 'agent');
    return [stateMount(configured, `${SANDBOX_HOME}/.pi/agent`)].filter(Boolean);
  }
  return [];
}

function runtimeSearchPaths(runtimeMounts) {
  const candidates = [];
  for (const mount of runtimeMounts) {
    for (const candidate of [path.join(mount.target, 'bin'), mount.target]) {
      if (fs.existsSync(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

export function sandboxEnvironment(backend, runtimeMounts = [], env = process.env) {
  const values = {};
  const allowed = new Set([
    ...SHARED_ENVIRONMENT,
    ...(backend === 'codex' ? ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT'] : []),
    ...(['opencode', 'pi'].includes(backend) ? PROVIDER_ENVIRONMENT : []),
    ...(backend === 'opencode' ? ['OPENCODE_ENABLE_EXA'] : [])
  ]);
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
  if (backend === 'codex') {
    values.CODEX_HOME = `${SANDBOX_HOME}/.codex`;
  }
  if (backend === 'pi') {
    values.PI_CODING_AGENT_DIR = `${SANDBOX_HOME}/.pi/agent`;
    values.PI_OFFLINE = '1';
    values.PI_SKIP_VERSION_CHECK = '1';
  }
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
  backend,
  binary,
  args = [],
  mounts = [],
  env = process.env,
  bwrap = findBubblewrap(),
  privateProc = canMountPrivateProc(bwrap),
  home = null,
  chdir = SANDBOX_WORKSPACE
}) {
  if (!bwrap) {
    throw new ALAError(
      'Coding-agent execution requires Bubblewrap (bwrap); no unsandboxed fallback is permitted.',
      EXIT_CODES.execution
    );
  }
  if (process.platform !== 'linux') {
    throw new ALAError('Coding-agent execution through Bubblewrap is supported only on Linux.', EXIT_CODES.execution);
  }
  const hostWorkspace = resolveExisting(workspace);
  const command = resolveExisting(binary);
  if (!hostWorkspace || !command) {
    throw new ALAError('Coding-agent sandbox workspace or executable is unavailable.', EXIT_CODES.execution);
  }
  if (['codex', 'opencode'].includes(backend) && !privateProc) {
    const diagnostic = probeDiagnostics.get(bwrap);
    throw new ALAError(
      `${backend === 'codex' ? 'Codex' : 'OpenCode'} requires a private /proc inside Bubblewrap, but the capability probe failed${diagnostic ? ` (${diagnostic})` : ''}.`,
      EXIT_CODES.execution
    );
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

  const runtimeMounts = collectAgentRuntimeMounts(command).map((source) => ({
    source, target: source, writable: false, purpose: 'agent-runtime'
  }));
  for (const mount of normalizedMounts(runtimeMounts)) {
    addParentDirs(sandboxArgs, mount.target);
    sandboxArgs.push('--ro-bind', mount.source, mount.target);
  }

  addParentDirs(sandboxArgs, SANDBOX_WORKSPACE);
  sandboxArgs.push('--bind', hostWorkspace, SANDBOX_WORKSPACE);

  const stateMounts = explicitHome ? [] : collectAgentStateMounts(backend, env).map((mount) => ({ ...mount }));
  const allMounts = normalizedMounts([...stateMounts, ...mounts]);
  for (const mount of allMounts) {
    addParentDirs(sandboxArgs, mount.target);
    sandboxArgs.push(mount.writable ? '--bind' : '--ro-bind', mount.source, mount.target);
  }
  sandboxArgs.push('--remount-ro', '/');
  for (const [name, value] of Object.entries(sandboxEnvironment(backend, runtimeMounts, env))) {
    sandboxArgs.push('--setenv', name, value);
  }
  sandboxArgs.push('--chdir', chdir, '--', command, ...args);
  return sandboxArgs;
}
