import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { buildSandboxArgs, canStartBubblewrap, validateRuntimeBridge } from '../src/coding-agents/sandbox.mjs';

const sandboxSupported = canStartBubblewrap();
const liveSandbox = { skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process' };

async function fixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-bridge-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const bridge = join(root, 'bridge');
  await Promise.all([mkdir(workspace), mkdir(bridge, { mode: 0o700 })]);
  return { root, workspace, bridge };
}

test('runtime bridge rejects missing, noncanonical, symlinked and expired directory capabilities', async (context) => {
  const { root, workspace, bridge } = await fixture(context);
  const file = join(root, 'file');
  const alias = join(root, 'alias');
  await writeFile(file, 'not a directory');
  await symlink(bridge, alias);
  for (const value of ['', 'bridge', file, alias, join(root, 'missing'), `${bridge}/../bridge`]) {
    assert.throws(() => validateRuntimeBridge(value), { exitCode: 2 });
    assert.throws(() => createCodingAgentService({ agents: [], runtimeBridge: value }), { exitCode: 2 });
  }
  assert.equal(validateRuntimeBridge(bridge), bridge);
  await rm(bridge, { recursive: true });
  await symlink(workspace, bridge);
  assert.throws(() => buildSandboxArgs({
    workspace, binary: process.execPath, backend: 'pi', bwrap: '/usr/bin/bwrap',
    privateProc: false, runtimeBridge: bridge
  }), { exitCode: 2 });
});

test('bridge sandbox isolates the selected catalog and preserves host authoring files through refresh', liveSandbox,
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
      writeFile(join(bridge, 'client.mjs'), 'export const marker = "mounted client";\n', { mode: 0o600 }),
      writeFile(join(bridge, 'capability.json'), JSON.stringify({
        version: 1, socketPath: '/run/ala-runtime/bridge.sock', capability: 'fixture-capability'
      }), { mode: 0o600 })
    ]);
    const server = createServer((socket) => {
      socket.once('data', (data) => socket.end(`accepted:${data.toString()}`));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(bridge, 'bridge.sock'), resolve);
    });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const script = `
import fs from 'node:fs';
import net from 'node:net';
import { marker } from '/run/ala-runtime/client.mjs';
const descriptor = JSON.parse(fs.readFileSync('/run/ala-runtime/capability.json', 'utf8'));
const result = {
  marker, cwd: process.cwd(),
  names: fs.readdirSync('/workspace/.agents/skills').sort(),
  settings: fs.readFileSync('/workspace/.agents/settings.json', 'utf8'),
  outsideVisible: fs.existsSync('/workspace/.agents/outside-link'),
  bridgeParentVisible: fs.existsSync(${JSON.stringify(join(root, 'outside.txt'))})
};
for (const [name, target] of Object.entries({
  bridgeWrite: '/run/ala-runtime/capability.json',
  selectedWrite: '/workspace/.agents/skills/selected/SKILL.md'
})) {
  try { fs.writeFileSync(target, 'changed'); result[name] = 'allowed'; }
  catch { result[name] = 'denied'; }
}
result.reply = await new Promise((resolve, reject) => {
  const socket = net.createConnection(descriptor.socketPath);
  socket.once('error', reject);
  socket.once('connect', () => socket.write(descriptor.capability));
  socket.once('data', (data) => { socket.end(); resolve(data.toString()); });
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
      workspace, runtimeBridge: bridge,
      skills: [{ name: 'selected', directoryPath: selected }],
      runners: { pi: async (input) => ({ outputText: JSON.stringify(await inspect(input)), continuation: null }) },
      modelListers: { pi: inspect }
    });
    context.after(() => service.close());
    const first = JSON.parse(await service.execute('inspect selected catalog'));
    assert.deepEqual(first, {
      marker: 'mounted client', cwd: '/workspace', names: ['selected'], settings: 'project settings',
      outsideVisible: false, bridgeParentVisible: false, bridgeWrite: 'denied', selectedWrite: 'denied',
      reply: 'accepted:fixture-capability'
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
    assert.equal(JSON.parse(await readFile(join(bridge, 'capability.json'), 'utf8')).capability, 'fixture-capability');
  });

test('bridge creates missing skill mount points only inside the sandbox', liveSandbox, async (context) => {
  const { root, workspace, bridge } = await fixture(context);
  const selected = join(root, 'selected');
  await mkdir(selected);
  await writeFile(join(selected, 'SKILL.md'), 'selected');
  const result = await runProcess({
    binary: process.execPath, args: ['-e',
      'console.log(require("node:fs").readFileSync("/workspace/.agents/skills/selected/SKILL.md", "utf8"))'],
    cwd: '/workspace', env: { HOME: join(root, 'missing-home') },
    sandbox: { hostWorkspace: workspace, backend: 'pi', runtimeBridge: bridge,
      mounts: [{ source: selected, target: '/workspace/.agents/skills/selected', writable: false }] }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'selected');
  await assert.rejects(() => access(join(workspace, '.agents', 'skills')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(workspace, '.agents')), []);
});

test('bridge rejects a symlinked host .agents parent rather than mounting its target', async (context) => {
  const { root, workspace, bridge } = await fixture(context);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(workspace, '.agents'));
  assert.throws(() => buildSandboxArgs({
    workspace, binary: process.execPath, backend: 'pi', bwrap: '/usr/bin/bwrap',
    privateProc: false, runtimeBridge: bridge
  }), /requires .agents to be a directory/);
  assert.deepEqual(await readdir(outside), []);
});
