import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntime } from '../src/runtime.mjs';
import { discoverTaskSkills } from '../src/repositories.mjs';
import { readCatalogEnvelope, readSkillCatalog } from '../src/skill-catalog.mjs';
import { captureStream, writeAnthropicSkill } from './helpers.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-formats-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function envelope(file) {
  return readCatalogEnvelope(file, await discoverTaskSkills(await readSkillCatalog(file)));
}

test('JSON manifests preserve canonical selection and derive revisions from selected source bytes and modes', async t => {
  const root = await fixture(t);
  const directory = await writeAnthropicSkill(root, 'selected');
  const file = join(root, 'catalog.json');
  const helper = join(directory, 'helper.sh');
  const alias = join(root, 'alias');
  await symlink(directory, alias);
  await writeFile(helper, 'printf one\n');
  await chmod(helper, 0o600);
  await writeFile(file, JSON.stringify([directory, alias]));
  const before = await readFile(file, 'utf8');
  const first = await envelope(file);
  assert.deepEqual(first.entries, [{ name: 'selected', identity: 'selected' }]);
  assert.equal(first.policyVersion, null);
  await writeFile(join(root, 'unselected.txt'), 'unrelated');
  assert.equal((await envelope(file)).revision, first.revision);
  const original = await stat(helper);
  await writeFile(helper, 'printf two\n');
  await utimes(helper, original.atime, original.mtime);
  const second = await envelope(file);
  assert.notEqual(second.revision, first.revision);
  await chmod(helper, 0o700);
  const third = await envelope(file);
  assert.notEqual(third.revision, second.revision);
  await writeFile(file, JSON.stringify([alias, directory, directory]));
  assert.equal((await envelope(file)).revision, third.revision);
  await writeFile(file, before);
  assert.equal(await readFile(file, 'utf8'), before);
  await rm(directory, { recursive: true });
  await assert.rejects(envelope(file), /Invalid --skill-catalog manifest/);
});

test('JSON manifests reject changed membership and keep supported helper symlinks', async t => {
  const root = await fixture(t);
  const original = await writeAnthropicSkill(root, 'selected');
  const directory = join(root, 'different-folder');
  await rename(original, directory);
  const file = join(root, 'catalog.json');
  await writeFile(file, JSON.stringify([directory]));
  const skills = await discoverTaskSkills(await readSkillCatalog(file));
  await writeFile(join(directory, 'helper.txt'), 'helper');
  await symlink('helper.txt', join(directory, 'helper-link'));
  assert.equal((await readCatalogEnvelope(file, skills)).entries[0].name, 'selected');
  await writeFile(file, '[]');
  await assert.rejects(readCatalogEnvelope(file, skills), /membership changed/);
});

test('JSON manifests retain large resource support without relaxing the legacy directory budget', async t => {
  const root = await fixture(t);
  const directory = await writeAnthropicSkill(root, 'selected');
  const file = join(root, 'catalog.json');
  const helper = await open(join(directory, 'large-asset.bin'), 'w');
  try { await helper.truncate(64 * 1024 * 1024 + 1); }
  finally { await helper.close(); }
  await writeFile(file, JSON.stringify([directory]));
  assert.equal((await envelope(file)).entries[0].name, 'selected');
  await assert.rejects(readSkillCatalog(join(root, 'skills')), /legacy catalog exceeds/);
});

test('directory catalogs support versioned, legacy and empty formats and reject noncanonical aliases', async t => {
  const root = await fixture(t);
  const directory = join(root, 'catalog');
  await mkdir(directory);
  assert.deepEqual(await readSkillCatalog(directory), []);
  const empty = await envelope(directory);
  assert.deepEqual(empty.entries, []);
  const skill = await writeAnthropicSkill(directory, 'selected');
  assert.deepEqual(await readSkillCatalog(directory), [directory]);
  await rename(skill, join(directory, 'selected'));
  await rm(join(directory, 'skills'), { recursive: true });
  await writeFile(join(directory, '.catalog.json'), JSON.stringify({ version: 1,
    revision: 'captured-revision', policyVersion: 4,
    entries: [{ name: 'selected', identity: 'workspace:selected' }], diagnostics: [] }));
  assert.equal((await envelope(directory)).revision, 'captured-revision');
  const alias = join(root, 'alias');
  await symlink(directory, alias);
  await assert.rejects(readSkillCatalog(alias), /canonical path/);
  await writeFile(join(directory, '.catalog.json'), '{bad');
  await assert.rejects(readSkillCatalog(directory), /Invalid execution skill catalog/);
});

test('manifest executions convey authoritative filtered or empty state on every route without mutation', async t => {
  const root = await fixture(t);
  const selected = await writeAnthropicSkill(root, 'selected');
  const excluded = await writeAnthropicSkill(root, 'excluded');
  const file = join(root, 'catalog.json');
  for (const [paths, selection, names] of [[[selected, excluded], 'selected', ['selected']],
    [[selected], '', []], [[], undefined, []]]) {
    const contents = JSON.stringify(paths);
    await writeFile(file, contents);
    const calls = [];
    const events = [];
    const runtime = await createRuntime({ achillesModule: { discoverSkills() {}, MainAgent: class {
      async buildSkills() {}
      async executeSkill(name, prompt) { calls.push(prompt); return prompt; }
      shutdown() {}
    } }, repositories: await readSkillCatalog(file),
    codingAgents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    options: { agent: 'codex', skillCatalog: file, skillSets: selection, tags: [] },
    diagnostics: captureStream(), eventSink: event => events.push(event) });
    try {
      await runtime.execute('Continue');
      await runtime.executeAgent('Continue again');
      const catalogEvents = events.filter(event => event.type === 'skill-catalog');
      assert.equal(catalogEvents.length, 2);
      assert.deepEqual(catalogEvents[0].entries.map(entry => entry.name), names);
      for (const prompt of calls) {
        assert.match(prompt, /supersedes earlier catalog messages/);
        assert.ok(prompt.includes(catalogEvents[0].revision));
        if (!names.length) assert.match(prompt, /no task skills are selected/);
        else assert.doesNotMatch(prompt, /excluded/);
      }
      await assert.rejects(runtime.refreshRepositories([]), /cannot be replaced interactively/);
      assert.equal(await readFile(file, 'utf8'), contents);
    } finally { await runtime.close(); }
  }
});
