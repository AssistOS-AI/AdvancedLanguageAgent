import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import {
  buildSandboxArgs,
  bubblewrapProbeDiagnostic,
  canMountPrivateProc,
  canStartBubblewrap,
  collectAgentRuntimeMounts,
  collectAgentStateMounts,
  findBubblewrap,
  sandboxEnvironment
} from '../src/coding-agents/sandbox.mjs';

const bwrap = findBubblewrap();
const sandboxSupported = canStartBubblewrap(bwrap);

test('Bubblewrap capability probes include the dynamic runtime libraries', () => {
  const calls = [];
  const dependencies = {
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return { status: 0, error: null, stdout: '', stderr: '' };
    }
  };
  assert.equal(canMountPrivateProc('/fake/bwrap-private', dependencies), true);
  assert.equal(canStartBubblewrap('/fake/bwrap-start', dependencies), true);
  for (const { args } of calls) {
    for (const candidate of ['/lib', '/lib64']) {
      if (args.includes(candidate)) assert.equal(args.includes(candidate), true);
    }
    assert.equal(args.includes('/usr'), true);
    assert.equal(args.includes('/usr/bin/true'), true);
    assert.equal(args.includes('/proc'), true);
  }
});

test('Bubblewrap capability probes recover from one transient failure', () => {
  let attempts = 0;
  const supported = canMountPrivateProc('/fake/bwrap-retry', {
    spawnSyncImpl() {
      attempts += 1;
      return attempts === 1
        ? { status: 44, error: null, stdout: '', stderr: 'temporary namespace failure' }
        : { status: 0, error: null, stdout: '', stderr: '' };
    }
  });
  assert.equal(supported, true, bubblewrapProbeDiagnostic('/fake/bwrap-retry'));
  assert.equal(attempts, 2);
});

test('builds a fail-closed Bubblewrap namespace with explicit mount access', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-args-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const skill = join(root, 'skill');
  const writable = join(root, 'writable');
  const home = join(root, 'home');
  const codexState = join(home, '.codex');
  await Promise.all([mkdir(workspace), mkdir(skill), mkdir(writable), mkdir(codexState, { recursive: true })]);
  const args = buildSandboxArgs({
    workspace,
    backend: 'codex',
    binary: process.execPath,
    args: ['--version'],
    env: { HOME: home },
    mounts: [
      { source: skill, target: '/workspace/.agents/skills/test', writable: false },
      { source: writable, target: '/workspace/.ala/folders/write', writable: true }
    ],
    bwrap,
    privateProc: true
  });
  assert.equal(args.includes('--share-net'), true);
  assert.equal(args.includes('--clearenv'), true);
  assert.equal(args.some((value, index) => value === '--remount-ro' && args[index + 1] === '/'), true);
  assert.equal(args.some((value, index) => (
    value === '--bind' && args[index + 1] === writable
      && args[index + 2] === '/workspace/.ala/folders/write'
  )), true);
  assert.equal(args.some((value, index) => value === '--ro-bind' && args[index + 1] === skill), true);
  assert.equal(args.some((value, index) => value === '--bind' && args[index + 2] === '/workspace'), true);
  assert.equal(args.some((value, index) => (
    value === '--bind' && args[index + 1] === codexState && args[index + 2] === codexState
  )), true);
  assert.equal(args.some((value, index) => (
    ['--bind', '--ro-bind'].includes(value) && args[index + 1] === home
  )), false);
  const resolver = await realpath('/etc/resolv.conf');
  if (resolver !== '/etc/resolv.conf' && !resolver.startsWith('/etc/')) {
    assert.equal(args.some((value, index) => (
      value === '--ro-bind' && args[index + 1] === resolver && args[index + 2] === resolver
    )), true);
  }
  assert.equal(args.some((value, index) => value === '--ro-bind' && args[index + 1] === '/'), false);
  const pathIndex = args.findIndex((value, index) => value === '--setenv' && args[index + 1] === 'PATH');
  const runtimeRoot = collectAgentRuntimeMounts(process.execPath)[0];
  const runtimeBin = runtimeRoot.endsWith('/bin') ? runtimeRoot : `${runtimeRoot}/bin`;
  assert.match(args[pathIndex + 2], new RegExp(`^${runtimeBin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:`));
  assert.throws(() => buildSandboxArgs({
    workspace, backend: 'codex', binary: process.execPath, bwrap: null
  }), /requires Bubblewrap/);
  assert.throws(() => buildSandboxArgs({
    workspace, backend: 'opencode', binary: process.execPath, bwrap, privateProc: false
  }), /requires a private \/proc/);
  assert.throws(() => buildSandboxArgs({
    workspace, backend: 'codex', binary: process.execPath, bwrap, privateProc: false
  }), /requires a private \/proc/);
});

test('uses backend-specific state and environment profiles', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-profile-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const piState = join(root, '.pi', 'agent');
  await mkdir(piState, { recursive: true });
  assert.deepEqual(collectAgentStateMounts('pi', { HOME: root }), [{
    source: await realpath(piState),
    target: '/home/ala/.pi/agent',
    writable: true,
    purpose: 'agent-state'
  }]);

  const codexHome = join(root, '.codex');
  const codex = sandboxEnvironment('codex', [], {
    HOME: root,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'openai-secret',
    ANTHROPIC_API_KEY: 'unrelated-secret',
    UNRELATED_SECRET: 'hidden'
  });
  assert.equal(codex.OPENAI_API_KEY, 'openai-secret');
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  assert.equal(codex.UNRELATED_SECRET, undefined);
  assert.equal(codex.HOME, '/home/ala');
  assert.equal(codex.CODEX_HOME, codexHome);

  const pi = sandboxEnvironment('pi', [], { ANTHROPIC_API_KEY: 'provider-secret' });
  assert.equal(pi.ANTHROPIC_API_KEY, 'provider-secret');
  assert.equal(pi.PI_CODING_AGENT_DIR, '/home/ala/.pi/agent');
  assert.equal(pi.PI_OFFLINE, '1');
});

test('enforces read-only skills and folders while preserving explicit writable mounts', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-live-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const skill = join(root, 'skill');
  const readOnly = join(root, 'read-only');
  const writable = join(root, 'writable');
  const outside = join(root, 'outside.txt');
  await Promise.all([
    mkdir(join(workspace, '.agents', 'skills', 'test'), { recursive: true }),
    mkdir(join(workspace, '.ala', 'folders', 'read'), { recursive: true }),
    mkdir(join(workspace, '.ala', 'folders', 'write'), { recursive: true }),
    mkdir(skill), mkdir(readOnly), mkdir(writable)
  ]);
  await Promise.all([
    writeFile(join(skill, 'SKILL.md'), 'strict skill'),
    writeFile(join(readOnly, 'book.txt'), 'book data'),
    writeFile(outside, 'outside')
  ]);
  const script = `
const fs = require('node:fs');
const result = {
  cwd: process.cwd(),
  skill: fs.readFileSync('/workspace/.agents/skills/test/SKILL.md', 'utf8'),
  book: fs.readFileSync('/workspace/.ala/folders/read/book.txt', 'utf8')
};
for (const [name, target] of Object.entries({ skillWrite: '/workspace/.agents/skills/test/new.txt', readWrite: '/workspace/.ala/folders/read/new.txt' })) {
  try { fs.writeFileSync(target, 'denied'); result[name] = 'allowed'; } catch { result[name] = 'denied'; }
}
fs.writeFileSync('/workspace/.ala/folders/write/result.txt', 'persisted');
fs.writeFileSync('/workspace/artifact.txt', 'workspace');
try { fs.readFileSync(${JSON.stringify(outside)}); result.outside = 'visible'; } catch { result.outside = 'hidden'; }
process.stdout.write(JSON.stringify(result));
`;
  const result = await runProcess({
    binary: process.execPath,
    args: ['-e', script],
    cwd: '/workspace',
    env: { HOME: join(root, 'missing-home') },
    sandbox: {
      hostWorkspace: workspace,
      backend: 'codex',
      mounts: [
        { source: skill, target: '/workspace/.agents/skills/test', writable: false },
        { source: readOnly, target: '/workspace/.ala/folders/read', writable: false },
        { source: writable, target: '/workspace/.ala/folders/write', writable: true }
      ]
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: '/workspace', skill: 'strict skill', book: 'book data',
    skillWrite: 'denied', readWrite: 'denied', outside: 'hidden'
  });
  assert.equal(await readFile(join(writable, 'result.txt'), 'utf8'), 'persisted');
  assert.equal(await readFile(join(workspace, 'artifact.txt'), 'utf8'), 'workspace');
});

test('cancels the Bubblewrap process tree through the active child handle', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-cancel-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const controller = new AbortController();
  const execution = runProcess({
    binary: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: '/workspace',
    env: { HOME: join(root, 'missing-home') },
    signal: controller.signal,
    sandbox: { hostWorkspace: workspace, backend: 'codex', mounts: [] }
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(execution, { name: 'AbortError' });
});
