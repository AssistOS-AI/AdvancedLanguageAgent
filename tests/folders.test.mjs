import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { buildSandboxArgs, canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';

import { resolveFolderMounts } from '../src/coding-agents/folders.mjs';
import net from 'node:net';

const sandboxSupported = canStartBubblewrap();
const liveSandbox = { skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process' };

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-bridge-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const bridge = join(root, 'bridge');
  await Promise.all([mkdir(workspace), mkdir(bridge, { mode: 0o700 })]);
  await mkdir(join(bridge, 'events'));
  await writeFile(join(bridge, 'context.json'), JSON.stringify({ version: 1, env: {} }));
  return { root, workspace, bridge };
}

test('folder mounts resolve aliases and reject missing sources and reserved destinations', async context => {
  const { root, bridge } = await fixture(context);
  const alias = join(root, 'alias');
  await symlink(bridge, alias);
  assert.deepEqual(resolveFolderMounts([{ source: alias }]), [{ source: bridge, target: alias }]);
  assert.deepEqual(resolveFolderMounts([{ source: bridge, alias: 'data files' }]),
    [{ source: bridge, target: '/workspace/data files' }]);
  for (const folder of [{ source: '' }, { source: join(root, 'missing') },
    { source: bridge, alias: '../escape' }, { source: bridge, alias: '.agents' },
    { source: bridge, target: '/usr' }, { source: bridge, target: '/workspace' }]) {
    assert.throws(() => resolveFolderMounts([folder]), { exitCode: 2 });
  }
  assert.throws(() => resolveFolderMounts([{ source: bridge, alias: 'same' },
    { source: bridge, alias: 'same' }]), /overlap/);
});

test('Folder mount sandbox isolates the selected catalog and preserves host authoring files through refresh', liveSandbox,
  async (context) => {
    const { root, workspace, bridge } = await fixture(context);
    const hostAgents = join(workspace, '.agents');
    const hostSkills = join(hostAgents, 'skills');
    const selected = join(hostSkills, 'selected');
    const disabled = join(hostSkills, 'disabled');
    const authoring = join(hostSkills, 'authoring');
    await Promise.all([selected, disabled, authoring].map((directory) => mkdir(directory, { recursive: true })));
    await Promise.all([
      writeFile(join(selected, 'SKILL.md'), 'selected descriptor'),
      writeFile(join(disabled, 'SKILL.md'), 'disabled descriptor'),
      writeFile(join(authoring, 'SKILL.md'), 'authoring descriptor'),
      writeFile(join(hostAgents, 'settings.json'), 'project settings'),
      writeFile(join(root, 'outside.txt'), 'outside private content'),
      symlink(join(root, 'outside.txt'), join(hostAgents, 'outside-link')),
      writeFile(join(bridge, 'client.mjs'), 'export const marker = "mounted client";\n', { mode: 0o600 })
    ]);
    const server = net.createServer(socket => socket.once('data', data => socket.end('ack:' + data)));
    await new Promise(resolve => server.listen(join(bridge, 'notifications.sock'), resolve));
    context.after(() => new Promise(resolve => server.close(resolve)));
    const script = `
import fs from 'node:fs';
import net from 'node:net';
import { marker } from '/workspace/runtime/client.mjs';
const result = {
  marker, cwd: process.cwd(),
  names: fs.readdirSync('/workspace/.agents/skills').sort(),
  settings: fs.readFileSync('/workspace/.agents/settings.json', 'utf8'),
  outsideVisible: fs.existsSync('/workspace/.agents/outside-link'),
  bridgeParentVisible: fs.existsSync(${JSON.stringify(join(root, 'outside.txt'))})
};
for (const [name, target] of Object.entries({
  bridgeWrite: '/workspace/runtime/context.json',
  selectedWrite: '/workspace/.agents/skills/selected/SKILL.md'
})) {
  try { fs.writeFileSync(target, 'changed'); result[name] = 'allowed'; }
  catch { result[name] = 'denied'; }
}
result.reply = await new Promise((resolve, reject) => {
  const socket = net.createConnection('/workspace/runtime/notifications.sock');
  socket.once('error', reject);
  socket.once('connect', () => socket.write('hello'));
  socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
});
fs.writeFileSync('/workspace/artifact.txt', 'persistent workspace output');
console.log(JSON.stringify(result));
`;
    const inspect = async ({ sandbox, signal }) => {
      // Start a system binary, then resolve Node from the sandbox runtime mounts.
      const result = await runProcess({
        binary: '/bin/sh', args: ['-c', 'exec node --input-type=module -e "$1"', 'bridge-test', script],
        cwd: '/workspace', env: { HOME: join(root, 'missing-home') }, sandbox, signal
      });
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const service = createCodingAgentService({
      agents: [{ name: 'pi', available: true, binary: '/bin/sh' }],
      workspace, folders: [{ source: bridge, alias: 'runtime' }],
      skills: [{ name: 'selected', directoryPath: selected }],
      runners: { pi: async (input) => ({ outputText: JSON.stringify(await inspect(input)), continuation: null }) },
      modelListers: { pi: inspect }
    });
    context.after(() => service.close());
    const first = JSON.parse(await service.execute('inspect selected catalog'));
    assert.deepEqual(first, {
      marker: 'mounted client', cwd: '/workspace', names: ['selected'], settings: 'project settings',
      outsideVisible: false, bridgeParentVisible: false, bridgeWrite: 'denied', selectedWrite: 'denied', reply: 'ack:hello'
    });
    assert.deepEqual(await service.listModels('pi'), first);
    await service.refreshSkills([]);
    assert.deepEqual(JSON.parse(await service.execute('inspect disabled catalog')).names, []);
    assert.deepEqual((await readdir(hostSkills)).sort(), ['authoring', 'disabled', 'selected']);
    assert.equal(await readFile(join(selected, 'SKILL.md'), 'utf8'), 'selected descriptor');
    assert.equal(await readFile(join(disabled, 'SKILL.md'), 'utf8'), 'disabled descriptor');
    assert.equal(await readFile(join(authoring, 'SKILL.md'), 'utf8'), 'authoring descriptor');
    assert.equal(await readFile(join(hostAgents, 'settings.json'), 'utf8'), 'project settings');
    assert.equal(await readlink(join(hostAgents, 'outside-link')), join(root, 'outside.txt'));
    assert.equal(await readFile(join(workspace, 'artifact.txt'), 'utf8'), 'persistent workspace output');
    assert.equal(JSON.parse(await readFile(join(bridge, 'context.json'), 'utf8')).version, 1);
  });

test('Folder mount creates missing skill mount points only inside the sandbox', liveSandbox, async (context) => {
  const { root, workspace, bridge } = await fixture(context);
  const selected = join(root, 'selected');
  await mkdir(selected);
  await writeFile(join(selected, 'SKILL.md'), 'selected');
  const result = await runProcess({
    binary: process.execPath, args: ['-e',
      'console.log(require("node:fs").readFileSync("/workspace/.agents/skills/selected/SKILL.md", "utf8"))'],
    cwd: '/workspace', env: { HOME: join(root, 'missing-home') },
    sandbox: { hostWorkspace: workspace, backend: 'pi', folders: [{ source: bridge, alias: 'runtime' }],
      mounts: [{ source: selected, target: '/workspace/.agents/skills/selected', writable: false }] }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'selected');
  await assert.rejects(() => access(join(workspace, '.agents', 'skills')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(workspace, '.agents')), []);
});

test('Folder mount rejects a symlinked host .agents parent rather than mounting its target', async (context) => {
  const { root, workspace, bridge } = await fixture(context);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(workspace, '.agents'));
  assert.throws(() => buildSandboxArgs({
    workspace, binary: process.execPath, backend: 'pi', bwrap: '/usr/bin/bwrap',
    privateProc: false, folders: [{ source: bridge, alias: 'runtime' }]
  }), /requires .agents to be a directory/);
  assert.deepEqual(await readdir(outside), []);
});

test('a folder without an alias is visible read-only at the original absolute path', liveSandbox, async context => {
  const { root, workspace, bridge } = await fixture(context);
  const sourceAlias = join(root, 'source-alias');
  await symlink(bridge, sourceAlias);
  const result = await runProcess({
    binary: process.execPath, args: ['-e', `
      const fs = require('node:fs');
      const directory = ${JSON.stringify(sourceAlias)};
      const value = JSON.parse(fs.readFileSync(directory + '/context.json'));
      try { fs.writeFileSync(directory + '/new-file', 'changed'); process.exit(1); } catch {}
      console.log(value.version);
    `],
    cwd: '/workspace', env: { HOME: join(root, 'missing-home') },
    sandbox: { hostWorkspace: workspace, backend: 'pi', folders: [{ source: sourceAlias }] }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1');
});
