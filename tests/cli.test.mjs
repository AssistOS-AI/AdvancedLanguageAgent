import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { captureStream, inputStream } from './helpers.mjs';

const sandboxSupported = canStartBubblewrap();

test('keeps help output separate from diagnostics', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({ argv: ['--help'], env: {}, stdin: inputStream(), stdout, stderr, cwd: process.cwd() });
  assert.equal(code, 0);
  const help = stdout.read();
  assert.match(help, /Usage:/);
  assert.doesNotMatch(help, /--repo/);
  assert.doesNotMatch(help, /--skill/);
  assert.equal(stderr.read(), '');
});

test('returns the usage exit code for invalid arguments', async () => {
  const stderr = captureStream();
  const code = await runCli({ argv: ['--missing'], env: {}, stdin: inputStream(), stdout: captureStream(), stderr });
  assert.equal(code, 2);
  assert.match(stderr.read(), /Unknown option/);

  const removedOptionStderr = captureStream();
  const removedOptionCode = await runCli({
    argv: ['--task-repo', './tasks', 'Run this task'],
    env: {},
    stdin: inputStream(),
    stdout: captureStream(),
    stderr: removedOptionStderr
  });
  assert.equal(removedOptionCode, 2);
  assert.match(removedOptionStderr.read(), /Unknown option: --task-repo/);
});

test('lists detected coding agents', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-agents-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const code = await runCli({
    argv: ['agent', 'list', '--json'],
    env: { HOME: join(root, 'home'), PATH: root },
    stdin: inputStream(),
    stdout,
    stderr: captureStream(),
    cwd: root
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.read()), ['codex']);

  const textStdout = captureStream();
  assert.equal(await runCli({
    argv: ['agent', 'list'],
    env: { HOME: join(root, 'home'), PATH: root },
    stdin: inputStream(),
    stdout: textStdout,
    stderr: captureStream(),
    cwd: root
  }), 0);
  assert.equal(textStdout.read(), 'codex\n');
});

test('lists one agent\'s native models with their efforts and removes its temporary workspace', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-models-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  await writeFile(binary, `#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"method":"initialize"'*) printf '%s\\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
    *'"method":"model/list"'*) printf '%s\\n' '{"id":2,"result":{"data":[{"id":"gpt-test","defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]},{"id":"gpt-plain"}],"nextCursor":null}}' ;;
  esac
done
`);
  await chmod(binary, 0o700);
  const env = { ...process.env, PATH: `${root}:/usr/bin`, HOME: join(root, 'home'), CODEX_BIN: binary,
    CODEX_HOME: join(root, 'codex-state'), TMPDIR: root };
  await mkdir(env.CODEX_HOME);
  const run = async (argv) => {
    const stdout = captureStream(), stderr = captureStream();
    const code = await runCli({ argv, env, stdin: inputStream(), stdout, stderr, cwd: root });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const json = await run(['agent', 'models', 'codex', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), [{ id: 'gpt-test', efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: 'gpt-plain', efforts: [] }]);
  assert.deepEqual(await run(['agent', 'models', 'codex']), { code: 0, stdout: 'gpt-test\ngpt-plain\n', stderr: '' });
  const missing = await run(['agent', 'models', 'pi']);
  assert.equal(missing.code, 5);
  assert.match(missing.stderr, /Coding agent is not available: pi/);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('ala-models-')), []);
});

test('fails without running anything when no coding agent is installed', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-no-agent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const argv of [['Summarize this'], ['--ca', 'codex', 'Summarize this']]) {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({ argv, env: { HOME: join(root, 'home'), PATH: root }, stdin: inputStream(), stdout, stderr,
      cwd: root });
    assert.equal(code, 5);
    assert.equal(stdout.read(), '');
    assert.match(stderr.read(), /No coding agent is available/);
  }
});

test('delegates explicitly to a detected coding agent with clean stdout', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-delegate-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const authRoot = join(root, 'codex-state');
  const agentLog = join(authRoot, 'codex-arguments.log');
  await mkdir(authRoot);
  await writeFile(binary, `#!/bin/sh
printf '%s\n' "$@" > "$CODEX_HOME/codex-arguments.log"
printf '%s\n' '{"type":"thread.started","thread_id":"thread-cli"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"agent result"}}'
`);
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--agent', 'codex', '--config', join(root, 'missing.json'), 'complete', 'task'],
    env: {
      HOME: join(root, 'home'), PATH: root, CODEX_HOME: authRoot
    },
    stdin: inputStream(),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0, stderr.read());
  assert.equal(stdout.read(), 'agent result\n');
  assert.equal(stderr.read(), '');
  assert.match(await readFile(agentLog, 'utf8'), /^--search$/mu);
  await assert.rejects(() => readFile(join(root, 'missing.json'), 'utf8'));
});

test('handles slash agent commands locally in interactive mode', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-interactive-agent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const authRoot = join(root, 'codex-state');
  await mkdir(authRoot);
  await writeFile(binary, `#!/bin/sh
if [ "$1" = 'app-server' ]; then
  while IFS= read -r request; do
    case "$request" in
      *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
      *'"method":"model/list"'*) printf '%s\n' '{"id":2,"result":{"data":[{"id":"gpt-test","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}],"nextCursor":null}}' ;;
    esac
  done
  exit 0
fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-interactive"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"slash result"}}'
`);
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--interactive', '--config', join(root, 'missing.json')],
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      PATH: root,
      CODEX_BIN: binary,
      OPENCODE_BIN: join(root, 'absent-opencode'),
      PI_BIN: join(root, 'absent-pi'),
      OMP_BIN: join(root, 'absent-omp'),
      CLAUDE_BIN: join(root, 'absent-claude'),
      CODEX_HOME: authRoot
    },
    stdin: inputStream([
      '/help',
      '/permissions',
      '/permissions ask-for-approval',
      '/permissions full-access',
      '/agent use codex',
      '/status',
      '/agent list',
      '/agent codex models',
      '/agent codex effort high',
      '/agent codex model gpt-test',
      '/agent codex effort turbo',
      '/agent codex effort high',
      '/agent codex do this',
      '/agent codex effort default',
      '/agent codex model default',
      '/quit',
      ''
    ].join('\n')),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0, stderr.read());
  const outputLines = stdout.read().trim().split('\n');
  // /status prints one padded line per agent; the session's configured codex is its default.
  const statusLines = outputLines.filter((line) => /^(codex|opencode|pi|omp|claude) {2,}/u.test(line));
  assert.deepEqual(statusLines.map((line) => line.split(/\s+/u)[0]), ['codex', 'opencode', 'pi', 'omp', 'claude']);
  assert.match(statusLines[0], /^codex {5}available {6}.*default$/u);
  assert.deepEqual(outputLines.filter((line) => !statusLines.includes(line)), ['codex', 'gpt-test', 'slash result']);
  const diagnostics = stderr.read();
  assert.equal(diagnostics.match(/Interactive commands:/g)?.length, 1);
  assert.match(diagnostics, /\/agent list\s+List detected coding-agent backends/);
  assert.match(diagnostics, /\/agent use <name>\s+Persist the default coding agent/);
  assert.doesNotMatch(diagnostics, /\/websearch/);
  assert.doesNotMatch(diagnostics, /\/repo /);
  assert.doesNotMatch(diagnostics, /\/symbolic /);
  assert.match(diagnostics, /default coding agent set to codex/);
  assert.match(diagnostics, /Native permissions: full-access/);
  assert.match(diagnostics, /Native permissions: ask-for-approval/);
  assert.match(diagnostics, /codex model set to gpt-test/);
  assert.match(diagnostics, /codex model reset to agent default/);
  assert.match(diagnostics, /Set a model first: \/agent codex model <model-name>/);
  assert.match(diagnostics, /gpt-test does not advertise effort turbo; supported: low, high/);
  assert.match(diagnostics, /codex effort set to high/);
  assert.match(diagnostics, /codex effort reset to model default/);
  assert.match(diagnostics, /\/agent <name> effort <effort>\s+Persist the effort/);
  const persistedConfig = JSON.parse(await readFile(join(root, 'missing.json'), 'utf8'));
  assert.deepEqual(persistedConfig, { codingAgent: 'codex', models: {}, efforts: {} });
});

test('uses explicit home and cwd while injecting model and MCP overrides into Codex', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-embedded-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'robot-home');
  const workspace = join(root, 'project');
  const binary = join(root, 'codex');
  await Promise.all([mkdir(join(home, '.codex'), { recursive: true }), mkdir(workspace)]);
  await writeFile(binary, `#!/bin/sh
printf '%s\n' "$@" > "$CODEX_HOME/embedded-arguments.log"
printf '%s' "$PWD" > workspace-path.txt
printf '%s\n' '{"type":"thread.started","thread_id":"thread-embedded"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"embedded result"}}'
`);
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--home', home, '--cwd', workspace, '--task', 'operate desktop', '--ca', 'codex', '--model', 'gpt-test', '--MCPServers', 'desktop=http://127.0.0.1:48100/mcp'],
    env: { ...process.env, HOME: join(root, 'host-home'), PATH: `${root}:/usr/bin`, CODEX_BIN: binary },
    stdin: inputStream(), stdout, stderr, cwd: root
  });
  assert.equal(code, 0, stderr.read());
  assert.equal(stdout.read(), 'embedded result\n');
  assert.equal(await readFile(join(workspace, 'workspace-path.txt'), 'utf8'), await realpath(workspace));
  const argumentsLog = await readFile(join(home, '.codex', 'embedded-arguments.log'), 'utf8');
  assert.match(argumentsLog, /mcp_servers\.desktop\.url="http:\/\/127\.0\.0\.1:48100\/mcp"/);
  assert.match(argumentsLog, /--model\ngpt-test/);
});
