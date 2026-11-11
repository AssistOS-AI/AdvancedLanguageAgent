import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import {
  execute, fixture, hostPerl, run, sandboxPerl, service, skip
} from './seatbelt-fixture.mjs';

// Root guards on macOS: no granted root can be renamed, swapped, removed or replaced by a link, and no folder
// between a writable root and a root or mask inside it can be renamed. Each attack runs once unconfined on a
// second fixture as its control, so a refusal inside can only come from the sandbox.
const EPERM = 'ERR Operation not permitted';
const MOVE_AWAY = 'print t(rename($ARGV[0], $ARGV[1])), "\\n";';
const REPLACE_WITH_LINK = 'print t(rename($ARGV[0], $ARGV[1])), " ", t(symlink($ARGV[2], $ARGV[0])), "\\n";';
const SWAP = `import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
rc = libc.renamex_np(sys.argv[1].encode(), sys.argv[2].encode(), 2)
print("ok" if rc == 0 else "ERR %d" % ctypes.get_errno())`;
const swap = (a, b) => spawnSync('/usr/bin/python3', ['-I', '-c', SWAP, a, b], { encoding: 'utf8' }).stdout.trim();

function masked(f) {
  const secret = path.join(f.work, 'a', 'b', 'Secret');
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(secret, 'k.txt'), 'MASKED');
  return secret;
}

test('the workspace root can be neither moved into the private temp nor swapped with another folder', { skip },
  async (t) => {
    const control = fixture(t);
    assert.equal(hostPerl(MOVE_AWAY, [control.work, path.join(control.outside, 'moved')]), 'ok', 'host control');
    fs.mkdirSync(path.join(control.root, 'other'));
    assert.equal(swap(path.join(control.root, 'other'), path.join(control.outside)), 'ok', 'host control: swap');
    const f = fixture(t);
    const secret = masked(f);
    const moved = await run(f, '/bin/sh', ['-c', `/bin/mv "${f.work}" "$TMPDIR/x"; echo mv=$?; `
      + '/bin/cat "$TMPDIR/x/a/b/Secret/k.txt" 2>/dev/null; echo cat=$?'], { ignoredPaths: [secret] });
    assert.equal(moved.stdout, 'mv=1\ncat=1\n', moved.stderr);
    assert.match(moved.stderr, /^mv: rename .+: Operation not permitted$/mu);
    fs.mkdirSync(path.join(f.home, 'd'));
    const swapped = await run(f, '/usr/bin/python3', ['-I', '-c', SWAP, f.work, path.join(f.home, 'd')],
      { home: f.home, ignoredPaths: [secret] });
    assert.equal(swapped.stdout.trim(), 'ERR 1', swapped.stderr);
    assert.equal(fs.readFileSync(path.join(secret, 'k.txt'), 'utf8'), 'MASKED');
  });

test('an emptied write folder can be neither removed nor replaced by renaming onto it', { skip }, async (t) => {
  const code = 'print t(rmdir($ARGV[0])), " ", t(mkdir($ARGV[1]) && rename($ARGV[1], $ARGV[0])), "\\n";';
  const control = fixture(t);
  const controlFolder = path.join(control.root, 'write');
  fs.mkdirSync(controlFolder);
  assert.equal(hostPerl(code, [controlFolder, path.join(control.outside, 'd')]), 'ok ok', 'host control');
  const f = fixture(t);
  const folder = path.join(f.root, 'write');
  fs.mkdirSync(folder);
  const out = await sandboxPerl(f, code, [folder, path.join(f.work, 'd')],
    { folders: [{ source: folder, writable: true }] });
  assert.equal(out, `${EPERM} ${EPERM}`);
  assert.equal(fs.lstatSync(folder).isDirectory(), true);
});

test('a state folder replaced by a link cannot hand the next service the link target', { skip }, async (t) => {
  const control = fixture(t);
  assert.equal(hostPerl(REPLACE_WITH_LINK, [control.state, path.join(control.work, 'kept'), control.outside]),
    'ok ok', 'host control');
  const f = fixture(t);
  const first = await sandboxPerl(f, REPLACE_WITH_LINK, [f.state, path.join(f.work, 'kept'), f.outside]);
  assert.ok(first.startsWith(EPERM), first);
  assert.equal(fs.lstatSync(f.state).isDirectory(), true);
  const second = await run(f, '/bin/sh', ['-c', ': > "$CODEX_HOME/planted"; echo w=$?']);
  assert.equal(second.stdout, 'w=0\n');
  assert.deepEqual(fs.readdirSync(f.outside), ['victim.txt']);
  assert.equal(fs.existsSync(path.join(f.state, 'planted')), true);
});

test('an explicit home and an auto-created workspace cannot be replaced by a link either', { skip }, async (t) => {
  const f = fixture(t);
  const home = await sandboxPerl(f, REPLACE_WITH_LINK, [f.home, path.join(f.work, 'old'), f.outside], { home: f.home });
  assert.ok(home.startsWith(EPERM), home);
  const instance = service(f, { workspace: null, cwd: f.root });
  t.after(() => instance.close());
  const first = await execute(instance, '/bin/sh', ['-c',
    'W=$(/bin/pwd -P); echo "$W"; /bin/mv "$W" "$TMPDIR/moved"; echo mv=$?']);
  const [created, moved] = first.stdout.trim().split('\n');
  t.after(() => fs.rmSync(created, { recursive: true, force: true }));
  assert.equal(moved, 'mv=1', first.stderr);
  assert.match(first.stderr, /^mv: rename .+: Operation not permitted$/mu);
  assert.equal(fs.lstatSync(created).isDirectory(), true);
  const second = await execute(instance, '/bin/sh', ['-c', ': > planted; /bin/pwd -P']);
  assert.notEqual(second.stdout.trim(), f.outside);
  assert.deepEqual(fs.readdirSync(f.outside), ['victim.txt']);
});

test('a --cwd replaced by a link does not redirect the next invocation', { skip }, async (t) => {
  // The workspace is moved into the private temp folder, which the agent may write.
  const code = 'print t(rename($ARGV[0], "$ENV{TMPDIR}/gone")), " ", t(symlink($ARGV[1], $ARGV[0])), "\\n";';
  const control = fixture(t);
  assert.equal(hostPerl(code, [control.work, control.outside], { TMPDIR: control.home }), 'ok ok', 'host control');
  const f = fixture(t);
  const first = await sandboxPerl(f, code, [f.work, f.outside]);
  assert.ok(first.startsWith(EPERM), first);
  const second = await run(f, '/bin/sh', ['-c', 'echo written >> victim.txt; /bin/pwd -P']);
  assert.equal(second.stdout.trim().split('\n').at(-1), f.work);
  assert.equal(fs.readFileSync(path.join(f.outside, 'victim.txt'), 'utf8'), 'victim');
});

test('a folder between the workspace and a writable folder inside it cannot be renamed', { skip }, async (t) => {
  const code = 'print t(rename($ARGV[0], $ARGV[1])), " ", t(symlink($ARGV[2], $ARGV[0])), "\\n";';
  const control = fixture(t);
  fs.mkdirSync(path.join(control.work, 'x', 'inner'), { recursive: true });
  assert.equal(hostPerl(code, [path.join(control.work, 'x'), path.join(control.work, 'x2'), control.outside]),
    'ok ok', 'host control');
  const f = fixture(t);
  const inner = path.join(f.work, 'x', 'inner');
  fs.mkdirSync(inner, { recursive: true });
  const out = await sandboxPerl(f, code, [path.join(f.work, 'x'), path.join(f.work, 'x2'), f.outside],
    { folders: [{ source: inner, writable: true }] });
  assert.ok(out.startsWith(EPERM), out);
  // A guarded folder cannot be swapped with an unguarded sibling either.
  fs.mkdirSync(path.join(f.work, 'z'));
  const swapped = await run(f, '/usr/bin/python3', ['-I', '-c', SWAP, path.join(f.work, 'x'), path.join(f.work, 'z')],
    { folders: [{ source: inner, writable: true }] });
  assert.equal(swapped.stdout.trim(), 'ERR 1', swapped.stderr);
});

// Closed here: the release folder that holds the running program, and the folders above it. Not closed: other files in
// the state folder that the unconfined agent trusts, such as its settings; they stay writable state.
test('an agent installed inside its writable state folder cannot rewrite its release folder', { skip }, async (t) => {
  const f = fixture(t);
  const bin = path.join(f.state, 'packages', '1.0', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const agent = path.join(bin, 'agent');
  fs.writeFileSync(agent, `#!/bin/sh
echo tampered >> "$0" 2>/dev/null; echo install=$?
: > "$CODEX_HOME/session.json"; echo state=$?
/bin/mv "${path.join(f.state, 'packages')}" "$CODEX_HOME/moved" 2>/dev/null; echo rename=$?
`, { mode: 0o755 });
  assert.equal(spawnSync('/bin/sh', ['-c', `cp "${agent}" "${agent}.copy" && echo x >> "${agent}.copy"`]).status, 0,
    'host control');
  const installed = fs.readFileSync(agent, 'utf8');
  const result = await run(f, agent, []);
  assert.equal(result.stdout, 'install=1\nstate=0\nrename=1\n', result.stderr);
  assert.equal(fs.readFileSync(agent, 'utf8'), installed);
});

test('ordinary work inside the workspace and the state folder still succeeds', { skip }, async (t) => {
  const f = fixture(t);
  const out = await sandboxPerl(f, `
    print join(" ", t(open(my $o, ">", "n")), t(rename("n", "m")), t(unlink("m")), t(mkdir("d")),
      t(rename("d", "e")), t(rmdir("e")), t(mkdir("p/q") || (mkdir("p") && mkdir("p/q"))), t(rename("p", "r")),
      t(open(my $s, ">", "$ENV{CODEX_HOME}/s.json"))), "\\n";`);
  assert.equal(out, 'ok ok ok ok ok ok ok ok ok');
  assert.equal(fs.existsSync(path.join(f.state, 's.json')), true);
});

test('a host-side swap of a state folder, a home or an auto-created workspace between spawns exits 78', { skip },
  async (t) => {
    const swapAway = (directory) => {
      fs.renameSync(directory, `${directory}-old`);
      fs.mkdirSync(directory);
    };
    const f = fixture(t);
    for (const [options, target] of [[{}, f.state], [{ home: f.home }, f.home]]) {
      const instance = service(f, options);
      t.after(() => instance.close());
      assert.equal((await execute(instance, '/bin/sh', ['-c', 'true'])).code, 0);
      swapAway(target);
      await assert.rejects(execute(instance, '/bin/sh', ['-c', 'true']),
        { exitCode: 78, message: `A granted directory changed or is unavailable: ${target}` });
    }
    const auto = service(f, { workspace: null, cwd: f.root });
    t.after(() => auto.close());
    const created = (await execute(auto, '/bin/sh', ['-c', '/bin/pwd -P'])).stdout.trim();
    t.after(() => fs.rmSync(created, { recursive: true, force: true }));
    swapAway(created);
    t.after(() => fs.rmSync(`${created}-old`, { recursive: true, force: true }));
    await assert.rejects(execute(auto, '/bin/sh', ['-c', 'true']), { exitCode: 78 });
  });

// Codex's standalone layout on macOS: ~/.local/bin/codex -> ~/.codex/packages/standalone/current/bin/codex and
// current -> releases/<version>. Discovery hands ALA the resolved program, so the links must be found again.
function codexLayout(f) {
  const home = f.home;
  const standalone = path.join(home, '.codex', 'packages', 'standalone');
  const release = path.join(standalone, 'releases', '1.0', 'bin');
  const userBin = path.join(home, '.local', 'bin');
  for (const folder of [release, userBin]) fs.mkdirSync(folder, { recursive: true });
  const current = path.join(standalone, 'current');
  const evil = path.join(standalone, 'releases', 'evil');
  fs.writeFileSync(path.join(release, 'codex'), `#!/bin/sh
echo started
/bin/mkdir -p "${evil}/bin" && echo plant=ok
/bin/ln -sfn "${evil}" "${current}" 2>/dev/null && echo retarget=ok || echo retarget=refused
/bin/ln -s "${evil}" "${standalone}/next" 2>/dev/null
/usr/bin/perl -e 'print rename($ARGV[0], $ARGV[1]) ? "rename_onto=ok\\n" : "rename_onto=$!\\n"' \\
  "${standalone}/next" "${current}"
/bin/ln -s "${evil}" "${standalone}/next" 2>/dev/null
/usr/bin/python3 -I -c 'import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
rc = libc.renamex_np(sys.argv[1].encode(), sys.argv[2].encode(), 2)
print("swap=ok" if rc == 0 else "swap=%d" % ctypes.get_errno())' "${current}" "${standalone}/next"
/bin/ln -sfn "${evil}/bin/codex" "${userBin}/codex" 2>/dev/null && echo user_link=ok || echo user_link=refused
`, { mode: 0o755 });
  fs.symlinkSync(path.join(standalone, 'releases', '1.0'), current);
  fs.symlinkSync(path.join(current, 'bin', 'codex'), path.join(userBin, 'codex'));
  return { program: fs.realpathSync(path.join(userBin, 'codex')), userLink: path.join(userBin, 'codex'), current,
    release: path.join(standalone, 'releases', '1.0') };
}

test('the links that select the agent program cannot be retargeted, renamed onto or swapped', { skip },
  async (t) => {
    // Host control: unconfined, the same program changes every link on a second fixture.
    const control = codexLayout(fixture(t));
    assert.deepEqual(spawnSync(control.program, [], { encoding: 'utf8' }).stdout.trim().split('\n'),
      ['started', 'plant=ok', 'retarget=ok', 'rename_onto=ok', 'swap=ok', 'user_link=ok'], 'host control');
    const f = fixture(t);
    const layout = codexLayout(f);
    const env = { ...f.env, CODEX_HOME: path.join(f.home, '.codex') };
    // Default state root (~/.codex) and an explicit --home that makes ~/.local/bin writable as well.
    for (const options of [{}, { home: f.home }]) {
      const instance = createCodingAgentService({ agents: [{ name: 'codex', available: true, binary: layout.program }],
        workspace: f.work, cwd: f.work, env, ...options,
        runners: { codex: async (input) => ({ continuation: null, outputText: JSON.stringify(await runProcess({
          binary: layout.program, args: [], cwd: input.workspace, env: input.env, sandbox: input.sandbox })) }) } });
      t.after(() => instance.close());
      const result = JSON.parse(await instance.execute('x'));
      const lines = result.stdout.trim().split('\n');
      assert.deepEqual(lines.slice(0, 2), ['started', 'plant=ok'], result.stderr);
      assert.deepEqual(lines.slice(2), ['retarget=refused', 'rename_onto=Operation not permitted', 'swap=1',
        'user_link=refused'], JSON.stringify(options));
      assert.equal(fs.realpathSync(layout.userLink), layout.program);
      assert.equal(fs.readlinkSync(layout.current), layout.release);
    }
  });
