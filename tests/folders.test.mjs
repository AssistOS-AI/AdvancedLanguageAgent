import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, fstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli.mjs';
import { runProcess } from '../src/coding-agents/process.mjs';
import { buildSandboxArgs, canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { pinFolderMounts, resolveFolderMounts } from '../src/coding-agents/folders.mjs';
import { openSessionState } from '../src/session-state.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { captureStream, inputStream } from './helpers.mjs';

const sandboxModule = await import('../src/coding-agents/sandbox.mjs');
// Read through the namespace so a missing export fails only the tests that need it.
const sandboxDescriptors = (...args) => sandboxModule.sandboxDescriptors(...args);
const canBindDescriptors = (...args) => sandboxModule.canBindDescriptors?.(...args) ?? false;
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

test('only explicit read-only child exports may overlap a read-only folder', async context => {
  const { root, bridge } = await fixture(context);
  const parent = { source: root };
  const child = { source: bridge, target: join(root, 'export'), expose: true };
  for (const folders of [[parent, child], [child, parent]]) {
    const mounts = resolveFolderMounts(folders);
    assert.deepEqual(resolveFolderMounts(mounts), mounts);
  }
  for (const folders of [[parent, { source: bridge }], [parent, { ...child, expose: false }],
    [{ ...parent, writable: true }, child], [child, child],
    [{ ...child, writable: true }], [{ source: bridge, expose: true }],
    [{ ...child, alias: 'another' }]]) {
    assert.throws(() => resolveFolderMounts(folders), { exitCode: 2 });
  }
  for (const target of ['relative', '/usr/export', '/home/ala/export', '/workspace/.agents/skills', '/work/../export']) {
    assert.throws(() => resolveFolderMounts([{ source: bridge, target, expose: true }]), { exitCode: 2 });
  }
});

test('folder mounts are visible at their canonical path and alias with caller-selected write access', liveSandbox,
  async context => {
    const { root, workspace, bridge } = await fixture(context);
    const writable = join(root, 'writable');
    const home = join(root, 'home');
    await Promise.all([mkdir(writable), mkdir(home)]);
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
        home, folders: [{ source: bridge, alias: 'runtime' }, { source: writable, writable: true }] }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: workspace, bridgeWrite: 'denied', writableWrite: 'allowed', alias: 1, workspaceWrite: 'allowed'
    });
    assert.equal(await readFile(join(writable, 'new'), 'utf8'), 'changed');
  });

test('buildSandboxArgs rejects a mounted folder duplicating the working directory', {
  skip: process.platform !== 'linux' ? 'Linux sandbox validation' : false
}, async context => {
  const { workspace, bridge } = await fixture(context);
  assert.throws(() => buildSandboxArgs({
    workspace, workspaceTarget: workspace, binary: process.execPath, backend: 'pi', bwrap: '/usr/bin/bwrap',
    privateProc: false, folders: [{ source: bridge, alias: 'runtime' }, { source: workspace }]
  }), /duplicates the working directory/);
});

const identityOf = async (directory) => {
  const stat = await lstat(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

async function swapFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-swap-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const parent = join(root, 'parent');
  const folder = join(parent, 'folder');
  const sibling = join(root, 'sibling');
  await Promise.all([mkdir(workspace), mkdir(folder, { recursive: true }), mkdir(join(sibling, 'folder'), { recursive: true })]);
  await writeFile(join(folder, 'granted.txt'), 'granted');
  await writeFile(join(sibling, 'folder', 'marker-B'), 'marker-B');
  await writeFile(join(sibling, 'marker-B'), 'marker-B');
  // A robot that can write the parent replaces either the folder or a component above it.
  const swapLast = async () => { await rename(folder, `${folder}-moved`); await symlink(join(sibling, 'folder'), folder); };
  const swapAbove = async () => { await rename(parent, `${parent}-moved`); await symlink(sibling, parent); };
  return { root, workspace, parent, folder, sibling, swapLast, swapAbove };
}

async function fakeBubblewrap(root, help = '--bind-fd') {
  const file = join(root, 'fake-bwrap');
  await writeFile(file, `#!/bin/sh\necho '${help}'\n`, { mode: 0o755 });
  return file;
}

function asLinux(context) {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  context.after(() => Object.defineProperty(process, 'platform', { value: platform }));
}

test('a pinned directory keeps its identity after a swap of the folder or of a component above it', async context => {
  const { pinDirectory } = await import('../src/coding-agents/folders.mjs');
  for (const swap of ['swapLast', 'swapAbove']) {
    const f = await swapFixture(context);
    const recorded = await identityOf(f.folder);
    const pin = pinDirectory(f.folder, recorded);
    await f[swap]();
    assert.notEqual(await identityOf(await realpath(f.folder)), recorded, swap);
    const stat = fstatSync(pin.fd, { bigint: true });
    assert.equal(`${stat.dev}:${stat.ino}`, recorded, swap);
    closeSync(pin.fd);
  }
});

test('a swap before the directory is opened refuses with a clear error and its own exit code', async context => {
  const { pinDirectory } = await import('../src/coding-agents/folders.mjs');
  const f = await swapFixture(context);
  const recorded = await identityOf(f.folder);
  assert.throws(() => pinDirectory(f.folder, '1:1'), { exitCode: 78, message: /changed or is unavailable/u });
  await f.swapLast();
  // The last component is never followed, and following it after resolving still shows another directory.
  assert.throws(() => pinDirectory(f.folder, recorded), { exitCode: 78 });
  assert.throws(() => pinDirectory(realpathSync(f.folder), recorded), { exitCode: 78 });
  const above = await swapFixture(context);
  const before = await identityOf(above.folder);
  await above.swapAbove();
  assert.throws(() => pinDirectory(above.folder, before), { exitCode: 78 });
});

test('--expect-dir refuses a swapped cwd or folder before any session file exists', async context => {
  const f = await swapFixture(context);
  const home = join(f.root, 'home');
  await mkdir(home);
  const run = async (argv) => {
    const stderr = captureStream();
    const code = await runCli({ argv: ['--home', home, '--cwd', f.workspace, '--session-id', '11111111-1111-4111-8111-111111111111',
      '--control-stdin', ...argv], env: { CODEX_BIN: process.execPath, HOME: home, PATH: process.env.PATH }, stdin: inputStream(''),
    stdout: captureStream(), stderr, cwd: f.root, fetchImpl: () => { throw new Error('unused'); } });
    return { code, stderr: stderr.read() };
  };
  const folderIdentity = await identityOf(f.folder);
  const cwdIdentity = await identityOf(f.workspace);
  await f.swapLast();
  const folder = await run(['--folder', f.folder, '--expect-dir', `${folderIdentity}:${f.folder}`]);
  assert.equal(folder.code, 78, folder.stderr);
  assert.match(folder.stderr, /changed or is unavailable/u);
  const moved = join(f.root, 'workspace-moved');
  await rename(f.workspace, moved);
  await symlink(f.sibling, f.workspace);
  const cwd = await run(['--expect-dir', `${cwdIdentity}:${f.workspace}`]);
  assert.equal(cwd.code, 78, cwd.stderr);
  for (const directory of [moved, f.sibling]) await assert.rejects(lstat(join(directory, '.ala')), { code: 'ENOENT' });
  assert.equal((await run(['--expect-dir', `${cwdIdentity}:${join(f.root, 'unrelated')}`])).code, 2);
  assert.equal((await run(['--expect-dir', 'malformed'])).code, 2);
});

test('a recorded identity decides before the configuration, and a missing or non-directory path exits 78', async context => {
  const ala = fileURLToPath(new URL('../bin/ala.mjs', import.meta.url));
  const run = (f, home, argv) => spawnSync(process.execPath, [ala, '--home', home, '--cwd', f.workspace, '--session-id', '11111111-1111-4111-8111-111111111111',
    '--task', 'x', ...argv], { encoding: 'utf8', timeout: 5000, env: { CODEX_BIN: process.execPath, HOME: home, PATH: process.env.PATH } });
  const setup = async () => {
    const f = await swapFixture(context);
    const home = join(f.root, 'home');
    await mkdir(join(home, '.ala'), { recursive: true });
    return { f, home, cwdIdentity: await identityOf(f.workspace), folderIdentity: await identityOf(f.folder) };
  };
  // A robot-written FIFO would hang ALA if the configuration were read first.
  const fifo = await setup();
  assert.equal(spawnSync('mkfifo', [join(fifo.home, '.ala', 'config.json')]).status, 0);
  await rm(fifo.f.workspace, { recursive: true });
  await mkdir(fifo.f.workspace);
  assert.equal(run(fifo.f, fifo.home, ['--expect-dir', `${fifo.cwdIdentity}:${fifo.f.workspace}`]).status, 78);
  const invalid = await setup();
  await writeFile(join(invalid.home, '.ala', 'config.json'), '{"bogus":1}');
  await rm(invalid.f.workspace, { recursive: true });
  await mkdir(invalid.f.workspace);
  assert.equal(run(invalid.f, invalid.home, ['--expect-dir', `${invalid.cwdIdentity}:${invalid.f.workspace}`]).status, 78);
  const missing = await setup();
  await rm(missing.f.workspace, { recursive: true });
  assert.equal(run(missing.f, missing.home, ['--expect-dir', `${missing.cwdIdentity}:${missing.f.workspace}`]).status, 78);
  const file = await setup();
  await rm(file.f.workspace, { recursive: true });
  await writeFile(file.f.workspace, 'x');
  assert.equal(run(file.f, file.home, ['--expect-dir', `${file.cwdIdentity}:${file.f.workspace}`]).status, 78);
  for (const remove of [(f) => rm(f.folder, { recursive: true }), async (f) => { await rm(f.folder, { recursive: true }); await writeFile(f.folder, 'x'); }]) {
    const folder = await setup();
    await remove(folder.f);
    assert.equal(run(folder.f, folder.home, ['--folder', folder.f.folder, '--expect-dir', `${folder.folderIdentity}:${folder.f.folder}`]).status, 78);
  }
  // A late swap inside the service is reported the same way as the check before it.
  assert.throws(() => pinFolderMounts([{ source: join(missing.f.root, 'gone') }], missing.f.root, { [join(missing.f.root, 'gone')]: '1:1' }), { exitCode: 78 });
});

test('a planted private directory link is refused before anything is written through it', async context => {
  const f = await swapFixture(context);
  const home = join(f.root, 'home');
  await mkdir(home);
  const cwdIdentity = await identityOf(f.workspace);
  await symlink(f.sibling, join(f.workspace, '.roboteam'));
  const stderr = captureStream();
  const code = await runCli({ argv: ['--home', home, '--cwd', f.workspace, '--session-id', '11111111-1111-4111-8111-111111111111', '--control-stdin',
    '--expect-dir', `${cwdIdentity}:${f.workspace}`], env: { CODEX_BIN: process.execPath, HOME: home, PATH: process.env.PATH, ALA_SESSIONS: join(f.workspace, '.roboteam', '.ala') },
  stdin: inputStream(''), stdout: captureStream(), stderr, cwd: f.root, fetchImpl: () => { throw new Error('unused'); } });
  assert.equal(code, 78, stderr.read());
  assert.match(stderr.read(), /Session storage must be a real directory/u);
  await assert.rejects(lstat(join(f.sibling, '.ala')), { code: 'ENOENT' });
});

test('closing a session whose folder was swapped away reports the original failure, not its lock', {
  skip: process.platform === 'linux' ? false : 'Session locks read /proc'
}, async context => {
  const f = await swapFixture(context);
  const state = await openSessionState({ id: '11111111-1111-4111-8111-111111111111', sessionsRoot: join(f.workspace, '.ala'), anchor: f.workspace });
  await rename(f.workspace, `${f.workspace}-moved`);
  await symlink(f.sibling, f.workspace);
  await state.close();
});

test('the service binds pinned descriptors, so a later swap changes neither mounts nor masks', async context => {
  const f = await swapFixture(context);
  const bwrap = await fakeBubblewrap(f.root);
  const mask = join(f.workspace, '.roboteam');
  await mkdir(mask);
  const contexts = [];
  const service = createCodingAgentService({
    agents: [{ name: 'pi', available: true, binary: process.execPath }], workspace: f.workspace, cwd: f.workspace,
    folders: [{ source: f.folder, alias: 'runtime' }, { source: join(f.sibling, 'folder') }], env: { ALA_BWRAP: bwrap },
    ignoredPaths: [mask],
    runners: { pi: async (input) => { contexts.push(input.sandbox); return { outputText: 'done', continuation: null }; } }
  });
  context.after(() => service.close());
  await f.swapAbove();
  await service.execute('first');
  const [sandbox] = contexts;
  assert.equal(Number.isInteger(sandbox.workspaceFd), true);
  assert.deepEqual(sandboxDescriptors(sandbox), [sandbox.workspaceFd, ...sandbox.folders.map((mount) => mount.fd)]);
  asLinux(context);
  const args = buildSandboxArgs({ workspace: sandbox.hostWorkspace, workspaceFd: sandbox.workspaceFd, folders: sandbox.folders,
    ignoredPaths: sandbox.ignoredPaths, binary: process.execPath, backend: 'pi', bwrap, privateProc: true, env: { ALA_BWRAP: bwrap } });
  const triple = (flag, target) => args.some((value, index) => value === flag && /^\d+$/u.test(args[index + 1]) && args[index + 2] === target);
  assert.equal(triple('--bind-fd', f.workspace), true);
  assert.equal(triple('--ro-bind-fd', '/workspace/runtime'), true);
  // Child descriptors follow the standard streams in the order the service hands the host descriptors over.
  const numbered = (target) => Number(args[args.indexOf(target) - 1]);
  assert.equal(numbered(f.workspace), 3);
  assert.equal(numbered('/workspace/runtime'), 4);
  assert.equal(args.some((value, index) => ['--bind', '--ro-bind'].includes(value)
    && [f.folder, f.workspace, join(f.parent, 'folder')].includes(args[index + 1])), false);
  assert.equal(args.some((value, index) => value === '--tmpfs' && args[index + 1] === mask), true);
});

test('a spawned sandbox process inherits each pinned directory at the descriptor its arguments name', async context => {
  const f = await swapFixture(context);
  const report = join(f.root, 'descriptors.json');
  // Stands in for Bubblewrap on the descriptors only: it stats what it inherited, as Bubblewrap does before its bind.
  const bwrap = join(f.root, 'fake-bwrap');
  await writeFile(bwrap, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--help') { console.log('--bind-fd'); process.exit(0); }
const out = {};
argv.forEach((value, index) => {
  if (!['--bind-fd', '--ro-bind-fd'].includes(value)) return;
  const stat = fs.fstatSync(Number(argv[index + 1]), { bigint: true });
  out[argv[index + 2]] = value + ' ' + stat.dev + ':' + stat.ino;
});
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(out));
`, { mode: 0o755 });
  const recorded = { workspace: await identityOf(f.workspace), folder: await identityOf(f.folder) };
  const contexts = [];
  const service = createCodingAgentService({
    agents: [{ name: 'pi', available: true, binary: process.execPath }], workspace: f.workspace, cwd: f.workspace,
    folders: [{ source: f.folder, alias: 'runtime' }], folderIdentities: { [f.folder]: recorded.folder }, workspaceIdentity: recorded.workspace,
    env: { ALA_BWRAP: bwrap },
    runners: { pi: async (input) => { contexts.push(input.sandbox); return { outputText: 'done', continuation: null }; } }
  });
  context.after(() => service.close());
  await service.execute('first');
  await f.swapAbove();
  await rename(f.workspace, `${f.workspace}-moved`);
  await symlink(f.sibling, f.workspace);
  asLinux(context);
  const result = await runProcess({ binary: process.execPath, args: ['--version'], cwd: f.workspace, env: { ALA_BWRAP: bwrap },
    sandbox: contexts[0] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {
    [f.workspace]: `--bind-fd ${recorded.workspace}`, '/workspace/runtime': `--ro-bind-fd ${recorded.folder}`
  });
});

test('a swapped working directory never moves its mask: the sandbox refuses instead', async context => {
  const f = await swapFixture(context);
  const bwrap = await fakeBubblewrap(f.root);
  const mask = join(f.workspace, '.roboteam');
  await mkdir(mask);
  const contexts = [];
  const service = createCodingAgentService({
    agents: [{ name: 'pi', available: true, binary: process.execPath }], workspace: f.workspace, cwd: f.workspace,
    env: { ALA_BWRAP: bwrap }, ignoredPaths: [mask],
    runners: { pi: async (input) => { contexts.push(input.sandbox); return { outputText: 'done', continuation: null }; } }
  });
  context.after(() => service.close());
  await service.execute('first');
  await rename(f.workspace, `${f.workspace}-moved`);
  await symlink(f.sibling, f.workspace);
  await mkdir(join(f.sibling, '.roboteam'));
  asLinux(context);
  assert.throws(() => buildSandboxArgs({ workspace: contexts[0].hostWorkspace, workspaceFd: contexts[0].workspaceFd,
    ignoredPaths: contexts[0].ignoredPaths, binary: process.execPath, backend: 'pi', bwrap, privateProc: true, env: {} }), /--ignore/u);
});

test('a Bubblewrap without descriptor binds keeps path binds for plain callers and refuses recorded identities', async context => {
  const f = await swapFixture(context);
  const bwrap = await fakeBubblewrap(f.root, 'no such option here');
  const agents = [{ name: 'pi', available: true, binary: process.execPath }];
  const contexts = [];
  const plain = createCodingAgentService({ agents, workspace: f.workspace, folders: [{ source: f.folder }], env: { ALA_BWRAP: bwrap },
    runners: { pi: async (input) => { contexts.push(input.sandbox); return { outputText: 'done', continuation: null }; } } });
  context.after(() => plain.close());
  await plain.execute('first');
  assert.equal(contexts[0].workspaceFd, undefined);
  assert.equal(contexts[0].folders[0].fd, undefined);
  assert.throws(() => createCodingAgentService({ agents, workspace: f.workspace, env: { ALA_BWRAP: bwrap },
    workspaceIdentity: '1:1' }), { exitCode: 5, message: /Bubblewrap with --bind-fd/u });
});

test('a live sandbox shows the pinned folder after a swap and inherits no descriptor', {
  skip: sandboxSupported && canBindDescriptors() ? false : 'Requires a Bubblewrap with --bind-fd on Linux'
}, async context => {
  const f = await swapFixture(context);
  const home = join(f.root, 'home');
  await mkdir(home);
  const contexts = [];
  const recorded = await identityOf(f.folder);
  const cwdRecorded = await identityOf(f.workspace);
  const service = createCodingAgentService({
    agents: [{ name: 'pi', available: true, binary: process.execPath }], workspace: f.workspace, cwd: f.workspace, home,
    folders: [{ source: f.folder, alias: 'runtime' }], folderIdentities: { [f.folder]: recorded }, workspaceIdentity: cwdRecorded,
    runners: { pi: async (input) => { contexts.push(input); return { outputText: 'done', continuation: null }; } }
  });
  context.after(() => service.close());
  await f.swapAbove();
  await service.execute('first');
  const [input] = contexts;
  const script = `
    const fs = require('node:fs');
    const out = { files: fs.readdirSync('/workspace/runtime') };
    const stat = fs.lstatSync('/workspace/runtime', { bigint: true });
    out.identity = stat.dev + ':' + stat.ino;
    try { fs.writeFileSync('/workspace/runtime/new', 'x'); out.write = 'allowed'; } catch { out.write = 'denied'; }
    fs.writeFileSync(${JSON.stringify(f.workspace)} + '/artifact', 'x');
    console.log(JSON.stringify(out));`;
  const result = await runProcess({ binary: process.execPath, args: ['-e', script], cwd: f.workspace, sandbox: input.sandbox });
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.files, ['granted.txt']);
  assert.equal(out.identity, recorded);
  assert.equal(out.write, 'denied');
  assert.equal(await readFile(join(f.workspace, 'artifact'), 'utf8'), 'x');
  // A shell holds only what it inherited: the standard streams and ls's own listing, never a pinned directory.
  const listed = await runProcess({ binary: '/bin/sh', args: ['-c', 'ls -l /proc/self/fd'], cwd: f.workspace, sandbox: input.sandbox });
  assert.equal(listed.code, 0, listed.stderr);
  const links = listed.stdout.split('\n').flatMap((line) => /\s(\d+) -> (.+)$/u.exec(line)?.slice(1) ? [/\s(\d+) -> (.+)$/u.exec(line).slice(1)] : []);
  assert.equal(links.length >= 3, true, listed.stdout);
  for (const [number, target] of links) {
    assert.equal(Number(number) <= 2 || /^\/proc\/\d+\/fd$/u.test(target), true, `Inherited descriptor: ${number} -> ${target}`);
  }
});
