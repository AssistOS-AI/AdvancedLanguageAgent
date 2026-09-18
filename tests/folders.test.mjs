import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import { buildSandboxArgs, canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { resolveFolderMounts } from '../src/coding-agents/folders.mjs';

const sandboxSupported = canStartBubblewrap();
const liveSandbox = { skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process' };

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-bridge-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const bridge = join(root, 'bridge');
  await Promise.all([mkdir(workspace), mkdir(bridge, { mode: 0o700 })]);
  await writeFile(join(bridge, 'context.json'), JSON.stringify({ version: 1, env: {} }));
  return { root, workspace, bridge };
}

test('folder mounts resolve aliases, keep canonical paths, and reject reserved destinations', async context => {
  const { root, bridge } = await fixture(context);
  const alias = join(root, 'alias');
  await symlink(bridge, alias);
  assert.deepEqual(resolveFolderMounts([{ source: alias }]), [{ source: bridge, target: alias, writable: false }]);
  assert.deepEqual(resolveFolderMounts([{ source: bridge, alias: 'data files' }]),
    [{ source: bridge, target: '/workspace/data files', writable: false }]);
  assert.deepEqual(resolveFolderMounts([{ source: bridge, writable: true }]),
    [{ source: bridge, target: bridge, writable: true }]);
  for (const folder of [{ source: '' }, { source: join(root, 'missing') },
    { source: bridge, alias: '../escape' }, { source: bridge, alias: '.agents' }]) {
    assert.throws(() => resolveFolderMounts([folder]), { exitCode: 2 });
  }
  assert.throws(() => resolveFolderMounts([{ source: bridge, alias: 'same' },
    { source: bridge, alias: 'same' }]), /overlap/);
});

test('folder resolution is idempotent for aliased and canonical mounts', async context => {
  const { bridge } = await fixture(context);
  const first = resolveFolderMounts([{ source: bridge, alias: 'runtime' }, { source: bridge, writable: true }], bridge);
  assert.deepEqual(first, [
    { source: bridge, target: '/workspace/runtime', writable: false },
    { source: bridge, target: bridge, writable: true }
  ]);
  const second = resolveFolderMounts(first, bridge);
  assert.deepEqual(second, first);
});

test('folder mounts are visible at their canonical path and alias with caller-selected write access', liveSandbox,
  async context => {
    const { root, workspace, bridge } = await fixture(context);
    const writable = join(root, 'writable');
    await mkdir(writable);
    const script = `
      const fs = require('node:fs');
      const out = { cwd: process.cwd() };
      try { fs.writeFileSync(${JSON.stringify(bridge)} + '/new', 'changed'); out.bridgeWrite = 'allowed'; }
      catch { out.bridgeWrite = 'denied'; }
      try { fs.writeFileSync(${JSON.stringify(writable)} + '/new', 'changed'); out.writableWrite = 'allowed'; }
      catch { out.writableWrite = 'denied'; }
      out.alias = JSON.parse(fs.readFileSync('/workspace/runtime/context.json', 'utf8')).version;
      out.workspaceWrite = (() => { try { fs.writeFileSync(${JSON.stringify(workspace)} + '/new', 'x'); return 'allowed'; } catch { return 'denied'; } })();
      console.log(JSON.stringify(out));
    `;
    const result = await runProcess({
      binary: process.execPath, args: ['-e', script], cwd: workspace,
      env: { HOME: join(root, 'missing-home') },
      sandbox: { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'pi',
        home: join(root, 'missing-home'), folders: [{ source: bridge, alias: 'runtime' }, { source: writable, writable: true }] }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: workspace, bridgeWrite: 'denied', writableWrite: 'allowed', alias: 1, workspaceWrite: 'allowed'
    });
    assert.equal(await readFile(join(writable, 'new'), 'utf8'), 'changed');
  });

test('buildSandboxArgs rejects a mounted folder duplicating the working directory', async context => {
  const { workspace, bridge } = await fixture(context);
  assert.throws(() => buildSandboxArgs({
    workspace, workspaceTarget: workspace, binary: process.execPath, backend: 'pi', bwrap: '/usr/bin/bwrap',
    privateProc: false, folders: [{ source: bridge, alias: 'runtime' }, { source: workspace }]
  }), /duplicates the working directory/);
});
