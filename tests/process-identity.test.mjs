import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DARWIN_PID_MAX, PS_ENVIRONMENT, interpretPs, processIdentity } from '../src/process-identity.mjs';

function restoreEnvironment(t, names) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('the identity of a live process is stable across calls', async () => {
  const first = await processIdentity(process.pid);
  assert.ok(first.length > 0);
  assert.equal(await processIdentity(process.pid), first);
  if (process.platform === 'linux') assert.match(first, /^\d+$/u);
});

test('the identity does not depend on the caller time zone or locale', async (t) => {
  restoreEnvironment(t, ['TZ', 'LC_ALL', 'LC_TIME', 'LANG']);
  const baseline = await processIdentity(process.pid);
  const settings = [['Asia/Tokyo', 'C'], ['America/Los_Angeles', 'fr_FR.UTF-8'], ['Pacific/Kiritimati', '']];
  for (const [TZ, LC_ALL] of settings) {
    Object.assign(process.env, { TZ, LC_ALL, LC_TIME: LC_ALL, LANG: LC_ALL });
    assert.equal(await processIdentity(process.pid), baseline, `TZ=${TZ} LC_ALL=${LC_ALL}`);
  }
  // Also on a host whose own time zone is UTC: ps gets exactly this environment and nothing inherited.
  assert.deepEqual({ ...PS_ENVIRONMENT }, { TZ: 'UTC', LC_ALL: 'C' });
  if (process.platform === 'darwin') {
    const started = Date.parse(`${baseline} UTC`);
    const expected = Date.now() - process.uptime() * 1000;
    assert.ok(Math.abs(started - expected) < 3000, `${baseline} read as UTC is when this process started`);
  }
});

test('a live child has an identity and rejects with ENOENT once it has exited', async (t) => {
  const before = Date.now();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  const identity = await processIdentity(child.pid);
  if (process.platform === 'darwin') {
    // ps runs with TZ=UTC, so the start time read as UTC must be the moment the child started.
    const started = Date.parse(`${identity} UTC`);
    assert.ok(started >= Math.floor(before / 1000) * 1000 - 1000 && started <= Date.now() + 1000, identity);
  }
  child.kill('SIGKILL');
  await once(child, 'exit');
  await assert.rejects(processIdentity(child.pid), { code: 'ENOENT' });
});

test('a PID above every possible process rejects with ENOENT', async () => {
  await assert.rejects(processIdentity(2147483647), { code: 'ENOENT' });
  if (process.platform === 'darwin') await assert.rejects(processIdentity(DARWIN_PID_MAX + 1), { code: 'ENOENT' });
});

// The lock removes a holder's lock on ENOENT, so only ps's own "no such process" outcome may produce it.
test('only a silent ps exit 1 means no such process; every other outcome keeps the lock', () => {
  const failure = (fields) => interpretPs(42, fields).error;
  const noCode = [
    failure({ error: Object.assign(new Error('spawn /bin/ps ENOENT'), { code: 'ENOENT' }) }),
    failure({ error: Object.assign(new Error('spawn /bin/ps EPERM'), { code: 'EPERM' }) }),
    failure({ error: Object.assign(new Error('killed'), { code: null, signal: 'SIGTERM', killed: true }) }),
    failure({ error: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'ps: Invalid process id: 42\n' }),
    failure({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: 'unexpected' }),
    failure({ error: Object.assign(new Error('exit 1'), { code: 1, signal: 'SIGKILL' }) }),
    failure({ error: Object.assign(new Error('exit 2'), { code: 2 }) }),
    failure({ stdout: '  \n' })
  ];
  for (const error of noCode) {
    assert.ok(error instanceof Error);
    assert.equal(error.code, undefined, error.message);
  }
  const silent = failure({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: '', stderr: '' });
  assert.equal(silent.code, 'ENOENT');
  assert.deepEqual(interpretPs(42, { stdout: 'Wed Nov 11 13:46:04 2026    \n' }),
    { start: 'Wed Nov 11 13:46:04 2026' });
});

test('ps runs with exactly the fixed environment and a numeric PID', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, env: options.env });
    callback(null, 'Wed Nov 11 13:46:04 2026  \n', '');
  };
  assert.equal(await processIdentity(4242, { execFileImpl, platform: 'darwin' }), 'Wed Nov 11 13:46:04 2026');
  assert.deepEqual(calls,
    [{ file: '/bin/ps', args: ['-o', 'lstart=', '-p', '4242'], env: { TZ: 'UTC', LC_ALL: 'C' } }]);
  await assert.rejects(processIdentity(DARWIN_PID_MAX + 1, { execFileImpl, platform: 'darwin' }), { code: 'ENOENT' });
  await assert.rejects(processIdentity(-1, { execFileImpl, platform: 'darwin' }), (error) => error.code === undefined);
  assert.equal(calls.length, 1, 'neither an impossible nor an invalid PID reaches ps');
});

test('macOS ps still refuses PIDs above the limit and is silent for a free PID below it', {
  skip: process.platform === 'darwin' ? false : 'macOS ps only'
}, () => {
  const ps = (pid) => spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8',
    env: { ...PS_ENVIRONMENT } });
  const above = ps(DARWIN_PID_MAX + 1);
  assert.deepEqual([above.status, above.stdout], [1, '']);
  assert.match(above.stderr, /process id too large/u);
  const inUse = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  let free = DARWIN_PID_MAX;
  while (inUse(free)) free -= 1;
  const silent = ps(free);
  assert.deepEqual([silent.status, silent.stdout, silent.stderr], [1, '', ''], `PID ${free}`);
});
