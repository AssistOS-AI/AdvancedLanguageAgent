import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli.mjs';
import { captureStream, inputStream, writeCodeSkill } from './helpers.mjs';

function io(root, content = '') {
  return { cwd: root, stdin: inputStream(content), stdout: captureStream(), stderr: captureStream(), env: {} };
}

test('manages persistent repositories through the CLI without deleting their source', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-repo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'translation');
  await writeCodeSkill(repository, 'translate');
  const configPath = join(root, 'config', 'ala.json');
  const streams = io(root);

  assert.equal(await runCli({ ...streams, argv: ['repo', 'add', repository, '--config', configPath] }), 0);
  assert.equal(await runCli({
    ...streams,
    stdout: captureStream(),
    argv: ['repo', 'add', repository, '--config', configPath]
  }), 0);
  const listOutput = captureStream();
  assert.equal(await runCli({ ...streams, stdout: listOutput, argv: ['repo', 'list', '--config', configPath] }), 0);
  assert.equal(listOutput.read(), `${repository}\n`);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).taskRepositories.length, 1);
  assert.equal(await runCli({
    ...streams,
    stdout: captureStream(),
    argv: ['repo', 'remove', repository, '--config', configPath]
  }), 0);
  assert.match(await readFile(join(repository, 'skills', 'translate', 'cskill.md'), 'utf8'), /translate/);
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
printf '%s\n' '{"type":"thread.started","thread_id":"thread-interactive"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"slash result"}}'
`);
  await chmod(binary, 0o700);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--interactive', '--config', join(root, 'missing.json')],
    env: { HOME: join(root, 'home'), PATH: root },
    stdin: inputStream('/symbolic detection on\n/agent list\n/agent codex do this\n/quit\n'),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), 'codex\nslash result\n');
  assert.match(stderr.read(), /symbolic detection on/);
});

test('executes an explicitly selected A-Skill from the persistent registry', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-cli-execute-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'tasks');
  await writeCodeSkill(repository, 'echo', 'return `done:${args.promptText}`;');
  const configPath = join(root, 'ala.json');
  const setup = io(root);
  assert.equal(await runCli({ ...setup, argv: ['repo', 'add', repository, '--config', configPath] }), 0);

  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli({
    argv: ['--config', configPath, '--skill', 'echo', 'process', 'this'],
    env: {},
    stdin: inputStream(),
    stdout,
    stderr,
    cwd: root
  });
  assert.equal(code, 0);
  assert.equal(stdout.read(), 'done:process this\n');
  assert.equal(stderr.read(), '');
});
