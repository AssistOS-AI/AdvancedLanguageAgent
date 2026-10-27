import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALAError, EXIT_CODES } from '../src/errors.mjs';
import { runProcess, spawnProcess } from '../src/coding-agents/process.mjs';
import { createBubblewrapProvider } from '../src/coding-agents/provider-bubblewrap.mjs';
import { buildSandboxArgs } from '../src/coding-agents/sandbox.mjs';
import { legacySpawnProcess } from './fixtures/legacy-spawn-process.mjs';

// Standalone behaviour is unchanged by the provider interface. These tests capture the real spawn call: the
// launcher's executable, argument vector, working directory, environment and stdio. They run on any host by
// presenting a Linux platform and a fake launcher; buildSandboxArgs only builds an argument vector.
async function withLinuxPlatform(body) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return await body(); } finally { Object.defineProperty(process, 'platform', original); }
}

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-provider-bwrap-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const make = async (name) => { const path = join(root, name); await mkdir(path); return path; };
  const [workspace, readOnly, writable, home] = [await make('workspace'), await make('ro'), await make('rw'), await make('home')];
  return { root, workspace, readOnly, writable, home };
}

function launchOf(f, extra = {}) {
  return {
    binary: process.execPath, args: ['--version'], cwd: f.workspace,
    env: { OPENAI_API_KEY: 'k', ALA_X: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    sandbox: { hostWorkspace: f.workspace, workspaceTarget: f.workspace, backend: 'codex', home: f.home, ignoredPaths: [],
      folders: [{ source: f.readOnly, target: f.readOnly, writable: false },
        { source: f.writable, target: f.writable, writable: true }], ...extra }
  };
}

test('the Bubblewrap provider spawns exactly the call the direct launcher made before the interface existed', async (context) => {
  const f = await fixture(context);
  const calls = [];
  const spawnImpl = (...call) => { calls.push(call); return { fake: true }; };
  const originalContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  context.after(() => {
    if (originalContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalContext;
  });
  await withLinuxPlatform(async () => {
    // The request shape the service built before: capabilities carried in the sandbox context.
    const legacy = createBubblewrapProvider({ spawnImpl, capabilities: { bwrap: '/unused', privateProc: false } });
    const launch = launchOf(f, { bwrap: '/fake/bwrap', privateProc: true });
    legacy.start({ processClass: 'run', ...launch });
    // The shape the service builds now: capabilities come from the provider's constructor-time probe.
    const probed = createBubblewrapProvider({ spawnImpl, capabilities: { bwrap: '/fake/bwrap', privateProc: true } });
    probed.start({ processClass: 'run', ...launchOf(f) });
    const expectedArgs = buildSandboxArgs({
      workspace: f.workspace, workspaceTarget: f.workspace, backend: 'codex', binary: process.execPath, args: ['--version'],
      env: { ...process.env, OPENAI_API_KEY: 'k', ALA_X: '1', NODE_TEST_CONTEXT: undefined }, bwrap: '/fake/bwrap', privateProc: true,
      home: f.home, folders: launch.sandbox.folders, ignoredPaths: [], chdir: f.workspace
    });
    assert.equal(calls.length, 2);
    for (const [file, args, options] of calls) {
      assert.equal(file, '/fake/bwrap');
      assert.deepEqual(args, expectedArgs);
      assert.equal(options.cwd, f.workspace);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.env.NODE_TEST_CONTEXT, undefined, 'the test-runner context never reaches the launcher');
      assert.equal(options.env.OPENAI_API_KEY, 'k');
      assert.equal(options.env.ALA_X, '1');
    }
    assert.deepEqual(calls[0][1], calls[1][1]);
    // Host-independent literals of the fixed input: namespace head, home and mount order, and the exec tail.
    const args = calls[0][1];
    assert.deepEqual(args.slice(0, 8), ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid',
      '--unshare-ipc', '--unshare-uts', '--share-net', '--clearenv']);
    const at = (...needle) => args.findIndex((_, index) => needle.every((value, offset) => args[index + offset] === value));
    const mounts = [['--bind', f.home, '/home/ala'], ['--ro-bind', f.readOnly, f.readOnly],
      ['--bind', f.writable, f.writable], ['--bind', f.workspace, f.workspace], ['--remount-ro', '/']].map((m) => at(...m));
    assert.ok(mounts.every((index) => index >= 0), 'every mount of the fixed input is present');
    assert.deepEqual([...mounts].sort((x, y) => x - y), mounts, 'mounts keep their order and remount last');
    assert.deepEqual(args.slice(-5), ['--chdir', f.workspace, '--', process.execPath, '--version']);
    assert.equal(args.filter((value) => value === '--setenv').length >= 12, true);
  });
});

// The launcher is a recording script, so each side makes a real spawn call whose argument vector, working directory and
// environment are read back. The "before" side is the base revision's spawnProcess, copied verbatim into a fixture.
async function recordingLauncher(root, name) {
  const output = join(root, `${name}.out`);
  const launcher = join(root, `${name}-bwrap`);
  await writeFile(launcher, `#!/bin/sh\n{ for a in "$@"; do printf '%s\\n' "$a"; done; printf 'CWD=%s\\n' "$(pwd -P)"; `
    + `env | grep -v -E '^(PWD|OLDPWD|SHLVL|_)=' | sort; } > '${output}'\n`, { mode: 0o755 });
  await chmod(launcher, 0o755);
  return { launcher, read: async () => (await readFile(output, 'utf8')).replaceAll(root, '<ROOT>') };
}

test('before and after: the base revision spawnProcess and the Bubblewrap provider make the identical spawn call', async (context) => {
  const f = await fixture(context);
  const before = await recordingLauncher(f.root, 'before');
  const after = await recordingLauncher(f.root, 'after');
  const afterNoContext = await recordingLauncher(f.root, 'after-probed');
  const originalContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  context.after(() => {
    if (originalContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalContext;
  });
  const closed = (child) => new Promise((resolve) => child.once('close', resolve));
  await withLinuxPlatform(async () => {
    const launch = (bwrap, extra = {}) => ({ ...launchOf(f, { ...(bwrap ? { bwrap, privateProc: true } : {}) }), ...extra });
    // The sandbox context the service built before carries the launcher and the probe result.
    const legacyChild = legacySpawnProcess(launch(before.launcher));
    await closed(legacyChild);
    const provider = createBubblewrapProvider({ capabilities: { bwrap: '/unused', privateProc: false } });
    const providerChild = spawnProcess({ ...launch(after.launcher), sandbox: { ...launch(after.launcher).sandbox, provider } });
    await closed(providerChild);
    // The context the service builds now carries neither: the provider's constructor-time probe supplies both.
    const probed = createBubblewrapProvider({ capabilities: { bwrap: afterNoContext.launcher, privateProc: true } });
    const probedChild = spawnProcess({ ...launch(null), sandbox: { ...launch(null).sandbox, provider: probed } });
    await closed(probedChild);
  });
  const reference = await before.read();
  assert.match(reference, /^--die-with-parent\n--new-session\n--unshare-user\n/u);
  assert.match(reference, /\n--chdir\n<ROOT>\/workspace\n--\n/u);
  assert.match(reference, /\nOPENAI_API_KEY=k\n/u);
  assert.equal(/NODE_TEST_CONTEXT/u.test(reference), false);
  assert.equal(await after.read(), reference, 'provider call equals the base call');
  assert.equal(await afterNoContext.read(), reference, 'provider-supplied capabilities give the same call');
});

test('a missing launcher or an unsupported platform still fails closed through the provider', async (context) => {
  const f = await fixture(context);
  const provider = createBubblewrapProvider({ spawnImpl: () => assert.fail('nothing may start'),
    capabilities: { bwrap: null, privateProc: false } });
  await withLinuxPlatform(async () => {
    assert.throws(() => provider.start({ processClass: 'run', ...launchOf(f) }),
      (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.execution
        && /requires Bubblewrap \(bwrap\); no unsandboxed fallback is permitted/.test(error.message));
  });
  const darwin = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    assert.throws(() => createBubblewrapProvider({ spawnImpl: () => assert.fail('nothing may start'),
      capabilities: { bwrap: '/fake/bwrap', privateProc: true } }).start({ processClass: 'run', ...launchOf(f) }),
    /supported only on Linux/);
  } finally { Object.defineProperty(process, 'platform', darwin); }
});

test('process start without a provider is an error: there is no direct-start branch', async () => {
  assert.throws(() => spawnProcess({ binary: process.execPath, args: ['-e', ''], cwd: process.cwd(), stdio: 'ignore' }),
    (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.execution
      && /require an execution provider/.test(error.message));
  assert.throws(() => spawnProcess({ binary: process.execPath, args: [], cwd: process.cwd(), sandbox: {} }),
    /require an execution provider/);
  await assert.rejects(runProcess({ binary: process.execPath, args: ['-e', ''], cwd: process.cwd() }),
    /require an execution provider/);
  const marker = join(await mkdtemp(join(tmpdir(), 'ala-no-direct-')), 'ran');
  await assert.rejects(runProcess({ binary: process.execPath, cwd: process.cwd(),
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] }), /execution provider/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await rm(join(marker, '..'), { recursive: true, force: true });
});

test('spawnProcess hands the provider the process class and the launch description unchanged', () => {
  const seen = [];
  const provider = { kind: 'recording', start: (request) => { seen.push(request); return {}; } };
  const sandbox = { provider, backend: 'pi' };
  spawnProcess({ binary: '/b', args: ['a'], cwd: '/c', env: { E: '1' }, stdio: 'x', sandbox, processClass: 'service',
    lifecycle: { readyTimeoutMs: 5 } });
  spawnProcess({ binary: '/b', args: [], cwd: '/c', stdio: 'x', sandbox });
  assert.equal(seen[0].processClass, 'service');
  assert.deepEqual(seen[0].lifecycle, { readyTimeoutMs: 5 });
  assert.equal(seen[0].sandbox, sandbox);
  assert.equal(seen[1].processClass, 'run');
});
