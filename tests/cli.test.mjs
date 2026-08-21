import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { runCli } from '../src/cli.mjs';
import { captureStream, inputStream, writeAnthropicSkill } from './helpers.mjs';

const execFileAsync = promisify(execFile);

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
  assert.match(stdout.read(), /Usage:/);
  assert.equal(stderr.read(), '');
});

test('returns the usage exit code for invalid arguments', async () => {
  const stderr = captureStream();
  const code = await runCli({ argv: ['--missing'], env: {}, stdin: inputStream(), stdout: captureStream(), stderr });
  assert.equal(code, 2);
  assert.match(stderr.read(), /Unknown option/);
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

test('delegates explicitly to a detected coding agent with clean stdout', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-delegate-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const { chmod, writeFile } = await import('node:fs/promises');
  await writeFile(binary, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-cli"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"agent result"}}'
`);
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--agent', 'codex', '--config', join(root, 'missing.json'), 'complete', 'task'],
    env: { HOME: join(root, 'home'), PATH: root },
    stdin: inputStream(),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), 'agent result\n');
  assert.equal(stderr.read(), '');
});

test('handles slash agent commands locally in interactive mode', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-interactive-agent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex');
  const { chmod, writeFile } = await import('node:fs/promises');
  await writeFile(binary, `#!/bin/sh
last=''
for argument in "$@"; do last="$argument"; done
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
      CODEX_BIN: binary
    },
    stdin: inputStream([
      '/help',
      '/agent help',
      `/repo add ${repositoryUrl}`,
      'use the new task skill',
      '/repo list',
      '/repo remove interactive-repository',
      '/symbolic detection on',
      '/agent list',
      '/agent codex do this',
      '/quit',
      ''
    ].join('\n')),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0, stderr.read());
  const outputLines = stdout.read().trim().split('\n');
  assert.equal(outputLines.length, 6);
  assert.equal(outputLines[1], 'refreshed skill catalog');
  assert.equal(outputLines[0], outputLines[2]);
  assert.equal(outputLines[3], outputLines[0]);
  assert.equal(outputLines[4], 'codex');
  assert.equal(outputLines[5], 'slash result');
  const diagnostics = stderr.read();
  assert.equal(diagnostics.match(/Interactive commands:/g)?.length, 2);
  assert.match(diagnostics, /Interactive commands:/);
  assert.match(diagnostics, /\/help\s+Show this complete command list/);
  assert.match(diagnostics, /\/agent \| \/agent help\s+Show this complete command list/);
  assert.match(diagnostics, /\/agent list\s+List detected coding-agent backends/);
  assert.match(diagnostics, /\/agent auto <prompt>\s+Delegate to the first available backend/);
  assert.match(diagnostics, /\/agent codex <prompt>\s+Delegate to Codex/);
  assert.match(diagnostics, /\/agent opencode <prompt>\s+Delegate to OpenCode/);
  assert.match(diagnostics, /\/agent pi <prompt>\s+Delegate to Pi/);
  assert.match(diagnostics, /\/repo add <git-url>\s+Clone, register, and load a task repository/);
  assert.match(diagnostics, /\/repo list\s+List registered task repositories/);
  assert.match(diagnostics, /\/repo remove <name>\s+Unregister a task repository; TAB completes names/);
  assert.match(diagnostics, /\/symbolic detection on\s+Enable symbolic task routing/);
  assert.match(diagnostics, /\/symbolic detection off\s+Disable symbolic task routing/);
  assert.match(diagnostics, /\/quit \| \/exit \| :quit \| :exit\s+Close the interactive session/);
  assert.equal(diagnostics.match(/Close the interactive session/g)?.length, 2);
  assert.equal(diagnostics.match(/repository catalog refreshed \(1 skills\)/g)?.length, 1);
  assert.equal(diagnostics.match(/repository catalog refreshed \(0 skills\)/g)?.length, 1);
  assert.match(diagnostics, /symbolic detection on/);
});

test('executes an explicitly selected task skill from the persistent registry', async (context) => {
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
