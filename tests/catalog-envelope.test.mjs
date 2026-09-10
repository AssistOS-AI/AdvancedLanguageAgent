import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntime } from '../src/runtime.mjs';
import { discoverAnthropicSkills } from '../src/repositories.mjs';
import { readCatalogEnvelope } from '../src/skill-catalog.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { captureStream, writeAnthropicSkill } from './helpers.mjs';

const agents = [{ name: 'codex', available: true, binary: '/fake/codex' }];
function fakeAchilles(calls) {
  return { discoverSkills() {}, MainAgent: class {
    async buildSkills() {}
    async executeSkill(name, prompt) { calls.push(prompt); return prompt; }
    shutdown() {}
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ala-envelope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function writeEnvelope(root, names, revision = 'revision-one') {
  const metadata = { version: 1, revision, policyVersion: 3,
    entries: names.map((name) => ({ name, identity: `workspace:${name}` })), diagnostics: [] };
  await writeFile(join(root, '.catalog.json'), JSON.stringify(metadata));
  return metadata;
}

test('every explicit empty execution and direct agent route conveys current revision and removal', async (t) => {
  const root = await fixture(t);
  await writeEnvelope(root, [], 'empty-revision');
  const calls = [];
  const events = [];
  const runtime = await createRuntime({ achillesModule: fakeAchilles(calls), repositories: [], codingAgents: agents,
    options: { agent: 'codex', skillCatalog: root, tags: [] }, diagnostics: captureStream(),
    eventSink: (event) => events.push(event) });
  t.after(() => runtime.close());
  await runtime.execute('Continue the earlier work');
  await runtime.executeAgent('Continue again');
  for (const prompt of calls) {
    assert.match(prompt, /empty-revision/);
    assert.match(prompt, /"policyVersion":3/);
    assert.match(prompt, /no task skills are selected/);
    assert.match(prompt, /supersedes earlier catalog messages/);
    assert.match(prompt, /Skills absent from this list are unavailable/);
  }
  assert.equal(events.filter((event) => event.type === 'skill-catalog').length, 2);
  await assert.rejects(() => runtime.refreshRepositories([]), /cannot be replaced interactively/);
});

test('versioned catalog validates exact names and rejects nested or extra descriptors', async (t) => {
  const root = await fixture(t);
  const directory = await writeAnthropicSkill(root, 'current');
  await rename(directory, join(root, 'current'));
  await rm(join(root, 'skills'), { recursive: true });
  await writeEnvelope(root, ['current']);
  assert.equal((await readCatalogEnvelope(root, await discoverAnthropicSkills(root))).revision, 'revision-one');
  await writeAnthropicSkill(join(root, 'current'), 'nested');
  await assert.rejects(async () => readCatalogEnvelope(root, await discoverAnthropicSkills(root)), /membership differs/);
  await writeEnvelope(root, ['current', 'nested']);
  await assert.rejects(async () => readCatalogEnvelope(root, await discoverAnthropicSkills(root)), /nested descriptor/);
});

test('legacy revision detects helper content and executable modes without changing descriptors', async (t) => {
  const root = await fixture(t);
  const directory = await writeAnthropicSkill(root, 'current');
  const helper = join(directory, 'helper.sh');
  await writeFile(helper, 'printf one\n');
  const skills = await discoverAnthropicSkills(root);
  const first = await readCatalogEnvelope(root, skills);
  await writeFile(helper, 'printf two\n');
  const second = await readCatalogEnvelope(root, skills);
  await chmod(helper, 0o700);
  const third = await readCatalogEnvelope(root, skills);
  assert.notEqual(first.revision, second.revision);
  assert.notEqual(second.revision, third.revision);
  assert.equal((await readCatalogEnvelope(root, skills)).revision, third.revision);
});

test('interactive refresh preserves exact standalone filters and rejects a missing selected skill', async (t) => {
  const root = await fixture(t);
  await writeAnthropicSkill(root, 'selected');
  const calls = [];
  const runtime = await createRuntime({ achillesModule: fakeAchilles(calls), repositories: [root], codingAgents: agents,
    options: { skillSets: 'selected', tags: [] }, diagnostics: captureStream() });
  t.after(() => runtime.close());
  await writeAnthropicSkill(root, 'unselected');
  await runtime.refreshRepositories([root]);
  assert.deepEqual(runtime.skills.map(({ name }) => name), ['selected']);
  await runtime.execute('Use the method');
  assert.match(calls.at(-1), /again for this execution even if previously read/);
  assert.match(calls.at(-1), /Reread every helper or asset/);
  assert.doesNotMatch(calls.at(-1), /unselected/);
  await assert.rejects(() => runtime.refreshRepositories([]), /not found: selected/);
  assert.deepEqual(runtime.skills.map(({ name }) => name), ['selected']);
});

test('active execution refuses catalog replacement and retains its original mounts', async (t) => {
  const root = await fixture(t);
  const directory = await writeAnthropicSkill(root, 'selected');
  let release;
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const service = createCodingAgentService({ agents, workspace: root, isolatedSkills: true,
    skills: [{ name: 'selected', directoryPath: directory }], runners: { codex: async ({ sandbox }) => {
      start();
      await paused;
      return { outputText: sandbox.mounts[0].source, continuation: { threadId: 'same-thread' } };
    } } });
  t.after(() => service.close());
  const execution = service.execute('Work');
  await started;
  await assert.rejects(() => service.refreshSkills([]), /active coding-agent execution/);
  release();
  assert.equal(await execution, directory);
  await service.refreshSkills([]);
  assert.match(await readFile(join(directory, 'SKILL.md'), 'utf8'), /selected/);
});

test('unknown or malformed metadata fails explicitly instead of using a stale legacy catalog', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.catalog.json'), '{bad');
  await assert.rejects(() => readCatalogEnvelope(root, []), /Invalid execution skill catalog/);
  await writeFile(join(root, '.catalog.json'), JSON.stringify({ version: 2 }));
  await assert.rejects(() => readCatalogEnvelope(root, []), /expected version 1/);
});
