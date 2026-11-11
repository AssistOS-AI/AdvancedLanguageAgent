import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli.mjs';
import { requireSandbox } from '../src/coding-agents/process.mjs';
import { buildSandboxArgs, canStartBubblewrap, findBubblewrap } from '../src/coding-agents/sandbox.mjs';
import {
  buildSandboxLaunch, sandboxBackend, sandboxCapabilities, sandboxLabel
} from '../src/coding-agents/sandbox-backend.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { requireStartableSeatbelt } from '../src/coding-agents/seatbelt.mjs';
import { captureStream, inputStream, onlyOnLinux } from './helpers.mjs';

const UNSUPPORTED = 'Coding-agent execution requires Linux (Bubblewrap) or macOS (Seatbelt); '
  + 'no unsandboxed fallback is permitted.';
const NO_LAUNCHER = 'Coding-agent execution on macOS requires /usr/bin/sandbox-exec (Seatbelt); '
  + 'no unsandboxed fallback is permitted.';
const LEAKED = 'The macOS Seatbelt sandbox does not hide other processes\' environments on this system; '
  + 'no unsandboxed fallback is permitted.';
const EXPECT_DIR = '--expect-dir requires descriptor binds, which the macOS Seatbelt sandbox cannot provide.';
const MOUNTS = '--cwd as <alias>, --folder as <alias>, --folder at <path> and expose need a mount namespace '
  + 'and are not supported on macOS.';
const macOS = process.platform === 'darwin' ? false : 'Seatbelt is macOS-only';
const exact = (text) => new RegExp(`^ala: ${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n$`, 'u');

test('linux selects Bubblewrap, darwin selects Seatbelt, and every other platform is refused with exit 5', () => {
  assert.equal(sandboxBackend({ platform: 'linux' }), 'bubblewrap');
  assert.equal(sandboxBackend({ platform: 'darwin' }), 'seatbelt');
  assert.equal(sandboxLabel({ platform: 'linux' }), 'Bubblewrap');
  assert.equal(sandboxLabel({ platform: 'darwin' }), 'Seatbelt');
  for (const platform of ['win32', 'freebsd', 'aix']) {
    assert.throws(() => sandboxBackend({ platform }), { exitCode: 5, message: UNSUPPORTED }, platform);
    assert.throws(() => sandboxCapabilities({}, { platform }), { exitCode: 5, message: UNSUPPORTED }, platform);
    assert.throws(() => buildSandboxLaunch({ sandbox: {}, binary: '/bin/true', args: [], stdio: [] }, { platform }),
      { exitCode: 5, message: UNSUPPORTED }, platform);
  }
});

test('the missing-sandbox message names the backend and keeps the Linux text', () => {
  const expected = process.platform === 'linux' ? 'Coding-agent processes must run inside the ALA Bubblewrap sandbox.'
    : `Coding-agent processes must run inside the ALA ${sandboxLabel()} sandbox.`;
  assert.throws(() => requireSandbox(null), { exitCode: 5, message: expected });
  assert.equal(`Coding-agent processes must run inside the ALA ${sandboxLabel({ platform: 'linux' })} sandbox.`,
    'Coding-agent processes must run inside the ALA Bubblewrap sandbox.');
});

test('Seatbelt capabilities use the fixed launcher, a satisfied private /proc and no descriptor binds', () => {
  const capabilities = sandboxCapabilities({ ALA_BWRAP: '/usr/bin/true' }, { platform: 'darwin' });
  assert.deepEqual({ ...capabilities, launcher: capabilities.launcher && 'present' }, {
    backend: 'seatbelt', launcher: existsSync('/usr/bin/sandbox-exec') ? 'present' : null,
    privateProc: true, bindDescriptors: false
  });
});

test('the Linux launch passes exactly the former Bubblewrap inputs and adds nothing', () => {
  const calls = [];
  const sandbox = { hostWorkspace: '/w', workspaceFd: 7, workspaceTarget: '/workspace/x', backend: 'pi',
    privateProc: true, home: '/h', folders: [{ source: '/f', target: '/f', fd: 8 }], ignoredPaths: ['/f/i'] };
  const launch = buildSandboxLaunch({ sandbox, binary: '/bin/agent', args: ['a'], cwd: '/workspace/x',
    env: { E: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }, {
    platform: 'linux',
    findBubblewrap: (env) => { calls.push(['find', env]); return '/usr/bin/bwrap'; },
    buildSandboxArgs: (input) => { calls.push(['build', input]); return ['--built']; }
  });
  assert.deepEqual(calls, [['find', { E: '1' }], ['build', {
    workspace: '/w', workspaceFd: 7, workspaceTarget: '/workspace/x', backend: 'pi', binary: '/bin/agent', args: ['a'],
    env: { E: '1' }, bwrap: '/usr/bin/bwrap', privateProc: true, home: '/h',
    folders: [{ source: '/f', target: '/f', fd: 8 }], ignoredPaths: ['/f/i'], chdir: '/workspace/x'
  }]]);
  assert.equal(launch.command, '/usr/bin/bwrap');
  assert.deepEqual(launch.args, ['--built']);
  assert.deepEqual(launch.options,
    { cwd: '/', env: { E: '1' }, stdio: ['ignore', 'pipe', 'pipe', 7, 8], detached: false });
  assert.equal(launch.attach({ kill: 'unchanged' }), undefined);
  const plain = buildSandboxLaunch({ sandbox: { hostWorkspace: '/w', bwrap: '/opt/bwrap' }, binary: '/bin/agent',
    args: [], env: {}, stdio: [] }, { platform: 'linux', buildSandboxArgs: () => [],
    findBubblewrap: () => assert.fail('an explicit bwrap is reused') });
  assert.equal(plain.command, '/opt/bwrap');
  assert.deepEqual(plain.options, { cwd: '/w', env: {}, stdio: [], detached: false });
});

test('the Linux launch equals the Bubblewrap launch of the same input', {
  skip: onlyOnLinux(canStartBubblewrap() ? false : 'Bubblewrap cannot start in this test process')
}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-launch-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'folder');
  await mkdir(folder);
  const env = { HOME: root, PATH: '/usr/bin:/bin', LANG: 'C' };
  const sandbox = { hostWorkspace: root, workspaceTarget: root, backend: 'codex', folders: [{ source: folder }],
    ignoredPaths: [], bwrap: findBubblewrap() };
  const launch = buildSandboxLaunch({ sandbox, binary: '/bin/sh', args: ['-c', 'true'], cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(launch.command, sandbox.bwrap);
  assert.deepEqual(launch.args, buildSandboxArgs({ workspace: root, workspaceFd: null, workspaceTarget: root,
    backend: 'codex', binary: '/bin/sh', args: ['-c', 'true'], env, bwrap: sandbox.bwrap, privateProc: undefined,
    home: undefined, folders: sandbox.folders, ignoredPaths: [], chdir: root }));
  assert.deepEqual(launch.options, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
});

test('Seatbelt start failures are refused with their exact texts', () => {
  let tick = 0;
  const now = () => { tick += 1; return tick * 3_600_000; };
  const probe = (result) => ({ findLauncher: () => '/usr/bin/sandbox-exec', now, spawnSyncImpl: () => result });
  assert.throws(() => requireStartableSeatbelt({ findLauncher: () => null }), { exitCode: 5, message: NO_LAUNCHER });
  assert.throws(() => requireStartableSeatbelt(probe({ status: 71, stdout: '',
    stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n' })), {
    exitCode: 5,
    message: 'The macOS Seatbelt sandbox could not start (sandbox-exec: sandbox_apply: Operation not permitted). '
      + 'ALA may already be running inside another macOS sandbox, which cannot be nested; '
      + 'no unsandboxed fallback is permitted.'
  });
  assert.throws(() => requireStartableSeatbelt(probe({ status: 0, stdout: 'other=READABLE own=READABLE\n' })),
    { exitCode: 5, message: LEAKED });
  // The reader's own read is the positive control: without it a silent reader would look like a refusal.
  assert.throws(() => requireStartableSeatbelt(probe({ status: 0, stdout: 'other=DENIED own=DENIED\n' })),
    { exitCode: 5, message: /could not start \(other=DENIED own=DENIED\)/u });
  assert.equal(requireStartableSeatbelt(probe({ status: 0, stdout: 'other=DENIED own=READABLE\n' })),
    '/usr/bin/sandbox-exec');
});

async function cliFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-refusal-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  const marker = join(root, 'agent-started');
  await Promise.all([mkdir(bin), mkdir(work), mkdir(join(root, 'home'))]);
  // A fake Codex only; HOME and PATH point at the fixture, so no installed agent is ever found or started.
  await writeFile(join(bin, 'codex'), `#!/bin/sh\n: > '${marker}'\nexit 0\n`);
  await chmod(join(bin, 'codex'), 0o700);
  const run = async (argv) => {
    const stderr = captureStream();
    const code = await runCli({ argv: ['--ca', 'codex', ...argv, 'task'], env: { HOME: join(root, 'home'), PATH: bin },
      stdin: inputStream(), stdout: captureStream(), stderr, cwd: root });
    return { code, stderr: stderr.read(), started: existsSync(marker) };
  };
  return { root, work, run };
}

test('macOS refuses --expect-dir with exit 5 before any agent starts', { skip: macOS }, async (context) => {
  const { work, run } = await cliFixture(context);
  const identity = await stat(work, { bigint: true });
  const result = await run(['--cwd', work, '--expect-dir', `${identity.dev}:${identity.ino}:${work}`]);
  assert.deepEqual(result.code, 5);
  assert.match(result.stderr, exact(EXPECT_DIR));
  assert.equal(result.started, false);
});

test('macOS refuses --cwd as <alias> and --folder at <path> with exit 5 before any agent starts', {
  skip: macOS
}, async (context) => {
  const { root, work, run } = await cliFixture(context);
  for (const argv of [['--cwd', work, 'as', 'x'], ['--cwd', work, '--folder', root, 'at', '/y'],
    ['--cwd', work, '--folder', join(root, 'bin'), 'as', 'tools'],
    ['--cwd', work, '--folder', root, 'at', '/y', 'expose']]) {
    const result = await run(argv);
    assert.equal(result.code, 5, argv.join(' '));
    assert.match(result.stderr, exact(MOUNTS), argv.join(' '));
    assert.equal(result.started, false);
  }
});

test('a platform stubbed as win32 exits 5 with the unsupported text before any agent starts', async (context) => {
  const { work, run } = await cliFixture(context);
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let result;
  try { result = await run(['--cwd', work]); }
  finally { Object.defineProperty(process, 'platform', { value: platform }); }
  assert.equal(result.code, 5);
  assert.match(result.stderr, exact(UNSUPPORTED));
  assert.equal(result.started, false);
});

test('a Seatbelt service refuses recorded identities and mount namespaces when it is created', {
  skip: macOS
}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-refusal-service-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agents = [{ name: 'codex', available: true, binary: '/usr/bin/true' }];
  const runners = { codex: () => assert.fail('no agent may run') };
  assert.throws(() => createCodingAgentService({ agents, workspace: root, workspaceIdentity: '1:1', runners }),
    { exitCode: 5, message: EXPECT_DIR });
  assert.throws(() => createCodingAgentService({ agents, workspace: root, folderIdentities: { [root]: '1:1' },
    runners }), { exitCode: 5, message: EXPECT_DIR });
  for (const folder of [{ source: root, alias: 'a' }, { source: root, target: '/y' }]) {
    assert.throws(() => createCodingAgentService({ agents, workspace: join(root, 'w'), folders: [folder], runners }),
      { exitCode: 5, message: MOUNTS });
  }
  assert.throws(() => createCodingAgentService({ agents, workspace: root, workspaceTarget: '/workspace/x', runners }),
    { exitCode: 5, message: MOUNTS });
  const plain = createCodingAgentService({ agents, workspace: root, workspaceTarget: root, runners });
  await plain.close();
});
