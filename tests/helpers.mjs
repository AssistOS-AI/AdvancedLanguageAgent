import { mkdir, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { join } from 'node:path';

export function captureStream() {
  let content = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      content += chunk.toString();
      callback();
    }
  });
  stream.read = () => content;
  return stream;
}

export function inputStream(content = '', { tty = false } = {}) {
  const stream = Readable.from([content]);
  stream.isTTY = tty;
  return stream;
}

export async function writeCodeSkill(root, name, actionSource = 'return args.promptText;') {
  const skillDir = join(root, 'skills', name);
  await mkdir(join(skillDir, 'src'), { recursive: true });
  const descriptor = `# ${name}\n\n## Description\n${name} test skill.\n\n## Input Format\nPlain text.\n`;
  await writeFile(join(skillDir, 'cskill.md'), descriptor);
  await writeFile(join(skillDir, 'src', 'index.mjs'), `export async function action(args) { ${actionSource} }\n`);
  return skillDir;
}

export async function writeAnthropicSkill(root, name, {
  description = `${name} test skill.`,
  body = `# ${name}\n\n## Instructions\nFollow the user request.`
} = {}) {
  const skillDir = join(root, 'skills', name);
  await mkdir(skillDir, { recursive: true });
  const descriptor = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  await writeFile(join(skillDir, 'SKILL.md'), descriptor);
  return skillDir;
}

// Test classification by sandbox backend. A Bubblewrap-only test (its arguments, ALA_BWRAP, descriptor binds,
// /workspace aliases or Bubblewrap's mask semantics) keeps its own condition on Linux and is skipped elsewhere
// with this one reason, which DS006 lists. A backend-neutral live test runs wherever a sandbox can start.
export const BUBBLEWRAP_ONLY = 'Bubblewrap only (Linux): arguments, ALA_BWRAP, descriptor binds, aliases '
  + 'or tmpfs masks';

export function onlyOnLinux(linuxSkip = false) {
  return process.platform === 'linux' ? linuxSkip : BUBBLEWRAP_ONLY;
}

export const NO_SANDBOX_PLATFORM = 'Coding-agent sandboxes exist only on Linux and macOS';

let sandboxStartable;
export async function liveSandboxSkip() {
  const { canStartSandbox, sandboxLabel } = await import('../src/coding-agents/sandbox-backend.mjs');
  if (!['linux', 'darwin'].includes(process.platform)) return NO_SANDBOX_PLATFORM;
  sandboxStartable ??= canStartSandbox();
  return sandboxStartable ? false : `${sandboxLabel()} cannot start in this test process`;
}

// Every variable through which an installed agent, its state, its credentials or the caller's ALA configuration
// could reach a test: each agent's binary override, state and home variables, its allowed and credential
// variables, OpenCode's XDG folders, and ALA's configuration and session roots.
export async function agentVariableNames() {
  const { AGENTS } = await import('../src/coding-agents/registry.mjs');
  const names = new Set(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'ALA_CONFIG_PATH',
    'ALA_SESSIONS']);
  for (const agent of AGENTS) {
    for (const name of [agent.binary.env, ...agent.sandbox.envAllow, ...agent.sandbox.credentialEnv,
      ...Object.keys(agent.homeEnvironment('/'))]) names.add(name);
  }
  return [...names].sort();
}

// An environment for a test that starts a sandboxed process. spawnProcess merges process.env below it, so every
// agent variable is set here: empty means unset to ALA. HOME is the fixture's; overrides come last.
// ALA_BWRAP is kept: it selects the sandbox launcher, not an agent, and a host that has Bubblewrap only there
// must give the service the same launcher the skip checks found.
export async function agentFreeEnvironment(home, overrides = {}) {
  const cleared = Object.fromEntries((await agentVariableNames()).map((name) => [name, '']));
  const launcher = process.env.ALA_BWRAP ? { ALA_BWRAP: process.env.ALA_BWRAP } : {};
  return { ...cleared, HOME: home, ...launcher, ...overrides };
}

// Runs fn with os.tmpdir() inside a fixture, so a workspace ALA creates for a run without --cwd lands there.
export async function withTemporaryRoot(root, fn) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}
