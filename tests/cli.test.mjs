import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { runCli } from '../src/cli.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { captureStream, inputStream, writeAnthropicSkill } from './helpers.mjs';

const execFileAsync = promisify(execFile);
const sandboxSupported = canStartBubblewrap();

function io(root, content = '') {
  return { cwd: root, stdin: inputStream(content), stdout: captureStream(), stderr: captureStream(), env: {} };
}

async function createGitTaskRepository(path, skillName) {
  await writeAnthropicSkill(path, skillName);
  await execFileAsync('git', ['init', path]);
  await execFileAsync('git', ['-C', path, 'add', '.']);
  await execFileAsync('git', [
    '-C', path, '-c', 'user.name=ALA Test', '-c', 'user.email=ala@example.test',
    'commit', '-m', 'Initial task repository'
  ]);
  return pathToFileURL(path).href;
}

test('rejects a local path for persistent repository addition', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-local-repo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'translation');
  await writeAnthropicSkill(repository, 'translate');
  const stderr = captureStream();
  assert.equal(await runCli({
    ...io(root),
    argv: ['repo', 'add', repository, '--config', join(root, 'config.json')],
    stderr
  }), 2);
  assert.match(stderr.read(), /repo add requires a Git URL/);
});

test('clones and manages a persistent task repository from a Git URL', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-git-repo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'claude-skills');
  const repositoryUrl = await createGitTaskRepository(source, 'remote-task');
  const configPath = join(root, 'config.json');
  const dataRoot = join(root, 'data');
  const stdout = captureStream();
  const env = { ...process.env, XDG_DATA_HOME: dataRoot };
  assert.equal(await runCli({
    argv: ['repo', 'add', repositoryUrl, '--config', configPath],
    env,
    stdin: inputStream(),
    stdout,
    stderr: captureStream(),
    cwd: root
  }), 0);

  const managedPath = stdout.read().trim();
  assert.match(managedPath, /\/data\/ala\/repositories\/claude-skills-[a-f0-9]{12}$/u);
  assert.match(await readFile(join(managedPath, 'skills', 'remote-task', 'SKILL.md'), 'utf8'), /remote-task/);
  assert.doesNotMatch(await readFile(join(managedPath, '.git', 'config'), 'utf8'), /\[remote "origin"\]/u);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).taskRepositories, [{ path: managedPath }]);

  const removeOutput = captureStream();
  assert.equal(await runCli({
    argv: ['repo', 'remove', 'claude-skills', '--config', configPath],
    env,
    stdin: inputStream(),
    stdout: removeOutput,
    stderr: captureStream(),
    cwd: root
  }), 0);
  assert.equal(removeOutput.read(), `${managedPath}\n`);
  assert.match(await readFile(join(managedPath, 'skills', 'remote-task', 'SKILL.md'), 'utf8'), /remote-task/);

  assert.equal(await runCli({
    argv: ['repo', 'add', repositoryUrl, '--config', configPath],
    env,
    stdin: inputStream(),
    stdout: captureStream(),
    stderr: captureStream(),
    cwd: root
  }), 0);
  assert.equal(await runCli({
    argv: ['repo', 'remove', repositoryUrl, '--config', configPath],
    env,
    stdin: inputStream(),
    stdout: captureStream(),
    stderr: captureStream(),
    cwd: root
  }), 0);
});

test('rejects an ambiguous repository short name', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-ambiguous-repo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    taskRepositories: [
      { path: join(root, 'tasks-aaaaaaaaaaaa') },
      { path: join(root, 'tasks-bbbbbbbbbbbb') }
    ],
    codingAgents: { priority: ['codex', 'opencode', 'pi'] }
  })}\n`);
  const stderr = captureStream();
  assert.equal(await runCli({
    argv: ['repo', 'remove', 'tasks', '--config', configPath],
    env: {},
    stdin: inputStream(),
    stdout: captureStream(),
    stderr,
    cwd: root
  }), 4);
  assert.match(stderr.read(), /repository name is ambiguous: tasks/iu);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).taskRepositories.length, 2);
});

test('keeps help output separate from diagnostics', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({ argv: ['--help'], env: {}, stdin: inputStream(), stdout, stderr, cwd: process.cwd() });
  assert.equal(code, 0);
  const help = stdout.read();
  assert.match(help, /Usage:/);
  assert.doesNotMatch(help, /--task-repo/);
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

test('lists detected coding agents without loading AchillesAgentLib', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-agents-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const { chmod, writeFile } = await import('node:fs/promises');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const code = await runCli({
    argv: ['agent', 'list', '--json', '--config', join(root, 'missing.json')],
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
    argv: ['agent', 'list', '--config', join(root, 'missing.json')],
    env: { HOME: join(root, 'home'), PATH: root },
    stdin: inputStream(),
    stdout: textStdout,
    stderr: captureStream(),
    cwd: root
  }), 0);
  assert.equal(textStdout.read(), 'codex\n');
});

test('delegates explicitly to a detected coding agent with clean stdout', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-delegate-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const authRoot = join(root, 'codex-state');
  const agentLog = join(authRoot, 'codex-arguments.log');
  const { chmod, writeFile } = await import('node:fs/promises');
  const { mkdir } = await import('node:fs/promises');
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
    argv: ['--agent', 'codex', '--websearch', '--config', join(root, 'missing.json'), 'complete', 'task'],
    env: {
      HOME: join(root, 'home'), PATH: root, CODEX_HOME: authRoot
    },
    stdin: inputStream(),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), 'agent result\n');
  assert.equal(stderr.read(), '');
  assert.match(await readFile(agentLog, 'utf8'), /^--search$/mu);
  await assert.rejects(() => readFile(join(root, 'missing.json'), 'utf8'));
  const sessionFiles = await readdir(join(root, 'sessions'));
  assert.equal(sessionFiles.length, 1);
  const sessionEvents = (await readFile(join(root, 'sessions', sessionFiles[0]), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(sessionEvents.find((event) => event.type === 'prompt').content, 'complete task');
  assert.equal(sessionEvents.find((event) => event.type === 'coding-agent-final').message, 'agent result');
  assert.equal(sessionEvents.at(-1).status, 'completed');
});

test('handles slash agent commands locally in interactive mode', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-interactive-agent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const authRoot = join(root, 'codex-state');
  const agentLog = join(authRoot, 'agent-calls.log');
  const { chmod, writeFile } = await import('node:fs/promises');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(authRoot);
  await writeFile(binary, `#!/bin/sh
if [ "$1" = 'app-server' ]; then
  while IFS= read -r request; do
    case "$request" in
      *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
      *'"method":"model/list"'*) printf '%s\n' '{"id":2,"result":{"data":[{"id":"gpt-test"}],"nextCursor":null}}' ;;
    esac
  done
  exit 0
fi
last=''
resume='no'
thread=''
model=''
websearch='off'
previous=''
for argument in "$@"; do
  last="$argument"
  if [ "$argument" = 'resume' ]; then resume='yes'; fi
  if [ "$argument" = 'thread-interactive' ]; then thread="$argument"; fi
  if [ "$previous" = '--model' ]; then model="$argument"; fi
  if [ "$argument" = '--search' ]; then websearch='on'; fi
  previous="$argument"
done
printf '%s|%s|%s|%s|%s\n' "$PWD" "$resume" "$thread" "$model" "$websearch" >> "$CODEX_HOME/agent-calls.log"
result='slash result'
case "$last" in *interactive-task*) result='refreshed skill catalog' ;; esac
printf '%s\n' '{"type":"thread.started","thread_id":"thread-interactive"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$result"
`);
  await chmod(binary, 0o700);
  const repository = join(root, 'interactive-repository');
  const repositoryUrl = await createGitTaskRepository(repository, 'interactive-task');
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--interactive', '--config', join(root, 'missing.json')],
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      PATH: `${root}:/usr/bin`,
      XDG_DATA_HOME: join(root, 'data'),
      CODEX_BIN: binary,
      CODEX_HOME: authRoot
    },
    stdin: inputStream([
      '/help',
      '/agent help',
      `/repo add ${repositoryUrl}`,
      '/websearch on',
      'use the new task skill',
      '/repo list',
      '/repo remove interactive-repository',
      '/symbolic detection on',
      '/agent list',
      '/agent codex models',
      '/agent codex model gpt-test',
      '/agent codex do this',
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
  assert.equal(outputLines.length, 7);
  assert.equal(outputLines[1], 'refreshed skill catalog');
  assert.equal(outputLines[0], outputLines[2]);
  assert.equal(outputLines[3], outputLines[0]);
  assert.equal(outputLines[4], 'codex');
  assert.equal(outputLines[5], 'gpt-test');
  assert.equal(outputLines[6], 'slash result');
  const diagnostics = stderr.read();
  assert.equal(diagnostics.match(/Interactive commands:/g)?.length, 2);
  assert.match(diagnostics, /Interactive commands:/);
  assert.match(diagnostics, /\/help\s+Show this complete command list/);
  assert.match(diagnostics, /\/agent \| \/agent help\s+Show this complete command list/);
  assert.match(diagnostics, /\/agent list\s+List detected coding-agent backends/);
  assert.match(diagnostics, /\/agent <name> models\s+List models available/);
  assert.match(diagnostics, /\/agent <name> model <model>\s+Persist the model/);
  assert.match(diagnostics, /\/agent auto <prompt>\s+Delegate to the first available backend/);
  assert.match(diagnostics, /\/agent codex <prompt>\s+Delegate to Codex/);
  assert.match(diagnostics, /\/agent opencode <prompt>\s+Delegate to OpenCode/);
  assert.match(diagnostics, /\/agent pi <prompt>\s+Delegate to Pi/);
  assert.match(diagnostics, /\/repo add <git-url>\s+Clone, register, and load a task repository/);
  assert.match(diagnostics, /\/repo list\s+List registered task repositories/);
  assert.match(diagnostics, /\/repo remove <name>\s+Unregister a task repository; TAB completes names/);
  assert.match(diagnostics, /\/symbolic detection on\s+Enable symbolic task routing/);
  assert.match(diagnostics, /\/symbolic detection off\s+Disable symbolic task routing/);
  assert.match(diagnostics, /\/websearch on\s+Persist and enable coding-agent web search/);
  assert.match(diagnostics, /\/websearch off\s+Persist and disable coding-agent web search/);
  assert.match(diagnostics, /\/folder add <path> \[write\|w\] \[as <alias>\]\s+Mount a folder for this session/);
  assert.match(diagnostics, /\/folder list\s+List active folder mounts/);
  assert.match(diagnostics, /\/folder remove <alias\|path>\s+Remove a folder/);
  assert.match(diagnostics, /\/quit \| \/exit \| :quit \| :exit\s+Close the interactive session/);
  assert.equal(diagnostics.match(/Close the interactive session/g)?.length, 2);
  assert.equal(diagnostics.match(/repository catalog refreshed \(1 skills\)/g)?.length, 1);
  assert.equal(diagnostics.match(/repository catalog refreshed \(0 skills\)/g)?.length, 1);
  assert.match(diagnostics, /symbolic detection on/);
  assert.match(diagnostics, /websearch on/);
  assert.match(diagnostics, /codex model set to gpt-test/);
  assert.match(diagnostics, /codex model reset to agent default/);
  const agentCalls = (await readFile(agentLog, 'utf8')).trim().split('\n');
  assert.equal(agentCalls.length, 2);
  assert.equal(agentCalls[0], '/workspace|no|||on');
  assert.equal(agentCalls[1], '/workspace|yes|thread-interactive|gpt-test|on');
  const persistedConfig = JSON.parse(await readFile(join(root, 'missing.json'), 'utf8'));
  assert.equal(persistedConfig.codingAgents.models.codex, undefined);
  assert.equal(persistedConfig.codingAgents.websearch, true);
  const sessionFiles = await readdir(join(root, 'sessions'));
  assert.equal(sessionFiles.length, 1);
  const sessionEvents = (await readFile(join(root, 'sessions', sessionFiles[0]), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(sessionEvents.filter((event) => event.type === 'prompt').length, 2);
  assert.equal(sessionEvents.filter((event) => event.type === 'session-started').length, 1);
  assert.equal(sessionEvents.at(-1).type, 'session-ended');
});

test('manages interactive folders locally and forces sandboxed coding-agent execution', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-folders-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const books = join(root, 'Book Data');
  const binaryDirectory = join(root, 'bin');
  const binary = join(binaryDirectory, 'codex');
  const configPath = join(root, 'missing.json');
  const { chmod, mkdir, writeFile } = await import('node:fs/promises');
  await Promise.all([mkdir(books), mkdir(binaryDirectory)]);
  await writeFile(join(books, 'book.txt'), 'book source');
  await writeFile(binary, `#!/bin/sh
test "$PWD" = '/workspace' || exit 10
test -r '/workspace/folders/book-data/book.txt' || exit 11
if printf '%s' denied > '/workspace/folders/book-data/blocked.txt' 2>/dev/null; then exit 12; fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-folders"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"folder result"}}'
`);
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--interactive', '--config', configPath],
    env: { HOME: join(root, 'home'), PATH: binaryDirectory, CODEX_BIN: binary },
    stdin: inputStream([
      `/folder add "${books}" as book-data`,
      '/folder list',
      'inspect the mounted folder',
      `/folder remove "${books}"`,
      '/folder list',
      '/quit',
      ''
    ].join('\n')),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0, stderr.read());
  const lines = stdout.read().trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\tread-only\t/u);
  assert.match(lines[0], /\/workspace\/folders\/book-data/u);
  assert.equal(lines[1], 'folder result');
  assert.match(stderr.read(), /folder .* mounted read-only/);
  assert.match(stderr.read(), /folder removed:/);
  await assert.rejects(() => readFile(join(books, 'blocked.txt')));
  await assert.rejects(() => readFile(configPath));
});

test('executes an explicitly selected task skill from the persistent registry', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-execute-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'tasks');
  const repositoryUrl = await createGitTaskRepository(repository, 'echo');
  const binary = join(root, 'codex');
  const { chmod, writeFile } = await import('node:fs/promises');
  await writeFile(binary, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-skill"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done:process this"}}'
`);
  await chmod(binary, 0o700);
  const configPath = join(root, 'ala.json');
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    PATH: `${root}:/usr/bin`,
    CODEX_BIN: binary,
    XDG_DATA_HOME: join(root, 'data')
  };
  assert.equal(await runCli({
    ...io(root), env, argv: ['repo', 'add', repositoryUrl, '--config', configPath]
  }), 0);

  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--config', configPath, '--skill', 'echo', 'process', 'this'],
    env,
    stdin: inputStream(),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), 'done:process this\n');
  assert.equal(stderr.read(), '');
});
