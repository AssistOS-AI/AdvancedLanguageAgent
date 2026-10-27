import {
  DEFAULT_STOP_GRACE_MS, NETWORK_MODES, ROBOT_HOME, SERVICE_READY_TIMEOUT_MS,
  providerError, providerText, requireProcessClass
} from './provider.mjs';
import { virtualPathProblem } from './virtual-paths.mjs';

// Variables the provider owns. An embedded execution cannot add them: HOME, XDG and native state paths must agree
// with the robot HOME that only the provider applies at the final exec.
const RESERVED_ENVIRONMENT = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'
]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// Backend controls that the standalone sandbox environment sets (sandboxEnvironment) and the provider cannot know:
// Claude Code needs IS_SANDBOX to accept bypassPermissions as root, and every self-updater and version check stays
// off because nothing is installed or downloaded at run time. They are explicit additions keyed on the backend.
// The provider owns HOME, XDG and the native state paths (CODEX_HOME, CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR).
const BACKEND_CONTROLS = Object.freeze({
  claude: Object.freeze({ IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' }),
  pi: Object.freeze({ PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' })
});

// Embedded ALA starts with a cleared environment and its explicit additions are the only values that cross the
// protocol. Additions are the entries that differ from ALA's own environment, so a value that merely exists in
// ALA's process (for example a credential) is never forwarded, and a value equal to ALA's own is treated as
// inherited and dropped. The one exception is a name the adapter generated itself (`generated`), which is forwarded
// even when it happens to equal an inherited value.
export function environmentAdditions(env, baseEnv = process.env, generated = []) {
  const additions = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value !== 'string' || (baseEnv?.[name] === value && !generated.includes(name))) continue;
    if (!ENVIRONMENT_NAME.test(name) || value.includes('\0')) {
      throw providerError(`Invalid execution-provider environment name: ${providerText(name)}`);
    }
    if (RESERVED_ENVIRONMENT.has(name) || name.startsWith('XDG_')) {
      throw providerError(`The execution provider owns the environment variable ${name}.`);
    }
    additions[name] = value;
  }
  return additions;
}

function describeCommunication(processClass, stdio) {
  const stdin = Array.isArray(stdio) && stdio[0] === 'ignore' ? 'ignore' : 'pipe';
  return processClass === 'service'
    ? { kind: 'service', endpoint: 'loopback-port', stdin }
    : { kind: 'streams', stdin };
}

// The version-1 start request: the section 5.3 field table and nothing more. `request` is the in-process launch
// description built by spawnProcess; `baseEnv` is ALA's own environment.
export function describeProcessRequest(request, { baseEnv = process.env } = {}) {
  const processClass = requireProcessClass(request.processClass);
  const { binary, args, cwd, sandbox } = request;
  if (typeof binary !== 'string' || !binary || binary.includes('\0')) {
    throw providerError('Execution-provider request needs a backend name or an absolute executable path.');
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw providerError('Execution-provider arguments must be strings.');
  }
  const home = sandbox?.home ?? ROBOT_HOME;
  if (home !== ROBOT_HOME) throw providerError(`The execution provider accepts only HOME ${ROBOT_HOME}.`);
  const paths = [['working directory', cwd], ...(sandbox?.folders || []).map((folder) => ['folder', folder.target]),
    ...(sandbox?.ignoredPaths || []).map((entry) => ['exclusion', entry])];
  for (const [label, value] of paths) {
    const problem = virtualPathProblem(value);
    if (problem) throw providerError(`Execution-provider ${label} ${problem}.`);
  }
  const network = request.network ?? 'robot-egress';
  if (!NETWORK_MODES.includes(network)) {
    throw providerError(`Unknown execution-provider network mode: ${providerText(network)}`);
  }
  const lifecycle = { stopGraceMs: request.lifecycle?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS };
  if (request.lifecycle?.deadlineMs !== undefined) lifecycle.deadlineMs = request.lifecycle.deadlineMs;
  if (processClass === 'service') {
    lifecycle.ready = { condition: 'announced-endpoint',
      timeoutMs: request.lifecycle?.readyTimeoutMs ?? SERVICE_READY_TIMEOUT_MS };
  }
  return {
    processClass,
    executable: binary,
    args: [...args],
    env: { ...environmentAdditions(request.env, baseEnv, request.generatedEnv), ...BACKEND_CONTROLS[sandbox?.backend] },
    home,
    cwd,
    folders: (sandbox?.folders || []).map((folder) => ({
      path: folder.target, access: folder.writable ? 'write' : 'read'
    })),
    exclusions: [...(sandbox?.ignoredPaths || [])],
    communication: describeCommunication(processClass, request.stdio),
    lifecycle,
    network,
    requirements: { privateProc: true }
  };
}
