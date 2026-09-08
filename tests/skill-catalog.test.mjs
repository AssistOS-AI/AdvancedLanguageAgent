import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
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
  await mkdir(empty);
  await writeAnthropicSkill(join(workspace, '.agents'), 'unselected');
  await writeAnthropicSkill(catalog, 'selected');
  const binary = join(root, 'codex');
  await writeFile(binary, `#!/bin/sh
ls /workspace/.agents/skills > "$CODEX_HOME/visible-skills"
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
    if (names.length) assert.match(await readFile(join(home, '.codex/arguments'), 'utf8'), /selected test skill/);
    assert.deepEqual(await readdir(join(workspace, '.agents/skills')), ['unselected']);
  }
});
