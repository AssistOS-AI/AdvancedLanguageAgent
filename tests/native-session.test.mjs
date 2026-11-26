import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli.mjs';
import { buildNativeSessionLaunch } from '../src/coding-agents/native-session.mjs';
import { agentFreeEnvironment, captureStream, inputStream, liveSandboxSkip } from './helpers.mjs';

const liveSkip = await liveSandboxSkip();
const WORKSPACE = '/tmp/ala-native-session-workspace';

// The launch description is inspected without a sandbox: the builder under test only assembles one.
function describeLaunch(overrides = {}) {
  return buildNativeSessionLaunch({
    agent: 'codex',
    binary: '/usr/bin/ala-test-agent',
    workspace: WORKSPACE,
    chdir: WORKSPACE,
    env: {},
    bwrap: '/usr/bin/bwrap',
    probePrivateProc: () => true,
    launch: (launch) => launch,
    ...overrides
  });
}

test('builds one full-access terminal launch inside the ALA sandbox', () => {
  const launch = describeLaunch({ nativeArgs: ['resume', 'abc-1'] });
  assert.equal(launch.sandbox.backend, 'codex');
  assert.equal(launch.sandbox.privateProc, true);
  // A terminal keeps the process group it was started in.
  assert.equal(launch.sandbox.newSession, false);
  assert.equal(launch.binary, '/usr/bin/env');
  assert.deepEqual(launch.args, ['/usr/bin/ala-test-agent', '--sandbox', 'danger-full-access',
    '--ask-for-approval', 'never', 'resume', 'abc-1']);
  assert.ok(launch.sandbox.runtimeBinaries.includes('/usr/bin/ala-test-agent'));
  assert.deepEqual(launch.stdio, ['inherit', 'inherit', 'inherit']);
});

test('leaves the native policy to a backend that can ask for approval', () => {
  const launch = describeLaunch({ permissions: 'ask-for-approval', nativeArgs: ['resume', 'abc-1'] });
  assert.equal(launch.binary, '/usr/bin/ala-test-agent');
  assert.deepEqual(launch.args, ['resume', 'abc-1']);
});

test('refuses ask-for-approval for a backend without an approval flow', () => {
  assert.throws(() => describeLaunch({ agent: 'pi', permissions: 'ask-for-approval' }),
    /supports full-access only/u);
});

test('starts a login shell first when the caller supplies one', () => {
  const launch = describeLaunch({ loginShell: '/bin/bash' });
  assert.equal(launch.binary, '/bin/bash');
  assert.deepEqual(launch.args.slice(0, 3), ['--login', '-c', 'exec "$0" "$@"']);
  assert.deepEqual(launch.args.slice(3), ['/usr/bin/env', '/usr/bin/ala-test-agent', '--sandbox',
    'danger-full-access', '--ask-for-approval', 'never']);
  for (const program of ['/usr/bin/ala-test-agent', '/usr/bin/env']) {
    assert.ok(launch.sandbox.runtimeBinaries.includes(program), program);
  }
});

test('refuses a native argument that is not a single token', () => {
  assert.throws(() => describeLaunch({ nativeArgs: ['resume two'] }), /--native-arg accepts one token/u);
});

test('refuses a coding-agent executable that is not absolute', () => {
  assert.throws(() => describeLaunch({ binary: 'ala-test-agent' }), /must be an absolute path/u);
});

test('refuses a host without a private process namespace', () => {
  assert.throws(() => describeLaunch({ probePrivateProc: () => false }), /private \/proc/u);
});

test('refuses an interactive session on a host without Bubblewrap', () => {
  // ALA_BWRAP names the only launcher that may be tried, so this host has none.
  assert.throws(() => describeLaunch({ bwrap: null, env: { ALA_BWRAP: '/nonexistent/bwrap' } }),
    /requires Bubblewrap/u);
});

test('refuses everything an interactive session does not own', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-native-refusals-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async (argv) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({ argv, env: { HOME: root, PATH: root }, stdin: inputStream(), stdout, stderr, cwd: root });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const refusals = [
    [['--native-interactive', '--ca', 'codex', 'do the task'], /accepts no task prompt/u],
    [['--native-interactive', '--taskFile', 'task.md'], /accepts no task prompt/u],
    [['--native-interactive', '--control-stdin'], /must not read --control-stdin/u],
    [['--native-interactive', '--session-id', 's', '--home', root, '--cwd', root], /keeps no transcript/u],
    [['--native-interactive', '--resume-session'], /keeps no transcript/u],
    [['--native-interactive', '--text', 'payload'], /accepts no --text/u],
    [['--native-interactive', '--expected-output', 'x'], /Unknown option/u],
    [['--native-interactive', '--output', 'result.txt'], /writes no result/u],
    [['--native-interactive', '--model', 'gpt-test'], /leaves model and effort selection/u],
    [['--native-interactive', '--effort', 'high'], /leaves model and effort selection/u],
    [['-i', '--native-interactive'], /cannot combine/u],
    [['--native-arg', 'resume', 'do the task'], /require --native-interactive/u],
    [['--login-shell', '/bin/bash', 'do the task'], /require --native-interactive/u],
    [['--runtime-binary', '/usr/bin/node', 'do the task'], /require --native-interactive/u]
  ];
  for (const [argv, message] of refusals) {
    const result = await run(argv);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message, argv.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('a session without --cwd starts in the folder the caller is in, not in the home', { skip: liveSkip },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'ala-native-cwd-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'fake-codex');
    await writeFile(binary, '#!/bin/sh\nprintf \'pwd:%s home:%s\\n\' "$PWD" "$HOME"\nexit 0\n');
    await chmod(binary, 0o700);
    const work = join(root, 'work');
    const home = join(root, 'home');
    await mkdir(work);
    await mkdir(home);
    const env = await agentFreeEnvironment(home, { PATH: root, CODEX_BIN: binary, TMPDIR: root });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({
      argv: ['--native-interactive', '--ca', 'codex', '--home', home],
      env,
      stdin: inputStream(),
      stdout,
      stderr,
      cwd: work
    });
    assert.equal(code, 0, stderr.read());
    // The home is the agent's own; the working folder stays the one the caller started ALA in.
    assert.equal(stdout.read().trim(), `pwd:${realpathSync(work)} home:/home/ala`);
  });

test('runs the coding agent in the caller streams and reports its own exit status', { skip: liveSkip },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'ala-native-session-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'fake-codex');
    await writeFile(binary, '#!/bin/sh\nread line\nprintf \'agent:%s\\n\' "$line"\nexit 7\n');
    await chmod(binary, 0o700);
    const work = join(root, 'work');
    const home = join(root, 'home');
    await mkdir(work);
    await mkdir(home);
    const env = await agentFreeEnvironment(home, { PATH: root, CODEX_BIN: binary, TMPDIR: root });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({
      argv: ['--native-interactive', '--ca', 'codex', '--home', home, '--cwd', work],
      env,
      stdin: inputStream('typed in this terminal\n'),
      stdout,
      stderr,
      cwd: work
    });
    assert.equal(code, 7, stderr.read());
    // The prompt was typed by the caller: ALA forwarded standard input without reading it.
    assert.equal(stdout.read(), 'agent:typed in this terminal\n');
    assert.equal(stderr.read(), '');
  });
