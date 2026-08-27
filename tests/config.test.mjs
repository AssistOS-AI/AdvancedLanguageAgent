import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resolveActiveRepositories, resolveConfigPath, saveConfig } from '../src/config.mjs';

test('resolves configuration location using documented precedence', () => {
  assert.equal(
    resolveConfigPath({ cliPath: 'custom.json', env: { ALA_CONFIG_PATH: '/ignored' }, cwd: '/work' }),
    '/work/custom.json'
  );
  assert.equal(
    resolveConfigPath({ env: { ALA_CONFIG_PATH: '/selected/root' }, cwd: '/work' }),
    '/selected/root/.ala/config.json'
  );
  assert.equal(
    resolveConfigPath({ env: { XDG_CONFIG_HOME: '/ignored' }, homeDirectory: '/home/tester' }),
    '/home/tester/.ala/config.json'
  );
  assert.equal(
    resolveConfigPath({ env: { HOME: '/environment-home' }, homeDirectory: '/ignored' }),
    '/environment-home/.ala/config.json'
  );
  assert.equal(
    resolveConfigPath({ env: { ALA_CONFIG_PATH: './runtime' }, cwd: '/work', homeDirectory: '/ignored' }),
    '/work/runtime/.ala/config.json'
  );
});

test('saves and loads versioned configuration atomically with restrictive mode', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-config-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'nested', 'config.json');
  const config = {
    version: 1,
    taskRepositories: [{ path: '/tasks/one' }],
    codingAgents: { priority: ['codex', 'opencode', 'pi'], models: { codex: 'gpt-test' }, websearch: true }
  };
  await saveConfig(configPath, config);
  assert.deepEqual(await loadConfig(configPath), config);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.match(await readFile(configPath, 'utf8'), /"version": 1/);
});

test('combines persistent and environment repositories with canonical deduplication', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-active-repos-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const one = join(root, 'one');
  const two = join(root, 'two');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(one);
  await mkdir(two);
  const repositories = await resolveActiveRepositories({
    config: { version: 1, taskRepositories: [{ path: one }] },
    env: { ALA_TASK_REPOSITORIES: `${one}:${two}` }
  });
  assert.deepEqual(repositories, [one, two]);
});

test('does not replace malformed configuration with defaults', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-invalid-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, '{broken');
  await assert.rejects(() => loadConfig(configPath), /not valid JSON/);
});

test('validates and completes coding-agent priority', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-agent-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    taskRepositories: [],
    codingAgents: { priority: ['pi'] }
  }));
  assert.deepEqual((await loadConfig(configPath)).codingAgents.priority, ['pi', 'codex', 'opencode']);
  await writeFile(configPath, JSON.stringify({
    version: 1,
    taskRepositories: [],
    codingAgents: { priority: ['invalid'] }
  }));
  await assert.rejects(() => loadConfig(configPath), /codingAgents\.priority/);
});

test('defaults and validates per-agent coding models', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-model-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    taskRepositories: [],
    codingAgents: { priority: ['codex', 'opencode', 'pi'] }
  }));
  assert.deepEqual((await loadConfig(configPath)).codingAgents.models, {});
  await writeFile(configPath, JSON.stringify({
    version: 1,
    taskRepositories: [],
    codingAgents: { priority: ['codex'], models: { unknown: 'model' } }
  }));
  await assert.rejects(() => loadConfig(configPath), /codingAgents\.models/);
});

test('defaults and validates the persistent websearch setting', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-websearch-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    taskRepositories: [],
    codingAgents: { priority: ['codex', 'opencode', 'pi'] }
  }));
  assert.equal((await loadConfig(configPath)).codingAgents.websearch, false);
  await writeFile(configPath, JSON.stringify({
    version: 1,
    taskRepositories: [],
    codingAgents: { priority: ['codex'], websearch: 'yes' }
  }));
  await assert.rejects(() => loadConfig(configPath), /codingAgents\.websearch/);
});
