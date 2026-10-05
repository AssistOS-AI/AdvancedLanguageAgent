import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resolveConfigPath, saveConfig } from '../src/config.mjs';

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

test('saves and loads the coding agent, models and efforts atomically with restrictive mode', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-config-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'nested', 'config.json');
  const config = { codingAgent: 'opencode', models: { codex: 'gpt-test', opencode: 'opencode/big-pickle' }, efforts: { codex: 'high' } };
  await saveConfig(configPath, config);
  assert.deepEqual(await loadConfig(configPath), config);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(configPath, 'utf8'))), ['codingAgent', 'models', 'efforts']);
});

test('a missing configuration has no default agent, models or efforts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-missing-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadConfig(join(root, 'config.json')), { models: {}, efforts: {} });
});

test('rejects any field other than codingAgent, models and efforts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-old-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  for (const config of [
    { version: 1, codingAgents: { priority: ['codex'] } },
    { models: {}, websearch: true },
    { models: {}, priority: ['pi'] },
  ]) {
    await writeFile(configPath, JSON.stringify(config));
    await assert.rejects(() => loadConfig(configPath), /supports only codingAgent, models and efforts/);
  }
});

test('does not replace malformed configuration with defaults', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-invalid-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, '{broken');
  await assert.rejects(() => loadConfig(configPath), /not valid JSON/);
});

test('validates the default coding agent and per-agent models', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-model-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ codingAgent: 'gemini' }));
  await assert.rejects(() => loadConfig(configPath), /codingAgent must be codex, opencode, pi, or claude/);
  await writeFile(configPath, JSON.stringify({ models: { unknown: 'model' } }));
  await assert.rejects(() => loadConfig(configPath), /models must map/);
});
