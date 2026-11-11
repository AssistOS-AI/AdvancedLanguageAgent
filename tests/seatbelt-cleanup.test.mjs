import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CLEANUP_PROFILE, createPrivateFolders, removePrivateFolder } from '../src/coding-agents/seatbelt.mjs';
import { fixture, skip, sleep } from './seatbelt-fixture.mjs';

// A private folder is written by the agent, and a descendant that left the process group may still change it
// while ALA removes it. Whatever it does, the removal must never change anything outside the folder.
const modeOf = (file) => fs.statSync(file).mode & 0o7777;

test('a subfolder replaced by a link to a 0500 directory outside leaves that directory untouched', { skip },
  async (t) => {
    const f = fixture(t);
    const victim = path.join(f.outside, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep'), 'k');
    fs.chmodSync(victim, 0o500);
    const pool = createPrivateFolders({ temporaryRoot: f.root });
    t.after(() => pool.close());
    const { folder, temp } = pool.allocate();
    // A plain removal fails on the locked folder, so the confined repair runs over the link as well.
    fs.mkdirSync(path.join(temp, 'locked', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'locked', 'inner', 'f'), 'x');
    fs.chmodSync(path.join(temp, 'locked', 'inner'), 0o000);
    fs.chmodSync(path.join(temp, 'locked'), 0o000);
    fs.symlinkSync(victim, path.join(temp, 'sub'));
    fs.symlinkSync(victim, path.join(temp, 'locked-link'));
    assert.throws(() => fs.rmSync(folder, { recursive: true }), 'control: a plain removal fails, so the repair runs');
    assert.equal(removePrivateFolder(folder), true);
    assert.equal(fs.existsSync(folder), false);
    assert.equal(modeOf(victim), 0o500);
    assert.deepEqual(fs.readdirSync(victim), ['keep']);
  });

test('under the cleanup profile, changes through a link to a folder outside are refused, inside allowed', { skip },
  async (t) => {
    const f = fixture(t);
    const target = path.join(f.root, 'T');
    const outside = path.join(f.outside, 'V');
    for (const folder of [path.join(target, 'in', 'b'), path.join(outside, 'b'), path.join(outside, 'gone')]) {
      fs.mkdirSync(folder, { recursive: true });
    }
    for (const file of [path.join(target, 'in', 'file'), path.join(outside, 'file')]) fs.writeFileSync(file, 'x');
    for (const file of [path.join(target, 'in', 'flagged'), path.join(outside, 'flagged')]) {
      fs.writeFileSync(file, 'x');
      spawnSync('/usr/bin/chflags', ['uchg', file]);
    }
    fs.chmodSync(path.join(target, 'in', 'b'), 0o500);
    fs.chmodSync(path.join(outside, 'b'), 0o500);
    fs.symlinkSync(outside, path.join(target, 'link'));
    // The fixture removal cannot remove immutable files, so the flags are cleared before it, whatever happens.
    try { checkBoundary(target, outside); } finally { spawnSync('/usr/bin/chflags', ['-R', 'nouchg', f.root]); }
  });

function checkBoundary(target, outside) {
  const confined = (...command) => spawnSync('/usr/bin/sandbox-exec', ['-p', CLEANUP_PROFILE, '-D',
    `TARGET=${target}`, ...command], { encoding: 'utf8', env: {} }).status;
  const flagged = (file) => spawnSync('/bin/ls', ['-lO', file], { encoding: 'utf8' }).stdout.includes('uchg');
  for (const [base, allowed] of [[path.join(target, 'link'), false], [path.join(target, 'in'), true]]) {
    const expected = allowed ? 0 : 1;
    assert.equal(confined('/bin/chmod', 'u+rwx', `${base}/b`), expected, `chmod ${base}`);
    assert.equal(confined('/usr/bin/chflags', 'nouchg', `${base}/flagged`), expected, `chflags ${base}`);
    assert.equal(confined('/bin/rm', '-f', `${base}/file`), expected, `rm ${base}`);
  }
  assert.equal(modeOf(path.join(outside, 'b')), 0o500);
  assert.equal(flagged(path.join(outside, 'flagged')), true);
  assert.equal(fs.existsSync(path.join(outside, 'file')), true);
  assert.equal(confined('/bin/rm', '-rf', `${path.join(target, 'link')}/`), 1, 'rm -rf through the link');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['b', 'file', 'flagged', 'gone']);
  assert.equal(modeOf(path.join(target, 'in', 'b')), 0o700, 'inside: owner access restored');
  assert.equal(flagged(path.join(target, 'in', 'flagged')), false);
  assert.equal(fs.existsSync(path.join(target, 'in', 'file')), false);
}

// The racing case from the backend review. A swapper flips F/a (a folder holding SUBFOLDERS directories without
// owner access) and F/alink (a link to a directory outside) with RENAME_SWAP while each cleanup runs. Measured on
// macOS 27.2.1 against the former in-process repair, with four swappers and 20 subfolders: 76 of 1000 cleanups
// changed the outside directory (7.6 %). With 150 cleanups that repair misses every time with probability
// 0.924^150, about 7e-6, so this test fails on it; the confined repair must never change the outside directory.
const CLEANUPS = 150;
const SUBFOLDERS = 20;
const SWAPPERS = 4;
// Each swapper stops at a stop file or after SWAPPER_LIFETIME seconds, whichever comes first, so none outlives a
// crashed test, and prints how many swaps succeeded: a run whose swappers did not swap proves nothing.
const SWAPPER_LIFETIME = 120;
const MINIMUM_SWAPS = 10_000;
const SWAPPER = `import ctypes, os, sys, time
libc = ctypes.CDLL(None, use_errno=True)
a, l, stop, end = sys.argv[1].encode(), sys.argv[2].encode(), sys.argv[3], time.time() + float(sys.argv[4])
done = 0
while time.time() < end and not os.path.exists(stop):
    for _ in range(200):
        if libc.renamex_np(a, l, 2) == 0: done += 1
print(done)`;

test('cleanups racing a folder-for-link swap never change a directory outside', { skip, timeout: 240_000 },
  async (t) => {
    const f = fixture(t);
    const victim = path.join(f.outside, 'victim');
    for (let index = 0; index < SUBFOLDERS; index += 1) {
      fs.mkdirSync(path.join(victim, `b${index}`), { recursive: true });
      fs.writeFileSync(path.join(victim, `b${index}`, 'keep'), 'k');
      fs.chmodSync(path.join(victim, `b${index}`), 0o755);
    }
    const target = path.join(f.root, 'F');
    const staging = path.join(f.root, 'S');
    const left = path.join(f.root, 'left');
    fs.mkdirSync(left);
    const stop = path.join(f.root, 'stop');
    const swappers = Array.from({ length: SWAPPERS }, () => spawn('/usr/bin/python3',
      ['-I', '-c', SWAPPER, path.join(target, 'a'), path.join(target, 'alink'), stop, String(SWAPPER_LIFETIME)],
      { stdio: ['ignore', 'pipe', 'ignore'] }));
    t.after(() => { for (const swapper of swappers) swapper.kill('SIGKILL'); });
    const counts = swappers.map((swapper) => new Promise((resolve) => {
      let out = '';
      swapper.stdout.on('data', (chunk) => { out += chunk; });
      swapper.on('close', () => resolve(Number(out.trim()) || 0));
    }));
    await sleep(300);
    const onWarning = () => {};
    process.on('warning', onWarning);
    t.after(() => process.off('warning', onWarning));
    const changed = [];
    for (let cleanup = 0; cleanup < CLEANUPS; cleanup += 1) {
      for (let index = 0; index < SUBFOLDERS; index += 1) {
        const sub = path.join(staging, 'a', `b${index}`);
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, 'f'), 'x');
        fs.chmodSync(sub, 0o077);
      }
      fs.symlinkSync(victim, path.join(staging, 'alink'));
      fs.renameSync(staging, target);
      removePrivateFolder(target);
      // A cleanup the swapper defeated leaves the folder for the sweep; the test keeps it aside.
      if (fs.existsSync(target)) fs.renameSync(target, path.join(left, String(cleanup)));
      for (let index = 0; index < SUBFOLDERS; index += 1) {
        const sub = path.join(victim, `b${index}`);
        if (modeOf(sub) !== 0o755 || !fs.existsSync(path.join(sub, 'keep'))) {
          changed.push({ cleanup, sub, mode: modeOf(sub).toString(8) });
          fs.chmodSync(sub, 0o755);
        }
      }
    }
    fs.writeFileSync(stop, '');
    const swaps = (await Promise.all(counts)).reduce((sum, count) => sum + count, 0);
    spawnSync('/bin/chmod', ['-R', 'u+rwx', left]);
    assert.deepEqual(changed, []);
    assert.ok(swaps >= MINIMUM_SWAPS, `only ${swaps} swaps happened while the cleanups ran`);
    t.diagnostic(`${CLEANUPS} cleanups, ${swaps} successful swaps`);
  });
