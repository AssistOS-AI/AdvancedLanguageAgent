import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ALAError, EXIT_CODES } from '../errors.mjs';
import { resolveFolderMounts } from './folders.mjs';
import { ignoredMounts } from './ignored-paths.mjs';
import { SANDBOX_HOME } from './paths.mjs';
import { getAgent } from './registry.mjs';
import { collectAgentStateMounts, sandboxEnvironment } from './sandbox.mjs';
import { buildSeatbeltProfile } from './seatbelt-profile.mjs';
import { linksOnPath, seatbeltRuntimeRoots, seatbeltSearchPath, seatbeltSystemRoots } from './seatbelt-roots.mjs';

// A fixed path with no override: a replaced launcher could run agents unconfined.
export const SEATBELT_LAUNCHER = '/usr/bin/sandbox-exec';
const SUPERVISOR = fs.realpathSync(fileURLToPath(new URL('./seatbelt-supervisor.mjs', import.meta.url)));
// The supervisor's descriptor that reaches end-of-file when ALA dies; it follows the three standard streams.
const WATCH_FD = 3;
const PROBE_CACHE_TTL_MS = 30_000;
const PERL = '/usr/bin/perl';
// Reads kern.procargs2 (CTL_KERN 1, KERN_PROCARGS2 49) through sysctl(2), system call 202, without any module.
const READER = 'sub rd { my $mib = pack("i3", 1, 49, shift); my $buf = "\\0" x 262144; my $len = pack("Q", 262144); '
  + 'return syscall(202, $mib, 3, $buf, $len, 0, 0) == 0 ? "READABLE" : "DENIED"; } '
  + 'print "other=" . rd($ARGV[0]) . " own=" . rd($$) . "\\n";';
const PROBE_PASS = 'other=DENIED own=READABLE';
const seatbeltSupport = new Map();
const probeFailures = new Map();
const changed = (source) => new ALAError(`A granted directory changed or is unavailable: ${source}`,
  EXIT_CODES.directoryChanged);
let processFolders = null;

export function findSeatbelt() {
  try {
    const metadata = fs.statSync(SEATBELT_LAUNCHER);
    fs.accessSync(SEATBELT_LAUNCHER, fs.constants.X_OK);
    return metadata.isFile() ? SEATBELT_LAUNCHER : null;
  } catch { return null; }
}

export function seatbeltProbeFailure(launcher = SEATBELT_LAUNCHER) {
  return probeFailures.get(launcher) || null;
}

// The start probe runs a reader under the real base rules: reading ALA's own kern.procargs2 must be refused, and
// the reader's own must succeed, which proves the reader ran. Any other outcome refuses every agent.
export function canStartSeatbelt(launcher = findSeatbelt(), dependencies = {}) {
  if (!launcher) return false;
  const now = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
  const spawn = typeof dependencies.spawnSyncImpl === 'function' ? dependencies.spawnSyncImpl : spawnSync;
  const shape = typeof dependencies.profile === 'function' ? dependencies.profile : (profile) => profile;
  const built = buildSeatbeltProfile({ systemRoots: seatbeltSystemRoots() });
  const args = ['-p', shape(built.profile), ...built.params.flatMap((value) => ['-D', value]),
    PERL, '-e', READER, String(process.pid)];
  const cacheKey = JSON.stringify([launcher, args]);
  if (seatbeltSupport.get(cacheKey)?.expiresAt > now) return true;
  seatbeltSupport.delete(cacheKey);
  let failure = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawn(launcher, args, { cwd: '/', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
      maxBuffer: 64 * 1024, timeout: 5000 });
    const output = String(result.stdout || '').trim();
    if (result.status === 0 && !result.error && output === PROBE_PASS) {
      seatbeltSupport.set(cacheKey, { expiresAt: now + PROBE_CACHE_TTL_MS });
      probeFailures.delete(launcher);
      return true;
    }
    failure = {
      leaked: output.startsWith('other=READABLE'),
      diagnostic: String(result.error?.message || result.stderr || output || `exit ${result.status ?? 'unknown'}`)
        .replace(/[\r\n\t]+/gu, ' ').trim().slice(-512)
    };
  }
  probeFailures.set(launcher, failure);
  return false;
}

// Returns the launcher, or throws one of the three fail-closed errors (exit 5).
export function requireStartableSeatbelt({ findLauncher = findSeatbelt, ...probeDependencies } = {}) {
  const launcher = findLauncher();
  if (!launcher) {
    throw new ALAError('Coding-agent execution on macOS requires /usr/bin/sandbox-exec (Seatbelt); '
      + 'no unsandboxed fallback is permitted.', EXIT_CODES.execution);
  }
  if (canStartSeatbelt(launcher, probeDependencies)) return launcher;
  const failure = seatbeltProbeFailure(launcher);
  if (failure?.leaked) {
    throw new ALAError('The macOS Seatbelt sandbox does not hide other processes\' environments on this system; '
      + 'no unsandboxed fallback is permitted.', EXIT_CODES.execution);
  }
  throw new ALAError(`The macOS Seatbelt sandbox could not start (${failure?.diagnostic || 'unknown'}). `
    + 'ALA may already be running inside another macOS sandbox, which cannot be nested; '
    + 'no unsandboxed fallback is permitted.', EXIT_CODES.execution);
}

export const UNSUPPORTED_MOUNTS_MESSAGE = '--cwd as <alias>, --folder as <alias>, --folder at <path> and expose '
  + 'need a mount namespace and are not supported on macOS.';

function realOrNull(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

// A requested --cwd alias, --folder alias, --folder at or expose: Seatbelt shows every directory at its own path.
export function usesMountNamespace({ workspace = null, workspaceTarget = null, folders = [] }) {
  return Boolean(workspaceTarget && (!workspace || realOrNull(workspaceTarget) !== realOrNull(workspace)))
    || folders.some((folder) => folder.alias !== undefined || folder.target !== undefined || folder.expose);
}

// The same rule for resolved mounts: each must be visible where it already is on the host.
function needsMountNamespace(hostWorkspace, workspaceTarget, mounts) {
  return Boolean(workspaceTarget && realOrNull(workspaceTarget) !== hostWorkspace)
    || mounts.some((mount) => mount.expose || realOrNull(mount.target) !== mount.source);
}

// Seatbelt rules follow paths, so every granted directory is re-checked against its recorded identity before
// each spawn. A host process that swapped a path would otherwise redirect a rule.
function checkIdentities(identities = []) {
  for (const { source, identity } of identities) {
    let stat;
    try {
      if (fs.realpathSync(source) !== source) throw new Error('moved');
      stat = fs.statSync(source, { bigint: true });
    } catch { throw changed(source); }
    if (!stat.isDirectory() || `${stat.dev}:${stat.ino}` !== identity) throw changed(source);
  }
}

// Directories found at launch (the workspace, an explicit home, each state folder) are recorded on first use and
// re-checked on every later spawn of the same service: a path that now resolves elsewhere, or names another
// directory, exits 78 as a changed --cwd or --folder does.
function recordOrCheck(record, key, source) {
  if (!record) return;
  let identity = null;
  try {
    const stat = fs.statSync(source, { bigint: true });
    if (stat.isDirectory()) identity = `${stat.dev}:${stat.ino}`;
  } catch {}
  const previous = record.get(key);
  if (!previous) {
    if (!identity) throw changed(source);
    record.set(key, { source, identity });
  } else if (previous.source !== source || previous.identity !== identity) throw changed(previous.source);
}

// Links through which the user or ALA starts this program unconfined: the path given here, and each place discovery
// looks (the override variable, the standard install paths, PATH) that resolves to the same program. Discovery
// hands over the resolved path, so the links are found again from those places. Node's path is passed as well, but
// process.execPath is already resolved and yields no link: links through which a user starts Node (a Homebrew bin
// link, for example) are not found or guarded here.
function programLinks(backend, binary, command, env) {
  const location = getAgent(backend)?.binary;
  const candidates = [binary];
  if (location) {
    candidates.push(env[location.env], ...location.installPaths(env.HOME || os.homedir()));
    for (const folder of String(env.PATH || '').split(':').filter(Boolean)) candidates.push(path.join(folder, backend));
  }
  const links = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && path.isAbsolute(candidate) && realOrNull(candidate) === command) {
      links.push(...linksOnPath(candidate));
    }
  }
  return [...links, ...linksOnPath(process.execPath)];
}

// The agent's state folders appear at their re-rooted targets as links into the real folders.
function linkState(stateMounts, home) {
  for (const { source, target } of stateMounts) {
    const relative = path.relative(SANDBOX_HOME, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const link = path.join(home, relative);
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    fs.symlinkSync(source, link);
  }
}

function reRoot(values, home) {
  const result = {};
  for (const [name, value] of Object.entries(values)) {
    result[name] = value === SANDBOX_HOME ? home
      : value.startsWith(`${SANDBOX_HOME}/`) ? `${home}${value.slice(SANDBOX_HOME.length)}` : value;
  }
  return result;
}

// Removes a private folder and never throws: cleanup runs in child-process listeners and at exit, where an
// exception would crash ALA and lose the turn's result. A descendant that left the process group may still be
// swapping folders for links in the private folder, so nothing in ALA's own unconfined process walks its content:
// the removal, and when it fails the repair of permissions and flags, run in helpers confined by Seatbelt to the
// folder itself, so the kernel refuses any effect on another file whatever the paths resolve to at that instant.
// If the helpers cannot run (for example inside another sandbox), the folder is left and reported once; there is
// no unconfined fallback.
export const CLEANUP_PROFILE = `(version 1)
(deny default)
(allow process-exec* (literal "/bin/chmod") (literal "/bin/rm") (literal "/usr/bin/chflags"))
(allow file-read*)
(allow sysctl-read)
(allow file-write* (subpath (param "TARGET")))
`;
// A removal first; when it fails, flags, so a directory can be made searchable, owner access, flags again for what
// the first pass could not reach, and the removal once more. Measured on macOS 27.2.1 for 50,000 files: removal
// 2.9 s, owner access 1.4 s, flags 0.2 s; a normal private folder takes about 11 ms. A step that times out has
// still made progress, and the stale sweep of a later run continues it.
const REMOVE = Object.freeze({ command: ['/bin/rm', '-rf'], timeout: 10_000 });
const REPAIR = Object.freeze([['/usr/bin/chflags', '-R', '-P', 'nouchg,nouappnd'], ['/bin/chmod', '-R', '-P', 'u+rwx'],
  ['/usr/bin/chflags', '-R', '-P', 'nouchg,nouappnd']].map((command) => ({ command, timeout: 5_000 })));
const reported = new Set();

function removeConfined(folder) {
  let real;
  try { real = fs.realpathSync(folder); } catch (error) { return error.code === 'ENOENT'; }
  if (real !== folder || folder.includes('\0') || path.normalize(folder) !== folder || !path.isAbsolute(folder)) {
    return false;
  }
  const gone = () => { try { fs.lstatSync(folder); return false; } catch (error) { return error.code === 'ENOENT'; } };
  const confined = ({ command, timeout }) => spawnSync(SEATBELT_LAUNCHER,
    ['-p', CLEANUP_PROFILE, '-D', `TARGET=${folder}`, ...command, folder], { stdio: 'ignore', env: {}, timeout });
  confined(REMOVE);
  if (gone()) return true;
  for (const step of REPAIR) confined(step);
  confined(REMOVE);
  return gone();
}

function report(folder, synchronous) {
  if (reported.has(folder)) return;
  reported.add(folder);
  const message = `ALA could not remove the Seatbelt private folder ${folder}; a later run tries again.`;
  try {
    // At process exit an asynchronous warning would be lost.
    if (synchronous) fs.writeSync(2, `Warning: ${message}\n`);
    else process.emitWarning(message);
  } catch {}
}

export function removePrivateFolder(folder, { synchronous = false } = {}) {
  try { if (removeConfined(folder)) return true; } catch {}
  report(folder, synchronous);
  return false;
}

const BASE_PREFIX = 'ala-seatbelt-';
const BASE_NAME = /^ala-seatbelt-(\d+)-[A-Za-z0-9]{6}$/u;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// ALA killed with SIGKILL cannot remove its folders; a later ALA removes those of dead owners. Only real
// folders of this user named by the pattern, directly in the temporary root, are considered.
function sweepStaleBases(root) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const name of entries) {
    const owner = Number(BASE_NAME.exec(name)?.[1]);
    if (!owner || owner === process.pid || processAlive(owner)) continue;
    const candidate = path.join(root, name);
    try {
      const metadata = fs.lstatSync(candidate);
      if (!metadata.isDirectory() || metadata.uid !== process.getuid()) continue;
      removePrivateFolder(candidate);
    } catch {}
  }
}

// One process exit listener removes every base still open, however many services were created.
const openBases = new Set();
function removeOpenBases() {
  for (const base of openBases) removePrivateFolder(base, { synchronous: true });
  openBases.clear();
}

// One base folder per owner, created on first use. Each process gets <base>/<N>/tmp, and <base>/<N>/home unless an
// explicit home is used, removed when the process closes; the base is removed by close() and at process exit.
export function createPrivateFolders({ temporaryRoot = os.tmpdir() } = {}) {
  let base = null;
  return {
    get base() { return base; },
    allocate({ withHome = true } = {}) {
      if (!base) {
        const root = fs.realpathSync(temporaryRoot);
        sweepStaleBases(root);
        base = fs.mkdtempSync(path.join(root, `${BASE_PREFIX}${process.pid}-`));
        if (openBases.size === 0) process.once('exit', removeOpenBases);
        openBases.add(base);
      }
      const folder = fs.mkdtempSync(path.join(base, 'p-'));
      const temp = path.join(folder, 'tmp');
      fs.mkdirSync(temp, { mode: 0o700 });
      const home = withHome ? path.join(folder, 'home') : null;
      if (home) fs.mkdirSync(home, { mode: 0o700 });
      return { folder, home, temp, release: () => removePrivateFolder(folder) };
    },
    close() {
      if (!base) return;
      removePrivateFolder(base);
      openBases.delete(base);
      base = null;
      if (openBases.size === 0) process.removeListener('exit', removeOpenBases);
    }
  };
}

function processFolderPool() {
  processFolders ??= createPrivateFolders();
  return processFolders;
}

export function buildSeatbeltLaunch({ sandbox, binary, args = [], cwd = null, env = process.env, stdio }) {
  requireStartableSeatbelt();
  checkIdentities(sandbox.identities);
  const hostWorkspace = realOrNull(sandbox.hostWorkspace);
  const command = realOrNull(binary);
  if (!hostWorkspace || !command) {
    throw new ALAError('Coding-agent sandbox workspace or executable is unavailable.', EXIT_CODES.execution);
  }
  const folders = resolveFolderMounts(sandbox.folders || [], process.cwd());
  if (needsMountNamespace(hostWorkspace, sandbox.workspaceTarget, folders)) {
    throw new ALAError(UNSUPPORTED_MOUNTS_MESSAGE, EXIT_CODES.execution);
  }
  if (folders.some((mount) => mount.source === hostWorkspace)) {
    throw new ALAError('A mounted folder duplicates the working directory.', EXIT_CODES.execution);
  }
  const explicitHome = sandbox.home ? realOrNull(sandbox.home) : null;
  if (sandbox.home && !explicitHome) throw new ALAError('Coding-agent home is unavailable.', EXIT_CODES.execution);
  const runtimeRoots = seatbeltRuntimeRoots(command, { runtimeBinaries: sandbox.runtimeBinaries || [] });
  const stateMounts = explicitHome ? [] : collectAgentStateMounts(sandbox.backend, env);
  recordOrCheck(sandbox.recorded, 'workspace', hostWorkspace);
  if (explicitHome) recordOrCheck(sandbox.recorded, 'home', explicitHome);
  for (const { source, target } of stateMounts) recordOrCheck(sandbox.recorded, `state:${target}`, source);
  // A state folder seen before must still exist: its absence would hide a swap behind a missing link. A folder
  // legitimately deleted on the host therefore fails every later spawn of this service with 78 until ALA restarts;
  // this fails closed on purpose.
  for (const key of sandbox.recorded?.keys() || []) {
    if (key.startsWith('state:') && !stateMounts.some(({ target }) => key === `state:${target}`)) {
      throw changed(sandbox.recorded.get(key).source);
    }
  }
  const mounts = [{ source: hostWorkspace, writable: true }, ...folders];
  const exposed = [...runtimeRoots.map((root) => ({ source: root, target: root })),
    ...stateMounts.map(({ source }) => ({ source, target: source })),
    ...mounts.map(({ source, writable }) => ({ source, target: source, writable })),
    ...(explicitHome ? [{ source: explicitHome, target: explicitHome }] : [])];
  const masks = ignoredMounts(sandbox.ignoredPaths || [], exposed, cwd || hostWorkspace);
  const pool = sandbox.privateFolders || processFolderPool();
  const allocated = pool.allocate({ withHome: !explicitHome });
  try {
    const home = explicitHome || allocated.home;
    if (!explicitHome) linkState(stateMounts, home);
    const environment = {
      ...reRoot(sandboxEnvironment(sandbox.backend, [], env), home),
      TMPDIR: allocated.temp,
      PATH: seatbeltSearchPath(runtimeRoots)
    };
    const { profile, params } = buildSeatbeltProfile({
      systemRoots: seatbeltSystemRoots(), runtimeRoots, mounts, masks, home, temp: allocated.temp,
      stateRoots: stateMounts.map(({ source }) => source), supervisor: SUPERVISOR,
      links: programLinks(sandbox.backend, binary, command, env)
    }, { realpath: fs.realpathSync });
    return {
      command: SEATBELT_LAUNCHER,
      args: ['-p', profile, ...params.flatMap((value) => ['-D', value]),
        process.execPath, SUPERVISOR, String(WATCH_FD), command, ...args],
      options: { cwd: cwd || hostWorkspace, env: environment, stdio: [...stdio, 'pipe'], detached: true },
      attach: (child) => attachGroup(child, allocated.release),
      // For a spawn that throws before attach: the private folder is not left until close().
      release: allocated.release
    };
  } catch (error) {
    allocated.release();
    throw error;
  }
}

// After a signal other than SIGKILL, a group that has not exited is killed: the command receives a group signal
// directly and may ignore it, while the supervisor waits for it.
export const GROUP_KILL_DELAY_MS = 2000;
// Only a request to end the group is followed up; signal 0 and other signals are just sent.
const TERMINATING = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 15, 2, 1]);

// sandbox-exec replaces itself with the supervisor, so the child's PID leads a new session and process group.
function attachGroup(child, release) {
  let ended = false;
  const signalGroup = (signal) => {
    if (ended || !child.pid) return false;
    try { process.kill(-child.pid, signal); return true; } catch { return false; }
  };
  child.kill = (signal = 'SIGTERM') => {
    const sent = signalGroup(signal);
    if (sent && TERMINATING.has(signal)) {
      setTimeout(() => signalGroup('SIGKILL'), GROUP_KILL_DELAY_MS).unref();
    }
    return sent;
  };
  child.once('exit', () => {
    signalGroup('SIGKILL');
    // After exit the group ID may be reused, so kill stays a no-op from here, as Node's own does.
    ended = true;
  });
  const watch = child.stdio[WATCH_FD];
  watch?.on('error', () => {});
  watch?.unref?.();
  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    try { release(); } catch {}
  };
  child.once('close', cleanup);
  child.once('error', cleanup);
  return child;
}

export function closeProcessFolders() {
  processFolders?.close();
  processFolders = null;
}
