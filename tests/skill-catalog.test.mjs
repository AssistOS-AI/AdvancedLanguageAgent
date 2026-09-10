import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
import { readSkillCatalog } from '../src/skill-catalog.mjs';
import { parseArguments } from '../src/arguments.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { captureStream, inputStream, writeAnthropicSkill } from './helpers.mjs';

test('parses an exclusive skill catalog', () => {
  assert.equal(parseArguments(['--skill-catalog', '/catalog', '--task', 'test']).skillCatalog, '/catalog');
  assert.throws(() => parseArguments(['--skill-catalog']), /requires a value/);
});

test('explicit catalogs replace home/environment sources and hide unselected cwd skills without host edits', {
  skip: !canStartBubblewrap()
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-selected-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const empty = join(root, 'empty');
  const catalog = join(root, 'catalog');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(empty, '[]');
  await writeAnthropicSkill(join(workspace, '.agents'), 'unselected');
  const skills = join(root, 'skills');
  await writeAnthropicSkill(skills, 'selected');
  await writeFile(catalog, JSON.stringify([join(skills, 'skills', 'selected')]));
  const binary = join(root, 'codex');
  await writeFile(binary, `#!/bin/sh
ls /workspace/.agents/skills > "$CODEX_HOME/visible-skills"
if test -d /workspace/.agents/skills/selected; then
  if touch /workspace/.agents/skills/selected/forbidden 2>/dev/null; then exit 90; fi
  test -f /workspace/.agents/skills/selected/SKILL.md || exit 91
fi
printf '%s\\n' "$@" > "$CODEX_HOME/arguments"
printf '%s\\n' '{"type":"thread.started","thread_id":"catalog-test"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
`);
  await chmod(binary, 0o700);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, taskRepositories: [{ path: '/missing-config-source' }] }));
  for (const [directory, names] of [[catalog, ['selected']], [empty, []]]) {
    const stderr = captureStream();
    const code = await runCli({
      argv: ['--ca', 'codex', '--home', home, '--cwd', workspace, '--config', config,
        '--skill-catalog', directory, '--task', 'Review'],
      env: { HOME: home, CODEX_BIN: binary, PATH: '/usr/bin', ALA_TASK_REPOSITORIES: '/missing-env-source' },
      stdin: inputStream(), stdout: captureStream(), stderr, cwd: root
    });
    assert.equal(code, 0, stderr.read());
    assert.deepEqual((await readFile(join(home, '.codex/visible-skills'), 'utf8')).trim().split('\n').filter(Boolean), names);
    if (names.length) assert.match(await readFile(join(home, '.codex/arguments'), 'utf8'), /Use the skills in \.agents\/skills/);
    assert.deepEqual(await readdir(join(workspace, '.agents/skills')), ['unselected']);
  }
});


test('manifest validation rejects malformed, missing, nested and duplicate-name skills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ala-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'skill-catalog.json');
  for (const value of ['{broken', '{}', '[1]', '["relative"]', '["/missing-ala-skill"]']) {
    await writeFile(file, value);
    await assert.rejects(readSkillCatalog(file), /Invalid --skill-catalog manifest/);
  }
  await writeAnthropicSkill(root, 'one');
  const one = join(root, 'skills', 'one');
  await writeFile(file, JSON.stringify([one, one]));
  assert.deepEqual(await readSkillCatalog(file), [one]);
  await writeAnthropicSkill(join(root, 'other'), 'one');
  await writeFile(file, JSON.stringify([one, join(root, 'other', 'skills', 'one')]));
  await assert.rejects(readSkillCatalog(file), /Duplicate task-skill name/);
  await writeAnthropicSkill(one, 'nested');
  await writeFile(file, JSON.stringify([one]));
  await assert.rejects(readSkillCatalog(file), /nested skill/);
  await writeFile(file, '[]');
  assert.deepEqual(await readSkillCatalog(file), []);
});
