import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { canStartSeatbelt, findSeatbelt, seatbeltProbeFailure } from '../src/coding-agents/seatbelt.mjs';

// Live confinement on macOS. Every process here is a shell, perl, python or Node fixture; no coding agent runs.
// An escape attempt counts as refused only when a host-side control or a positive marker shows it was able to work.
const skip = process.platform === 'darwin' ? false : 'Seatbelt is macOS-only';
const NODE = process.execPath;
const REAL_HOME = os.userInfo().homedir;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework'
  + '/Support/lsregister';
const READER = 'sub rd { my $mib = pack("i3", 1, 49, shift); my $buf = "\\0" x 262144; my $len = pack("Q", 262144); '
  + 'return "DENIED" if syscall(202, $mib, 3, $buf, $len, 0, 0) != 0; '
  + 'return index($buf, "ALA_CANARY=") >= 0 ? "READABLE canary" : "READABLE"; } '
  + 'print join(" ", map { rd($_) } @ARGV), "\\n";';
const source = (name) => new URL(`../src/coding-agents/${name}`, import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return true;
  return check();
}

async function fixture(t, name = 'w') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ala-sb-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, work: path.join(root, name), folder: path.join(root, 'ro'), home: path.join(root, 'home'),
    outside: path.join(root, 'o'), state: path.join(root, 'state') };
  for (const directory of [f.work, f.folder, f.home, f.outside, f.state]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(f.folder, 'r.txt'), 'read-only');
  fs.writeFileSync(path.join(f.outside, 'h.txt'), 'hidden');
  fs.copyFileSync('/usr/bin/true', path.join(f.outside, 'true'));
  fs.writeFileSync(path.join(f.state, 'auth.json'), '{}');
  f.env = { HOME: f.home, CODEX_HOME: f.state, PATH: '/usr/bin:/bin', LANG: 'C', ALA_TEST_SECRET: 'must-not-pass' };
  return f;
}

// A service whose injected runner starts { binary, args } through the real sandboxed runProcess.
function service(f, options = {}) {
  return createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/bin/sh' }], workspace: f.work, cwd: f.work, env: f.env,
    folders: [{ source: f.folder }], ...options,
    runners: { codex: async (input) => {
      const { binary, args } = JSON.parse(input.prompt);
      const result = await runProcess({ binary, args, cwd: input.workspace, env: input.env, sandbox: input.sandbox,
        signal: input.signal });
      return { outputText: JSON.stringify(result), continuation: null };
    } }
  });
}

async function run(f, binary, args, options = {}) {
  const instance = service(f, options);
  try { return JSON.parse(await instance.execute(JSON.stringify({ binary, args }), { signal: options.signal })); }
  finally { await instance.close(); }
}

// Runs Node code inside; t(name, fn) records a value or the error code.
async function node(f, body, options) {
  const code = `const fs = require('fs'), net = require('net'), out = {};
    const t = (n, f) => { try { out[n] = f(); } catch (e) { out[n] = 'ERR ' + (e.code || e.message); } };
    (async () => { ${body} })().then(() => console.log(JSON.stringify(out)));`;
  const result = await run(f, NODE, ['-e', code], options);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the workspace is writable, a folder read-only, and everything else unreadable', { skip }, async (t) => {
  const f = await fixture(t);
  const out = await node(f, `
    t('write', () => { fs.writeFileSync('${f.work}/w.txt', 'x'); return 'ok'; });
    t('read', () => fs.readFileSync('${f.folder}/r.txt', 'utf8'));
    t('folderWrite', () => fs.writeFileSync('${f.folder}/r.txt', 'x'));
    t('folderCreate', () => fs.writeFileSync('${f.folder}/new', 'x'));
    t('hiddenRead', () => fs.readFileSync('${f.outside}/h.txt', 'utf8'));
    t('hiddenList', () => fs.readdirSync('${f.outside}'));
    t('hiddenStat', () => fs.statSync('${f.outside}/h.txt').size);
    t('realHome', () => fs.readdirSync('${REAL_HOME}'));
    t('tmp', () => fs.writeFileSync('/tmp/ala-sb-${process.pid}', 'x'));
    t('privateTmp', () => fs.writeFileSync('/private/tmp/ala-sb-${process.pid}', 'x'));
    t('firmlink', () => fs.readFileSync('/System/Volumes/Data${f.outside}/h.txt', 'utf8'));
    t('hiddenExec', () => require('child_process').spawnSync('${f.outside}/true').error?.code);
    t('existsHidden', () => fs.existsSync('${f.outside}/h.txt'));
    t('existsMissing', () => fs.existsSync('${f.outside}/missing'));`);
  assert.deepEqual(out, { write: 'ok', read: 'read-only', folderWrite: 'ERR EPERM', folderCreate: 'ERR EPERM',
    hiddenRead: 'ERR EPERM', hiddenList: 'ERR EPERM', hiddenStat: 'ERR EPERM', realHome: 'ERR EPERM',
    tmp: 'ERR EPERM', privateTmp: 'ERR EPERM', firmlink: 'ERR EPERM', hiddenExec: 'EPERM',
    // Known residual: existence of a hidden path is observable, its content and size are not.
    existsHidden: true, existsMissing: false });
  assert.equal(fs.readFileSync(path.join(f.work, 'w.txt'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(f.folder, 'r.txt'), 'utf8'), 'read-only');
});

test('the environment is the allowlist with a private HOME and TMPDIR', { skip }, async (t) => {
  const f = await fixture(t);
  const out = await node(f, `
    out.env = process.env;
    t('homeWrite', () => { fs.writeFileSync(process.env.HOME + '/h', 'x'); return 'ok'; });
    t('tmpWrite', () => { fs.writeFileSync(process.env.TMPDIR + '/t', 'x'); return 'ok'; });
    t('codex', () => fs.readdirSync(process.env.CODEX_HOME).sort());`);
  const base = fs.realpathSync(os.tmpdir());
  assert.equal(out.env.ALA_TEST_SECRET, undefined);
  assert.equal(out.env.LANG, 'C');
  for (const name of ['HOME', 'TMPDIR']) {
    assert.match(out.env[name], new RegExp(`^${base}/ala-seatbelt-${process.pid}-\\w{6}/p-\\w{6}/`, 'u'), name);
  }
  assert.equal(out.env.CODEX_HOME, `${out.env.HOME}/.codex`);
  assert.deepEqual([out.env.USER, out.env.LOGNAME, out.homeWrite, out.tmpWrite], ['ala', 'ala', 'ok', 'ok']);
  assert.deepEqual(out.codex, ['auth.json']);
  assert.equal(fs.existsSync(out.env.HOME), false, 'the private folders are removed when the process closes');
});

test('state is linked read-write, survives cleanup, and a missing state folder is not linked', { skip }, async (t) => {
  const f = await fixture(t);
  const out = await node(f, `
    t('create', () => { fs.writeFileSync(process.env.CODEX_HOME + '/session.json', '1'); return 'ok'; });
    t('link', () => fs.readlinkSync(process.env.HOME + '/.codex'));`);
  assert.deepEqual(out, { create: 'ok', link: f.state });
  assert.deepEqual(fs.readdirSync(f.state).sort(), ['auth.json', 'session.json']);
  const missing = await node({ ...f, env: { ...f.env, CODEX_HOME: path.join(f.root, 'absent') } },
    "t('link', () => fs.readdirSync(process.env.HOME));");
  assert.deepEqual(missing, { link: [] });
});

test('an explicit home is the writable HOME, its state stays in place, TMPDIR stays private', { skip }, async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, 'explicit');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const out = await node(f, `
    out.env = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, TMPDIR: process.env.TMPDIR };
    t('state', () => { fs.writeFileSync(process.env.CODEX_HOME + '/s', 'x'); return 'ok'; });
    t('privateHome', () => fs.existsSync(require('path').dirname(process.env.TMPDIR) + '/home'));`,
  { home, env: { ...f.env, CODEX_HOME: path.join(home, '.codex') } });
  assert.deepEqual({ ...out.env, TMPDIR: path.basename(out.env.TMPDIR) },
    { HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: 'tmp' });
  assert.deepEqual([out.state, out.privateHome], ['ok', false]);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 's'), 'utf8'), 'x');
});

test('masks hold in read-only and writable trees against renames, links, case and Unicode', { skip }, async (t) => {
  const f = await fixture(t);
  for (const file of ['w/a/b/Secret/k.txt', 'w/a/b/café/k.txt', 'ro/c/d/mask/k.txt']) {
    fs.mkdirSync(path.join(f.root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(f.root, file), 'masked');
  }
  const masks = ['w/a/b/Secret', 'w/a/b/café', 'ro/c/d/mask'].map((entry) => path.join(f.root, entry));
  const out = await node(f, `
    t('writable', () => fs.readFileSync('${f.work}/a/b/Secret/k.txt', 'utf8'));
    t('readOnly', () => fs.readFileSync('${f.folder}/c/d/mask/k.txt', 'utf8'));
    t('caseVariant', () => fs.readFileSync('${f.work}/A/B/sECRET/K.TXT', 'utf8'));
    t('nfd', () => fs.readFileSync('${f.work}/a/b/cafe\\u0301/k.txt', 'utf8'));
    t('renameParent', () => fs.renameSync('${f.work}/a', '${f.work}/z'));
    t('renameMiddle', () => fs.renameSync('${f.work}/a/b', '${f.work}/a/y'));
    t('renameMask', () => fs.renameSync('${f.work}/a/b/Secret', '${f.work}/s'));
    t('hardLink', () => fs.linkSync('${f.folder}/r.txt', '${f.work}/link'));
    t('createBesideMask', () => { fs.writeFileSync('${f.work}/a/b/new', 'x'); return 'ok'; });`,
  { ignoredPaths: masks });
  assert.deepEqual(out, { writable: 'ERR EPERM', readOnly: 'ERR EPERM', caseVariant: 'ERR EPERM', nfd: 'ERR EPERM',
    renameParent: 'ERR EPERM', renameMiddle: 'ERR EPERM', renameMask: 'ERR EPERM', hardLink: 'ERR EPERM',
    createBesideMask: 'ok' });
  await assert.rejects(run(f, '/bin/sh', ['-c', 'true'], { ignoredPaths: [path.join(f.outside, 'h.txt')] }),
    { message: '--ignore path is not exposed by a sandbox mount.' });
});

test('a unix socket outside the mounts is refused while loopback TCP works', { skip }, async (t) => {
  const f = await fixture(t);
  const socket = path.join(f.outside, 's');
  const unix = net.createServer((connection) => connection.end()).listen(socket);
  const tcp = net.createServer((connection) => connection.end('pong')).listen(0, '127.0.0.1');
  t.after(() => { unix.close(); tcp.close(); });
  await Promise.all([once(unix, 'listening'), once(tcp, 'listening')]);
  const connect = (target) => new Promise((resolve) => {
    const client = net.connect(target, () => { client.destroy(); resolve('connected'); });
    client.on('error', (error) => resolve(`ERR ${error.code}`));
  });
  assert.equal(await connect(socket), 'connected', 'host control');
  const sockets = [socket, ...(process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [])];
  for (const target of sockets) assert.equal(await connect(target), 'connected', `host control ${target}`);
  const out = await node(f, `
    const connect = (target) => new Promise((resolve) => { const c = net.connect(target, () => { c.destroy();
      resolve('connected'); }); c.on('error', (e) => resolve('ERR ' + e.code)); });
    out.unix = await Promise.all(${JSON.stringify(sockets)}.map(connect));
    out.tcp = await new Promise((resolve) => { const c = net.connect(${tcp.address().port}, '127.0.0.1');
      let data = ''; c.on('data', (d) => { data += d; }); c.on('end', () => resolve(data));
      c.on('error', (e) => resolve('ERR ' + e.code)); });`);
  assert.deepEqual(out, { unix: sockets.map(() => 'ERR EPERM'), tcp: 'pong' });
});

test('another process environment is unreadable while the reader reads its own arguments', { skip }, async (t) => {
  const f = await fixture(t);
  // A Node target: an Apple platform binary's environment is not returned even outside a sandbox.
  const outside = spawn(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { env: { ALA_CANARY: randomUUID() },
    stdio: 'ignore' });
  t.after(() => outside.kill('SIGKILL'));
  await once(outside, 'spawn');
  const host = spawnSync('/usr/bin/perl', ['-e', READER, String(outside.pid)], { encoding: 'utf8' });
  assert.equal(host.stdout.trim(), 'READABLE canary', 'host control: the reader sees the canary outside');
  const result = await run(f, '/usr/bin/perl', ['-e', READER.replace('@ARGV', () => '(@ARGV, $$)'), String(outside.pid),
    String(process.pid)]);
  // Outside process, ALA itself, then the reader's own arguments (which hold the reader text).
  assert.match(result.stdout.trim(), /^DENIED DENIED READABLE( canary)?$/u, result.stderr);
});

test('the start probe fails when the profile lacks either rule of the environment pair', { skip }, () => {
  const launcher = findSeatbelt();
  assert.equal(canStartSeatbelt(launcher), true, JSON.stringify(seatbeltProbeFailure(launcher)));
  let tick = Date.now();
  for (const rule of ['(deny process-info*)\n', '(deny sysctl-read (sysctl-name-regex #"^kern\\.proc"))\n']) {
    const profile = (text) => {
      assert.ok(text.includes(rule), rule);
      return text.replace(rule, '');
    };
    tick += 3_600_000;
    assert.equal(canStartSeatbelt(launcher, { profile, now: () => tick }), false, rule);
    assert.equal(seatbeltProbeFailure(launcher).leaked, true, rule);
  }
  tick += 3_600_000;
  assert.equal(canStartSeatbelt(launcher, { now: () => tick }), true);
});

test('abort kills a grandchild, and SIGKILL of ALA kills the group within five seconds', { skip }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = run(f, '/bin/sh', ['-c', `/bin/sleep 300 & echo $! > ${f.work}/g.pid; wait`],
    { signal: controller.signal });
  const pidFile = path.join(f.work, 'g.pid');
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch {} });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(await until(() => !alive(grandchild)), 'the grandchild survived abort');

  const script = path.join(f.root, 'parent.mjs');
  fs.writeFileSync(script, `
    const { createCodingAgentService } = await import(${JSON.stringify(source('service.mjs'))});
    const { runProcess } = await import(${JSON.stringify(source('process.mjs'))});
    const s = createCodingAgentService({ agents: [{ name: 'codex', available: true, binary: '/bin/sh' }],
      workspace: ${JSON.stringify(f.work)}, env: ${JSON.stringify(f.env)},
      runners: { codex: (input) => runProcess({ binary: '/bin/sh', args: ['-c', input.prompt], cwd: input.workspace,
        env: input.env, sandbox: input.sandbox }) } });
    await s.execute('/bin/sleep 300 & echo $! > g2.pid; echo $$ > s2.pid; /bin/sleep 300');`);
  // The killed parent cannot remove its private folders, so they are placed inside this fixture.
  const parent = spawn(NODE, [script], { stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', HOME: f.home, TMPDIR: f.root } });
  t.after(() => parent.kill('SIGKILL'));
  const files = ['g2.pid', 's2.pid'].map((name) => path.join(f.work, name));
  const written = (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim();
  assert.ok(await until(() => files.every(written), 15000));
  const pids = files.map((file) => Number(fs.readFileSync(file, 'utf8')));
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  assert.ok(pids.every(alive));
  parent.kill('SIGKILL');
  assert.ok(await until(() => pids.every((pid) => !alive(pid)), 5000), 'the group survived SIGKILL of ALA');
});

test('a descendant that calls setsid survives the group kill but still cannot write outside', { skip }, async (t) => {
  const f = await fixture(t);
  const perl = `use POSIX; exit 0 if fork(); POSIX::setsid(); open(STDIN, "</dev/null"); open(STDOUT, ">/dev/null");
    open(STDERR, ">/dev/null"); open(my $p, ">", "${f.work}/s.pid"); print $p "$$"; close($p); sleep 1;
    my $r = open(my $o, ">", "${f.outside}/escaped") ? "WROTE" : "refused $!";
    open(my $w, ">", "${f.work}/s.result"); print $w $r; close($w); sleep 30;`;
  const result = await run(f, '/usr/bin/perl', ['-e', perl]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(await until(() => fs.existsSync(path.join(f.work, 's.result'))));
  const survivor = Number(fs.readFileSync(path.join(f.work, 's.pid'), 'utf8'));
  t.after(() => { try { process.kill(survivor, 'SIGKILL'); } catch {} });
  assert.equal(alive(survivor), true, 'expected residual: a new session leaves the group');
  assert.match(fs.readFileSync(path.join(f.work, 's.result'), 'utf8'), /^refused Operation not permitted/u);
  assert.equal(fs.existsSync(path.join(f.outside, 'escaped')), false);
});

test('a granted directory that changed identity exits 78 before the next spawn', { skip }, async (t) => {
  const f = await fixture(t);
  const instance = service(f);
  t.after(() => instance.close());
  const call = JSON.stringify({ binary: '/bin/sh', args: ['-c', 'true'] });
  assert.equal(JSON.parse(await instance.execute(call)).code, 0);
  fs.renameSync(f.folder, `${f.folder}-old`);
  fs.mkdirSync(f.folder);
  await assert.rejects(instance.execute(call),
    { exitCode: 78, message: `A granted directory changed or is unavailable: ${f.folder}` });
});

test('spawns get distinct private folders, eight run in parallel, and close is idempotent', { skip }, async (t) => {
  const f = await fixture(t, 'ws "q" (p);ü 日');
  const instance = createCodingAgentService({ agents: [{ name: 'codex', available: true, binary: '/bin/sh' }],
    workspace: f.work, env: f.env, runners: { codex: async (input) => {
      const one = (index) => runProcess({ binary: '/bin/sh', args: ['-c', `echo $HOME; : > "out-${index}"`],
        cwd: input.workspace, env: input.env, sandbox: input.sandbox });
      return { outputText: JSON.stringify(await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(one))), continuation: null };
    } } });
  const results = JSON.parse(await instance.execute('x'));
  const homes = results.map((result) => result.stdout.trim());
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(new Set(homes).size, 8);
  assert.ok(homes.every((home) => !fs.existsSync(home)));
  assert.equal(fs.readdirSync(f.work).filter((name) => name.startsWith('out-')).length, 8);
  const base = path.dirname(path.dirname(homes[0]));
  assert.equal(fs.existsSync(base), true);
  await instance.close();
  await instance.close();
  assert.equal(fs.existsSync(base), false);
  const out = await node(f, `t('hidden', () => fs.readFileSync('${f.outside}/h.txt', 'utf8'));`);
  assert.deepEqual(out, { hidden: 'ERR EPERM' });
});

test('only a terminal allocated inside opens; another session terminal is refused', { skip }, async (t) => {
  const f = await fixture(t);
  const holder = spawn('/usr/bin/python3', ['-c', `import os, sys, time
m, s = os.openpty(); st = os.fstat(s); print("/dev/ttys%03d" % os.minor(st.st_rdev), flush=True); time.sleep(60)`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  const [line] = await once(holder.stdout, 'data');
  const foreign = String(line).trim();
  assert.match(foreign, /^\/dev\/ttys\d+$/u);
  fs.closeSync(fs.openSync(foreign, fs.constants.O_RDWR | fs.constants.O_NOCTTY));
  const result = await run(f, '/usr/bin/python3', ['-c', `import os
def attempt(path):
    try: os.close(os.open(path, os.O_RDWR | os.O_NOCTTY)); return "opened"
    except OSError as e: return "refused %d" % e.errno
m, s = os.openpty(); own = "/dev/ttys%03d" % os.minor(os.fstat(s).st_rdev)
print(attempt("${foreign}"), attempt(own))`]);
  assert.equal(result.stdout.trim(), 'refused 1 opened', result.stderr);
});

function markerApp(directory, id, marker) {
  const app = path.join(directory, `${id}.app`);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>marker</string><key>CFBundleIdentifier</key>
<string>com.ala.test.${id}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/>
</dict></plist>\n`);
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'marker'), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`,
    { mode: 0o755 });
  return app;
}

test('escape attempts are refused: Keychain, SSH folder, Keychain files, nested sandbox, open and osascript', {
  skip
}, async (t) => {
  const f = await fixture(t);
  const id = `seatbelt-${randomUUID().slice(0, 8)}`;
  const apps = [];
  t.after(() => {
    for (const app of apps) {
      spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
      spawnSync('/usr/bin/pkill', ['-f', app], { stdio: 'ignore' });
    }
  });
  // Host controls: each attempt works when it is not confined. Keychain output is discarded; only the status counts.
  assert.equal(spawnSync('/usr/bin/security', ['find-generic-password'], { stdio: 'ignore' }).status, 0,
    'host control: no Keychain item is available for the attributes-only lookup');
  assert.equal(spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status, 0);
  for (const target of [path.join(REAL_HOME, '.ssh'), path.join(REAL_HOME, 'Library', 'Keychains')]) {
    assert.ok(fs.statSync(target).isDirectory(), `host control: ${target}`);
  }
  const control = markerApp(f.root, `${id}-control`, path.join(f.outside, 'control'));
  apps.push(control);
  spawnSync('/usr/bin/open', ['-g', '-n', control], { stdio: 'ignore' });
  assert.ok(await until(() => fs.existsSync(path.join(f.outside, 'control')), 10000), 'host control: open ran the app');
  spawnSync(LSREGISTER, ['-u', control], { stdio: 'ignore' });

  const openApp = markerApp(f.work, `${id}-open`, path.join(f.outside, 'open'));
  const scriptApp = markerApp(f.work, `${id}-osascript`, path.join(f.outside, 'osascript'));
  apps.push(openApp, scriptApp);
  const script = `: > ${f.work}/ran
/usr/bin/security find-generic-password >/dev/null 2>&1; echo "keychain=$?"
/bin/ls ${REAL_HOME}/.ssh >/dev/null 2>"${f.work}/e1"; echo "ssh=$?"; /bin/cat "${f.work}/e1"
/bin/ls ${REAL_HOME}/Library/Keychains >/dev/null 2>"${f.work}/e2"; echo "keychains=$?"; /bin/cat "${f.work}/e2"
/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>"${f.work}/e3"
echo "nested=$?"; /bin/cat "${f.work}/e3"
/usr/bin/open -g -n '${openApp}' >/dev/null 2>&1; echo "open=$?"
/usr/bin/osascript -e 'tell application "${scriptApp}" to launch' >/dev/null 2>&1; echo "osascript=$?"`;
  const result = await run(f, '/bin/sh', ['-c', script]);
  await sleep(4000);
  const escaped = ['open', 'osascript'].filter((name) => fs.existsSync(path.join(f.outside, name)));
  assert.deepEqual(escaped, [], 'an application started outside the sandbox');
  assert.equal(fs.existsSync(path.join(f.work, 'ran')), true, 'positive control: the sandboxed script ran');
  const lines = result.stdout;
  assert.doesNotMatch(lines, /keychain=0\b/u);
  assert.match(lines, /ssh=1\n.*Operation not permitted/u);
  assert.match(lines, /keychains=1\n.*Operation not permitted/u);
  assert.match(lines, /nested=71\n.*sandbox_apply: Operation not permitted/u);
});
