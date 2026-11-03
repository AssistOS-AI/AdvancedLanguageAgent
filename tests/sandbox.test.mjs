import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('sandbox home is validated at import and backend profiles follow its target', () => {
  const script = `
    const { SANDBOX_HOME } = await import('./src/coding-agents/paths.mjs');
    const { sandboxEnvironment } = await import('./src/coding-agents/sandbox.mjs');
    const { AGENTS } = await import('./src/coding-agents/registry.mjs');
    const { resolveFolderMounts } = await import('./src/coding-agents/folders.mjs');
    const profiles = AGENTS.map(agent => ({ env: sandboxEnvironment(agent.name, [], {}),
      targets: agent.state({}, '/host').map(entry => entry.target) }));
    let reserved = false;
    try { resolveFolderMounts([{source: process.cwd(), target: SANDBOX_HOME + '/child'}]); }
    catch (error) { reserved = error.exitCode === 2; }
    console.log(JSON.stringify({ home: SANDBOX_HOME, profiles, reserved }));
  `;
  const run = value => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, ALA_SANDBOX_HOME: value }
  });
  const result = run('/home/abc');
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.home, '/home/abc');
  assert.equal(actual.reserved, true);
  for (const { env, targets } of actual.profiles) {
    assert.equal(env.HOME, '/home/abc');
    assert.equal(env.USER, 'abc');
    assert.equal(env.LOGNAME, 'abc');
    assert.equal(env.XDG_CONFIG_HOME, '/home/abc/.config');
    assert.ok(targets.length > 0 && targets.every(target => target.startsWith('/home/abc/')));
    assert.equal(JSON.stringify(env).includes('/home/ala'), false);
  }
  for (const value of ['', 'relative', '/', '/home', '/home/..', '/home/abc/', '/home/abc/def', '/etc/abc']) {
    const invalid = run(value);
    assert.notEqual(invalid.status, 0, value);
    assert.match(invalid.stderr, /ALA_SANDBOX_HOME must be a normalized/);
  }
});

test('file ignores mask canonical and aliased paths and newSession defaults to true', {
  skip: process.platform !== 'linux' ? 'Linux sandbox validation' : false
}, async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-file-mask-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const secret = join(workspace, '.env');
  await writeFile(secret, 'private');
  const input = { workspace, backend: 'pi', binary: process.execPath, bwrap: '/usr/bin/bwrap',
    privateProc: false, folders: [{ source: workspace, alias: 'copy' }], ignoredPaths: [secret] };
  const args = buildSandboxArgs(input);
  assert.equal(args.includes('--new-session'), true);
  assert.equal(buildSandboxArgs({ ...input, newSession: false }).includes('--new-session'), false);
  for (const target of [secret, '/workspace/copy/.env']) {
    assert.equal(args.some((value, i) => value === '--ro-bind'
      && args[i + 1] === '/dev/null' && args[i + 2] === target), true);
  }
  assert.equal(await readFile(secret, 'utf8'), 'private');
});

test('file ignores hide contents and deny writes inside a live sandbox', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async context => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ala-file-mask-live-')));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const secret = join(workspace, '.env');
  await writeFile(secret, 'private');
  const result = await runProcess({
    binary: process.execPath, cwd: workspace,
    args: ['-e', `const fs = require('node:fs');
      for (const target of [${JSON.stringify(secret)}, '/workspace/copy/.env']) {
        try { if (fs.readFileSync(target, 'utf8') !== '') process.exit(10); }
        catch (error) { if (error.code !== 'EACCES') throw error; }
        try { fs.writeFileSync(target, 'leak'); process.exit(11); } catch {}
      }`],
    sandbox: { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'pi',
      folders: [{ source: workspace, alias: 'copy' }], ignoredPaths: [secret] }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(secret, 'utf8'), 'private');
});

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

test('uses an outer capability only to construct private procfs in a nested container', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-nested-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let attempts = 0;
  const nestedBwrap = '/fake/bwrap-nested';
  assert.equal(canMountPrivateProc(nestedBwrap, {
    spawnSyncImpl(_command, args) {
      attempts += 1;
      if (args.includes('--unshare-user')) {
        return { status: 1, error: null, stdout: '', stderr: 'proc mount denied in nested user namespace' };
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    }
  }), true);
  assert.equal(attempts, 3);
  // A cached outer-capability success must never certify the userns probe.
  assert.equal(canMountPrivateProc(nestedBwrap, {
    spawnSyncImpl(_command, probeArgs) {
      assert.equal(probeArgs.includes('--unshare-user'), true);
      return { status: 1, stderr: 'proc mount denied in nested user namespace' };
    }
  }), true);
  const args = buildSandboxArgs({
    workspace,
    backend: 'codex',
    binary: process.execPath,
    bwrap: nestedBwrap,
    privateProc: true
  });
  assert.equal(args.includes('--unshare-user'), false);
  assert.equal(args.some((value, index) => value === '--cap-drop' && args[index + 1] === 'ALL'), true);
  assert.equal(args.some((value, index) => value === '--proc' && args[index + 1] === '/proc'), true);
});

test('builds a fail-closed Bubblewrap namespace with explicit mount access', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-args-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const readOnly = join(root, 'read-only');
  const writable = join(root, 'writable');
  const home = join(root, 'home');
  const codexState = join(home, '.codex');
  await Promise.all([mkdir(workspace), mkdir(readOnly), mkdir(writable), mkdir(codexState, { recursive: true })]);
  const args = buildSandboxArgs({
    workspace,
    backend: 'codex',
    binary: process.execPath,
    args: ['--version'],
    env: { HOME: home },
    folders: [{ source: readOnly }, { source: writable, writable: true }],
    bwrap,
    privateProc: true
  });
  assert.equal(args.includes('--share-net'), true);
  assert.equal(args.includes('--clearenv'), true);
  assert.equal(args.some((value, index) => value === '--remount-ro' && args[index + 1] === '/'), true);
  assert.equal(args.some((value, index) => (
    value === '--bind' && args[index + 1] === writable && args[index + 2] === writable
  )), true);
  assert.equal(args.some((value, index) => value === '--ro-bind' && args[index + 1] === readOnly && args[index + 2] === readOnly), true);
  assert.equal(args.some((value, index) => value === '--bind' && args[index + 1] === workspace && args[index + 2] === workspace), true);
  assert.equal(args.some((value, index) => (
    value === '--bind' && args[index + 1] === codexState && args[index + 2] === '/home/ala/.codex'
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
  const runtimeBin = runtimeRoot ? join(runtimeRoot, 'bin') : '/usr/local/bin';
  assert.equal(args[pathIndex + 2].startsWith(`${runtimeBin}:`), true);
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
  assert.equal(codex.CODEX_HOME, '/home/ala/.codex');

  const pi = sandboxEnvironment('pi', [], { ANTHROPIC_API_KEY: 'provider-secret' });
  assert.equal(pi.ANTHROPIC_API_KEY, 'provider-secret');
  assert.equal(pi.PI_CODING_AGENT_DIR, '/home/ala/.pi/agent');
  assert.equal(pi.PI_OFFLINE, '1');
});

test('enforces read-only and writable folder mounts at their canonical paths', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-sandbox-live-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const readOnly = join(root, 'read-only');
  const writable = join(root, 'writable');
  const outside = join(root, 'outside.txt');
  await Promise.all([mkdir(workspace), mkdir(readOnly), mkdir(writable)]);
  await Promise.all([writeFile(join(readOnly, 'book.txt'), 'book data'), writeFile(outside, 'outside')]);
  const script = `
const fs = require('node:fs');
const result = {
  cwd: process.cwd(),
  book: fs.readFileSync(${JSON.stringify(join(readOnly, 'book.txt'))}, 'utf8')
};
for (const [name, target] of Object.entries({ readWrite: ${JSON.stringify(join(readOnly, 'new.txt'))} })) {
  try { fs.writeFileSync(target, 'denied'); result[name] = 'allowed'; } catch { result[name] = 'denied'; }
}
fs.writeFileSync(${JSON.stringify(join(writable, 'result.txt'))}, 'persisted');
fs.writeFileSync(${JSON.stringify(join(workspace, 'artifact.txt'))}, 'workspace');
try { fs.readFileSync(${JSON.stringify(outside)}); result.outside = 'visible'; } catch { result.outside = 'hidden'; }
process.stdout.write(JSON.stringify(result));
`;
  const result = await runProcess({
    binary: process.execPath,
    args: ['-e', script],
    cwd: workspace,
    env: { HOME: join(root, 'missing-home') },
    sandbox: {
      hostWorkspace: workspace,
      workspaceTarget: workspace,
      backend: 'codex',
      folders: [
        { source: readOnly },
        { source: writable, writable: true }
      ]
    }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: workspace, book: 'book data', readWrite: 'denied', outside: 'hidden'
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
    cwd: workspace,
    env: { HOME: join(root, 'missing-home') },
    signal: controller.signal,
    sandbox: { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'codex' }
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(execution, { name: 'AbortError' });
});

test('runs a prefix-installed ESM backend with sibling dependencies and the Node runtime', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-prefix-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const modules = join(root, 'installation', 'node_modules');
  const packageRoot = join(modules, 'native-agent');
  const dependency = join(modules, 'native-dependency');
  await Promise.all([
    mkdir(workspace),
    mkdir(join(packageRoot, 'dist'), { recursive: true }),
    mkdir(dependency, { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), '{"type":"module"}'),
    writeFile(join(dependency, 'package.json'), '{"type":"module","exports":"./index.js"}'),
    writeFile(join(dependency, 'index.js'), 'export default "dependency-loaded";')
  ]);
  const binary = join(packageRoot, 'dist', 'cli.js');
  await writeFile(binary, '#!/usr/bin/env node\nimport value from "native-dependency";\n'
    + 'console.log(JSON.stringify({value,node:process.versions.node}));\n', { mode: 0o755 });
  const result = await runProcess({
    binary, args: [], cwd: workspace,
    env: { HOME: join(root, 'missing-home') },
    sandbox: { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'pi' }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    value: 'dependency-loaded', node: process.versions.node
  });
});

test('mounts a writable cwd and a read-only parent at their canonical paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ala-canonical-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'robot');
  await mkdir(workspace);
  const args = buildSandboxArgs({ workspace, workspaceTarget: workspace, backend: 'pi', binary: process.execPath,
    bwrap: '/usr/bin/bwrap', privateProc: false,
    folders: [{ source: root }] });
  const parent = args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === root);
  const child = args.findIndex((value, index) => value === '--bind' && args[index + 1] === workspace);
  assert.ok(parent >= 0 && child >= 0);
  assert.equal(args[parent + 2], root);
  assert.equal(args[child + 2], workspace);
  assert.equal(args[args.indexOf('--chdir') + 1], workspace);
  assert.equal(args.some(value => value.includes('.agents')), false);
});

test('ALA_BWRAP selects an explicit Bubblewrap binary and is never replaced by the system one', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-bwrap-override-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'bwrap');
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(findBubblewrap({ ALA_BWRAP: binary }), await realpath(binary));
  assert.equal(findBubblewrap({ ALA_BWRAP: join(root, 'missing') }), null);
  assert.equal(findBubblewrap({ ALA_BWRAP: 'bwrap' }), null, 'a relative name is refused');
  assert.equal(findBubblewrap({}), findBubblewrap());
});
