import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArguments } from '../src/arguments.mjs';
import { ignoredMountTargets } from '../src/coding-agents/ignored-paths.mjs';
import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { canMountPrivateProc, canStartBubblewrap, findBubblewrap } from '../src/coding-agents/sandbox.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ala-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  const secret = path.join(workspace, '.private');
  await mkdir(path.join(secret, 'sessions'), { recursive: true });
  await writeFile(path.join(secret, 'sessions', 'secret.txt'), 'private history');
  return { root, workspace, secret };
}

test('ignore accepts repeated arguments and requires values', () => {
  assert.deepEqual(parseArguments(['--ignore', '/one', '--ignore', '/two']).ignoredPaths, ['/one', '/two']);
  assert.throws(() => parseArguments(['--ignore']), /requires a value/);
});

test('ignore masks canonical, aliased and directly mounted descendants', async t => {
  const { root, workspace, secret } = await fixture(t);
  const link = path.join(root, 'linked');
  await symlink(secret, link);
  const mounts = [
    { source: workspace, target: workspace },
    { source: workspace, target: '/workspace/alias' },
    { source: link, target: '/workspace/private' },
    { source: path.join(secret, 'sessions'), target: '/workspace/history' }
  ];
  assert.deepEqual(new Set(ignoredMountTargets([secret], mounts, workspace)), new Set([
    secret, '/workspace/alias/.private', '/workspace/private', '/workspace/history'
  ]));
  assert.throws(() => ignoredMountTargets([workspace], mounts, workspace), /working directory/);
  assert.throws(() => ignoredMountTargets(['relative'], mounts, workspace), /absolute directory/);
  assert.throws(() => ignoredMountTargets([path.join(root, 'missing')], mounts, workspace), /absolute directory/);
  assert.throws(() => ignoredMountTargets([root], [], workspace), /not exposed/);
});

const bwrap = findBubblewrap();
test('explicit read-only exports retain only a strict subtree outside ignored destinations', async t => {
  const { root, workspace, secret } = await fixture(t);
  const source = path.join(secret, 'sessions');
  const exported = { source, target: '/workspace/exported', expose: true };
  const mounts = [{ source: workspace, target: workspace }, exported];
  assert.deepEqual(ignoredMountTargets([secret], mounts, workspace), [secret]);
  // Ordinary aliases remain masked, even when an explicit export uses the same source.
  assert.deepEqual(new Set(ignoredMountTargets([secret], [...mounts,
    { source, target: '/workspace/history' }], workspace)), new Set([secret, '/workspace/history']));
  for (const mount of [{ ...exported, source: secret }, { ...exported, writable: true },
    { ...exported, target: path.join(secret, 'export') }]) {
    assert.throws(() => ignoredMountTargets([secret], [mounts[0], mount], workspace), { exitCode: 5 });
  }
  // A second, narrower ignore must still mask content inside the exported source.
  const nested = path.join(source, 'nested');
  await mkdir(nested);
  assert.deepEqual(new Set(ignoredMountTargets([secret, nested], mounts, workspace)),
    new Set([secret, '/workspace/exported/nested']));
  const link = path.join(root, 'private-link');
  await symlink(secret, link);
  assert.throws(() => ignoredMountTargets([secret], [mounts[0], { ...exported, source: link }], workspace),
    /strict subdirectory/);
});

test('continuations and model queries receive the same ignored paths', async t => {
  const { workspace, secret } = await fixture(t);
  const contexts = [];
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    workspace, ignoredPaths: [secret],
    runners: { codex: async input => {
      contexts.push(input.sandbox);
      return { outputText: 'done', continuation: { threadId: 'same-thread' } };
    } },
    modelListers: { codex: async input => { contexts.push(input.sandbox); return []; } }
  });
  t.after(() => service.close());
  await service.execute('first');
  await service.execute('continue');
  await service.listModels('codex');
  assert.equal(contexts.length, 3);
  for (const context of contexts) assert.deepEqual(context.ignoredPaths, [secret]);
});

test('masked directories are empty and read-only through every mounted alias', {
  skip: canStartBubblewrap(bwrap) && canMountPrivateProc(bwrap) ? false : 'Bubblewrap unavailable'
}, async t => {
  const { workspace, secret } = await fixture(t);
  const paths = [secret, '/workspace/copy/.private', '/workspace/history'];
  const script = `
    const fs = require('node:fs');
    const result = ${JSON.stringify(paths)}.map(p => {
      let writable = false;
      try { fs.writeFileSync(p + '/leak', 'x'); writable = true; } catch {}
      return { entries: fs.readdirSync(p), writable };
    });
    fs.writeFileSync('artifact.txt', 'work');
    process.stdout.write(JSON.stringify(result));
  `;
  const result = await runProcess({
    binary: process.execPath, args: ['-e', script], cwd: workspace,
    sandbox: { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'codex',
      ignoredPaths: [secret], folders: [
        { source: workspace, alias: 'copy' },
        { source: path.join(secret, 'sessions'), alias: 'history', writable: true }
      ] }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), paths.map(() => ({ entries: [], writable: false })));
  assert.equal(await readFile(path.join(secret, 'sessions', 'secret.txt'), 'utf8'), 'private history');
  assert.equal(await readFile(path.join(workspace, 'artifact.txt'), 'utf8'), 'work');
});

test('explicit exports exempt strict descendants but never the ignored directory itself', async t => {
  const { workspace, secret } = await fixture(t);
  const child = path.join(secret, 'sessions');
  const mounts = [{ source: workspace, target: workspace },
    { source: child, target: '/workspace/export', expose: true },
    { source: secret, target: '/workspace/all-private', expose: true }];
  assert.deepEqual(new Set(ignoredMountTargets([secret], mounts, workspace)), new Set([secret, '/workspace/all-private']));
  assert.ok(ignoredMountTargets([secret, child], mounts, workspace).includes('/workspace/export'));
});
