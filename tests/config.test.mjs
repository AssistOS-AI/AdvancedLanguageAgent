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
    resolveConfigPath({ env: { ALA_CONFIG_PATH: '/selected/config.json' }, cwd: '/work' }),
    '/selected/config.json'
  );
  assert.equal(resolveConfigPath({ env: { XDG_CONFIG_HOME: '/xdg' } }), '/xdg/ala/config.json');
});

test('saves and loads versioned configuration atomically with restrictive mode', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-config-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'nested', 'config.json');
  const config = { version: 1, taskRepositories: [{ path: '/tasks/one' }] };
  await saveConfig(configPath, config);
  assert.deepEqual(await loadConfig(configPath), config);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.match(await readFile(configPath, 'utf8'), /"version": 1/);
});

test('combines persistent, environment, and temporary repositories with canonical deduplication', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-active-repos-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const one = join(root, 'one');
  const two = join(root, 'two');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(one);
  await mkdir(two);
  const repositories = await resolveActiveRepositories({
    config: { version: 1, taskRepositories: [{ path: one }] },
    env: { ALA_TASK_REPOSITORIES: `${one}:${two}` },
    temporary: [two]
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
