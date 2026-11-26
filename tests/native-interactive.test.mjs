import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AGENT_NAMES } from '../src/coding-agents/registry.mjs';
import { buildInteractiveCommand } from '../src/coding-agents/native-interactive.mjs';
import { buildSandboxArgs, canStartBubblewrap, findBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { onlyOnLinux } from './helpers.mjs';

const expected = {
  codex: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'],
  opencode: ['--standalone', '--auto'], pi: ['--approve'], omp: ['--auto-approve'],
  claude: ['--permission-mode', 'bypassPermissions'], vibe: ['--auto-approve', '--trust'],
  agy: ['--dangerously-skip-permissions']
};

for (const agent of AGENT_NAMES) {
  test(`${agent} native terminal receives full access for new and resumed conversations`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ala-interactive-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = path.join(root, 'fake agent');
    await writeFile(binary, `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), sandbox: process.env.IS_SANDBOX,
  permission: process.env.OPENCODE_PERMISSION, search: process.env.OPENCODE_ENABLE_EXA }));
`, { mode: 0o700 });
    const catalog = await import(`../src/coding-agents/agents/${agent}/sessions.mjs`);
    for (const session of [{}, { resume: '11111111-1111-4111-8111-111111111111' }]) {
      const args = catalog.interactiveArguments(session);
      const command = buildInteractiveCommand({ agent, binary, args });
      // Simulate a profile setting restrictive values before the command is exec'd.
      const child = spawnSync('/bin/sh', ['-c', 'export IS_SANDBOX=0 OPENCODE_PERMISSION=deny; exec "$0" "$@"',
        ...command], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.deepEqual(result.args, [...expected[agent], ...args]);
      if (agent === 'claude') assert.equal(result.sandbox, '1');
      if (agent === 'opencode') {
        assert.deepEqual(JSON.parse(result.permission), { '*': 'allow', external_directory: 'allow' });
        assert.equal(result.search, '1');
      }
    }
  });
}

test('native interactive command refuses unknown backends and invalid session arguments', () => {
  for (const input of [{ agent: 'missing', binary: '/bin/true' },
    { agent: 'pi', binary: 'relative' }, { agent: 'pi', binary: '/bin/true', args: ['$(id)'] }]) {
    assert.throws(() => buildInteractiveCommand(input), TypeError);
  }
});

const bwrap = findBubblewrap();
test('full-access interactive process still cannot see outside its Bubblewrap grants', {
  skip: onlyOnLinux(canStartBubblewrap(bwrap) ? false : 'Bubblewrap cannot start in this test process')
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ala-interactive-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  const home = path.join(root, 'home');
  await mkdir(workspace); await mkdir(home);
  const hidden = path.join(root, 'outside');
  await writeFile(hidden, 'not granted');
  const binary = path.join(workspace, 'fake');
  await writeFile(binary, `#!/bin/sh
[ "$1" = --permission-mode ] && [ "$2" = bypassPermissions ] && [ "$IS_SANDBOX" = 1 ] || exit 10
[ ! -e '${hidden}' ] || exit 11
printf ok > '${workspace}/result'
`, { mode: 0o700 });
  const args = buildSandboxArgs({ workspace, home, binary: '/bin/sh', bwrap, env: {},
    args: ['-c', 'exec "$0" "$@"', ...buildInteractiveCommand({ agent: 'claude', binary })] });
  const child = spawnSync(bwrap, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(path.join(workspace, 'result'), 'utf8'), 'ok');
});
