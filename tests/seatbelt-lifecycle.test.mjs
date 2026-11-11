import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { buildSeatbeltProfile } from '../src/coding-agents/seatbelt-profile.mjs';
import { seatbeltSystemRoots } from '../src/coding-agents/seatbelt-roots.mjs';
import { createPrivateFolders, GROUP_KILL_DELAY_MS } from '../src/coding-agents/seatbelt.mjs';
import {
  alive, execute, fixture, hostPerl, run, sandboxPerl, service, skip, sleep, until
} from './seatbelt-fixture.mjs';

// Private folders, the stale sweep, the supervisor and process-group signals on macOS. Fake processes only.
const SUPERVISOR = fileURLToPath(new URL('../src/coding-agents/seatbelt-supervisor.mjs', import.meta.url));
const EPERM = 'ERR Operation not permitted';

function supervise(command, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SUPERVISOR, '3', command, ...args],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'], detached: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stderr: stderr.trim() }));
  });
}

test('cleanup survives an unremovable folder and a failing command, and the result is still delivered', { skip },
  async (t) => {
    const f = fixture(t);
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning.message);
    process.on('warning', onWarning);
    t.after(() => process.off('warning', onWarning));
    const instance = service(f);
    const result = await execute(instance, '/bin/sh', ['-c',
      'echo "$TMPDIR"; mkdir "$TMPDIR/d" "$HOME/d"; : > "$TMPDIR/d/f"; : > "$HOME/d/f"; '
      + 'chmod 555 "$TMPDIR/d" "$HOME/d"; chmod 000 "$HOME"; exit 3']);
    assert.equal(result.code, 3, result.stderr);
    const temp = result.stdout.trim();
    assert.equal(fs.existsSync(path.dirname(temp)), false, 'the private folder is removed when the process closes');
    const base = path.dirname(path.dirname(temp));
    await instance.close();
    assert.equal(fs.existsSync(base), false);
    assert.deepEqual(warnings, []);
  });

test('the stale sweep removes only dead owners\' folders, never through a link', { skip }, async (t) => {
  const f = fixture(t);
  const temporaryRoot = path.join(f.root, 'T');
  fs.mkdirSync(temporaryRoot);
  const dead = spawnSync('/usr/bin/true').pid;
  const stale = path.join(temporaryRoot, `ala-seatbelt-${dead}-abcdef`);
  fs.mkdirSync(path.join(stale, 'p-x', 'home', 'locked'), { recursive: true });
  // A 0500 directory outside, reachable only through a planted link: the sweep must change neither its mode nor
  // its contents while it repairs and removes the stale folder.
  const victim = path.join(f.outside, 'victim0500');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep'), 'k');
  fs.chmodSync(victim, 0o500);
  fs.symlinkSync(victim, path.join(stale, 'p-x', 'home', 'link'));
  fs.writeFileSync(path.join(stale, 'p-x', 'home', 'locked', 'f'), 'x');
  fs.chmodSync(path.join(stale, 'p-x', 'home', 'locked'), 0o555);
  const linked = path.join(temporaryRoot, `ala-seatbelt-${dead}-symlnk`);
  fs.symlinkSync(f.outside, linked);
  const live = path.join(temporaryRoot, `ala-seatbelt-${process.ppid}-livexx`);
  const unrelated = path.join(temporaryRoot, `ala-seatbelt-${dead}-toolong7`);
  for (const directory of [live, unrelated]) fs.mkdirSync(directory);
  const pool = createPrivateFolders({ temporaryRoot });
  pool.allocate();
  const own = path.basename(pool.base);
  assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), [path.basename(linked), path.basename(live), own,
    path.basename(unrelated)].sort());
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(fs.readdirSync(f.outside).sort(), ['victim.txt', 'victim0500']);
  assert.equal(fs.statSync(victim).mode & 0o777, 0o500);
  assert.deepEqual(fs.readdirSync(victim), ['keep']);
  pool.close();
  pool.close();
  assert.equal(fs.existsSync(path.join(temporaryRoot, own)), false);
});

test('the supervisor reports each way the command ends, and a command that cannot start', { skip }, async (t) => {
  const cases = [['exit 3', { code: 3, signal: null }], ['kill -TERM $$', { code: null, signal: 'SIGTERM' }],
    ['kill -KILL $$', { code: null, signal: 'SIGKILL' }], ['kill -USR2 $$', { code: null, signal: 'SIGUSR2' }],
    ['kill -SEGV $$', { code: null, signal: 'SIGSEGV' }], ['kill -PIPE $$', { code: 141, signal: null }],
    ['kill -XFSZ $$', { code: 153, signal: null }], ['kill -USR1 $$', { code: 158, signal: null }]];
  for (const [script, expected] of cases) {
    const { code, signal } = await supervise('/bin/sh', ['-c', script]);
    assert.deepEqual({ code, signal }, expected, script);
  }
  assert.deepEqual(await supervise('/nonexistent/agent', []), { code: 127, signal: null,
    stderr: 'ALA Seatbelt supervisor could not start /nonexistent/agent: ENOENT' });
  const f = fixture(t);
  const garbage = path.join(f.root, 'not-a-program');
  fs.writeFileSync(garbage, 'not a program\n', { mode: 0o755 });
  assert.deepEqual(await supervise(garbage, []), { code: 126, signal: null,
    stderr: `ALA Seatbelt supervisor could not start ${garbage}: ENOEXEC` });
});

test('the command does not inherit the supervisor watch descriptor', { skip }, async (t) => {
  const f = fixture(t);
  const check = '(: <&3) 2>/dev/null && echo open || echo closed';
  const result = await run(f, '/bin/sh', ['-c', `${check}; exec 3</dev/null; ${check}`]);
  // The second check is the positive control: the same test sees a descriptor 3 that is open.
  assert.equal(result.stdout, 'closed\nopen\n', result.stderr);
});

test('a SIGTERM reaches the whole group at once and a group that ignores it is killed shortly after', { skip },
  async (t) => {
    const f = fixture(t);
    let child;
    const instance = createCodingAgentService({ agents: [{ name: 'codex', available: true, binary: '/bin/sh' }],
      workspace: f.work, env: f.env, runners: { codex: async (input) => {
        child = spawnProcess({ binary: '/bin/sh', cwd: input.workspace, env: input.env, sandbox: input.sandbox,
          stdio: ['ignore', 'ignore', 'ignore'],
          // The grandchild starts before the trap, so it keeps the default SIGTERM action.
          args: ['-c', '/bin/sleep 300 & echo $! > g.pid; trap "" TERM; echo $$ > s.pid; wait; '
            + 'while :; do /bin/sleep 1; done'] });
        await once(child, 'close');
        return { outputText: '', continuation: null };
      } } });
    t.after(() => instance.close());
    const done = instance.execute('x');
    done.catch(() => {});
    const read = (name) => Number(fs.readFileSync(path.join(f.work, name), 'utf8'));
    assert.ok(await until(() => ['g.pid', 's.pid'].every((name) => fs.existsSync(path.join(f.work, name))
      && read(name))));
    const [grandchild, shell] = [read('g.pid'), read('s.pid')];
    t.after(() => { for (const pid of [grandchild, shell]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
    const started = Date.now();
    child.kill('SIGTERM');
    assert.ok(await until(() => !alive(grandchild), 1000), 'the group signal reached the grandchild at once');
    assert.equal(alive(shell), true, 'the shell ignores SIGTERM');
    assert.ok(await until(() => !alive(shell), GROUP_KILL_DELAY_MS + 2000), 'the group was killed after the delay');
    assert.ok(Date.now() - started >= GROUP_KILL_DELAY_MS - 100);
    await done;
  });

test('processes outside, even in a second sandbox with an identical profile, cannot be signalled', { skip },
  async (t) => {
    const f = fixture(t);
    const built = buildSeatbeltProfile({ systemRoots: seatbeltSystemRoots(), home: f.home, temp: f.state,
      mounts: [{ source: f.work, writable: true }] });
    const sandboxed = (args, stdio = 'ignore') => spawn('/usr/bin/sandbox-exec', ['-p', built.profile,
      ...built.params.flatMap((value) => ['-D', value]), ...args], { stdio, env: { PATH: '/usr/bin:/bin' } });
    const outside = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const twin = sandboxed(['/bin/sleep', '30']);
    t.after(() => { outside.kill('SIGKILL'); twin.kill('SIGKILL'); });
    await Promise.all([once(outside, 'spawn'), once(twin, 'spawn')]);
    assert.equal(hostPerl('print t(kill("CONT", $ARGV[0]));', [String(outside.pid)]), 'ok', 'host control');
    // SIGCONT is harmless if it were delivered, so a failure of this test cannot stop the test runner itself.
    const attacker = sandboxed(['/usr/bin/perl', '-e',
      'print join(" ", map { kill("CONT", $_) ? "ok" : "ERR $!" } @ARGV)',
      String(outside.pid), String(twin.pid), String(process.pid)], ['ignore', 'pipe', 'inherit']);
    let out = '';
    attacker.stdout.on('data', (chunk) => { out += chunk; });
    await once(attacker, 'close');
    assert.equal(out, `${EPERM} ${EPERM} ${EPERM}`);
    assert.equal(alive(outside.pid) && alive(twin.pid), true);
  });

test('a set-id program cannot be executed', { skip }, async (t) => {
  const f = fixture(t);
  assert.equal(spawnSync('/bin/ps', ['-p', String(process.pid)], { stdio: 'ignore' }).status, 0, 'host control');
  const result = await run(f, '/bin/sh', ['-c', '/bin/ps -p $$ >/dev/null 2>&1; echo ps=$?']);
  // 126 only: the exec itself is refused. Exit 1 would mean ps ran and merely failed to read the process list.
  assert.equal(result.stdout, 'ps=126\n');
});

test('a unix socket inside a masked folder is unreachable even under the workspace', { skip }, async (t) => {
  // A socket path holds at most 104 bytes, so this fixture lives directly under /tmp.
  const f = fixture(t, '/tmp');
  const secret = path.join(f.work, 's');
  fs.mkdirSync(secret);
  const socket = path.join(secret, 'k');
  const server = net.createServer((connection) => connection.end()).listen(socket);
  t.after(() => server.close());
  await once(server, 'listening');
  assert.equal(hostPerl('use Socket; socket(S, PF_UNIX, SOCK_STREAM, 0); print t(connect(S, sockaddr_un($ARGV[0])));',
    [socket]), 'ok', 'host control');
  const out = await sandboxPerl(f, 'use Socket; socket(S, PF_UNIX, SOCK_STREAM, 0); '
    + 'print t(connect(S, sockaddr_un($ARGV[0])));', [socket], { ignoredPaths: [secret] });
  assert.equal(out, EPERM);
  const open = await sandboxPerl(f, 'use Socket; socket(S, PF_UNIX, SOCK_STREAM, 0); '
    + 'print t(connect(S, sockaddr_un($ARGV[0])));', [socket]);
  assert.equal(open, 'ok', 'positive control: unmasked, the same socket under the workspace is reachable');
});

test('a workspace with a path of about a thousand characters works and stays confined', { skip }, async (t) => {
  const f = fixture(t);
  let deep = f.root;
  while (deep.length < 950) deep = path.join(deep, 'x'.repeat(Math.min(200, 960 - deep.length)));
  fs.mkdirSync(deep, { recursive: true });
  const result = await run({ ...f, work: deep }, '/bin/sh', ['-c',
    `: > made && echo made; /bin/cat "${f.outside}/victim.txt" >/dev/null 2>&1; echo hidden=$?`]);
  assert.equal(result.stdout, 'made\nhidden=1\n', result.stderr);
  assert.ok(deep.length >= 950 && fs.existsSync(path.join(deep, 'made')));
  await sleep(0);
});

test('signal 0 probes the group without scheduling the delayed group kill', { skip }, async (t) => {
  const f = fixture(t);
  let child;
  const instance = createCodingAgentService({ agents: [{ name: 'codex', available: true, binary: '/bin/sh' }],
    workspace: f.work, env: f.env, runners: { codex: async (input) => {
      child = spawnProcess({ binary: '/bin/sh', cwd: input.workspace, env: input.env, sandbox: input.sandbox,
        stdio: ['ignore', 'ignore', 'ignore'], args: ['-c', 'echo $$ > s.pid; /bin/sleep 300'] });
      await once(child, 'close');
      return { outputText: '', continuation: null };
    } } });
  t.after(() => instance.close());
  const done = instance.execute('x');
  done.catch(() => {});
  const pidFile = path.join(f.work, 's.pid');
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()));
  const shell = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(shell, 'SIGKILL'); } catch {} });
  assert.equal(child.kill(0), true);
  await sleep(GROUP_KILL_DELAY_MS + 500);
  assert.equal(alive(shell), true, 'a probe must not end the group');
  child.kill('SIGKILL');
  await done;
});

test('at exit, a folder the confined helper cannot remove is left and reported synchronously', { skip },
  async (t) => {
    const f = fixture(t);
    const module = new URL('../src/coding-agents/seatbelt.mjs', import.meta.url).href;
    const script = `const { createPrivateFolders } = await import(${JSON.stringify(module)});
      const fs = await import('node:fs');
      const { folder } = createPrivateFolders({ temporaryRoot: ${JSON.stringify(f.root)} }).allocate();
      fs.mkdirSync(folder + '/locked/inner', { recursive: true });
      fs.writeFileSync(folder + '/locked/inner/f', 'x');
      fs.chmodSync(folder + '/locked', 0);`;
    // Inside another sandbox the confined helper cannot start, so nothing may repair the folder unconfined.
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', process.execPath,
      '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr,
      /^Warning: ALA could not remove the Seatbelt private folder .+; a later run tries again\.$/mu);
    const left = fs.readdirSync(f.root).filter((name) => name.startsWith('ala-seatbelt-'));
    assert.equal(left.length, 1);
    assert.equal(fs.statSync(path.join(f.root, left[0])).isDirectory(), true);
  });
