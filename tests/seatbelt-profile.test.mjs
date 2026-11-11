import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SEATBELT_BASE_RULES, buildSeatbeltProfile } from '../src/coding-agents/seatbelt-profile.mjs';
import { seatbeltSearchPath, seatbeltSystemRoots } from '../src/coding-agents/seatbelt-roots.mjs';

// Pins the Seatbelt profile for one fixed input. Any change to these fixtures is a change to the macOS sandbox
// boundary and must be deliberate. The pure builder needs no macOS, so this runs on every platform.
const pinned = await readFile(new URL('./fixtures/seatbelt-profile.sb', import.meta.url), 'utf8');
const { input, params: pinnedParams } = JSON.parse(
  await readFile(new URL('./fixtures/seatbelt-profile.params.json', import.meta.url), 'utf8')
);
const ENVIRONMENT_PAIR = [
  ['(deny process-info*)', '(allow process-info* (target same-sandbox))'],
  ['(allow sysctl-read)', '(deny sysctl-read (sysctl-name-regex #"^kern\\.proc"))']
];
const minimal = { home: '/h/home', temp: '/h/tmp', mounts: [{ source: '/w', writable: true }] };
const lines = (profile) => profile.trimEnd().split('\n');

test('the profile for the fixed input stays pinned', () => {
  const { profile, params } = buildSeatbeltProfile(input);
  assert.equal(profile, pinned);
  assert.deepEqual(params, pinnedParams);
});

test('both rules of each environment pair are present, in order, after deny default', () => {
  for (const { profile } of [buildSeatbeltProfile(input), buildSeatbeltProfile(minimal)]) {
    const rules = lines(profile);
    const base = rules.indexOf('(deny default)');
    assert.ok(base > 0);
    for (const [first, second] of ENVIRONMENT_PAIR) {
      assert.equal(rules.filter((rule) => rule === first).length, 1, first);
      assert.equal(rules.filter((rule) => rule === second).length, 1, second);
      assert.ok(base < rules.indexOf(first), first);
      assert.ok(rules.indexOf(first) < rules.indexOf(second), `${first} before ${second}`);
    }
    assert.ok(profile.startsWith(SEATBELT_BASE_RULES), 'the base rules are constant text');
  }
});

test('no path reaches the profile text, whatever characters it holds', () => {
  const hostile = '/Users/a b/"q"\\x/(evil)) (allow default);/über/日本';
  const plain = buildSeatbeltProfile(minimal);
  const tricky = buildSeatbeltProfile({ ...minimal, mounts: [{ source: hostile, writable: true }],
    masks: [{ target: `${hostile}/m`, directory: true }] });
  for (const { profile } of [plain, tricky, buildSeatbeltProfile(input)]) {
    assert.doesNotMatch(profile, /\/Users|\/h\/|"\/w"|über|allow default/u);
  }
  assert.ok(tricky.params.includes(`MOUNT_0=${hostile}`));
  assert.ok(tricky.params.includes(`MASK_0=${hostile}/m`));
  const long = `/${'x'.repeat(999)}`;
  assert.ok(buildSeatbeltProfile({ ...minimal, mounts: [{ source: long, writable: true }] }).params
    .includes(`MOUNT_0=${long}`));
});

test('a parameter that is not an absolute, normalized, real path is refused with exit 5', () => {
  for (const source of ['relative', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\0b', 7]) {
    assert.throws(() => buildSeatbeltProfile({ ...minimal, mounts: [{ source, writable: true }] }), {
      exitCode: 5, message: /Seatbelt profile parameter MOUNT_0 must be an absolute, normalized, real path/u
    }, String(source));
  }
  const linked = (value) => (value === '/h/home' ? '/private/h/home' : value);
  assert.throws(() => buildSeatbeltProfile(minimal, { realpath: linked }), { exitCode: 5, message: /parameter HOME/u });
  assert.doesNotThrow(() => buildSeatbeltProfile(minimal, { realpath: (value) => value }));
});

test('roots are ordered by path length and masks and rename guards follow every allow', () => {
  const { profile, params } = buildSeatbeltProfile({
    home: '/p/home', temp: '/p/tmp',
    mounts: [{ source: '/r/repo/run', writable: true }, { source: '/r/repo', writable: false },
      { source: '/r/repo/run/in/ro', writable: false }],
    stateRoots: ['/r/repo/state'],
    masks: [{ target: '/r/repo/run/a/b/secret', directory: true }, { target: '/r/repo/key', directory: false }]
  });
  const rules = lines(profile);
  const name = (value) => params.find((entry) => !entry.startsWith('PARENT_') && entry.endsWith(`=${value}`))
    .split('=')[0];
  const at = (rule) => {
    const index = rules.indexOf(rule);
    assert.ok(index >= 0, rule);
    return index;
  };
  const repo = name('/r/repo');
  const run = name('/r/repo/run');
  const inner = name('/r/repo/run/in/ro');
  const state = name('/r/repo/state');
  // The read-only repository comes first, the writable working directory below it next, and the read-only
  // folder inside the working directory last, so each descendant keeps its own access.
  assert.ok(at(`(deny file-write* (subpath (param "${repo}")))`)
    < at(`(allow file-read* file-write* process-exec* (subpath (param "${run}")))`));
  assert.ok(at(`(allow file-read* file-write* process-exec* (subpath (param "${run}")))`)
    < at(`(deny file-write* (subpath (param "${inner}")))`));
  assert.ok(at(`(deny file-write* (subpath (param "${repo}")))`)
    < at(`(allow file-read* file-write* process-exec* (subpath (param "${state}")))`), 'state below a read-only mount');
  const lastAllow = Math.max(...rules.map((rule, index) => (rule.startsWith('(allow') ? index : -1)));
  const firstProtection = rules.findIndex((rule) => rule.includes('MASK_') || rule.includes('GUARD_'));
  assert.ok(lastAllow < firstProtection);
  const guards = params.filter((entry) => entry.startsWith('GUARD_')).map((entry) => entry.split('=')[1]);
  assert.deepEqual(guards, ['/r/repo/run/a', '/r/repo/run/a/b', '/r/repo/run/in']);
  assert.ok(params.includes('MASK_1=/r/repo/key'));
  assert.ok(rules.includes('(deny file-read* file-write* process-exec* network-outbound (literal (param "MASK_1")))'));
});

test('every parent folder of an allowed root is listable, and a workspace under / needs none', () => {
  const { params } = buildSeatbeltProfile({ home: '/h', temp: '/t', mounts: [{ source: '/ws', writable: true }] });
  assert.deepEqual(params.filter((entry) => entry.startsWith('PARENT_')), []);
  const nested = buildSeatbeltProfile({ ...minimal, systemRoots: ['/usr/bin'], supervisor: '/a/b/s.mjs' }).params;
  for (const parent of ['/a', '/a/b', '/h', '/usr']) {
    assert.ok(nested.some((entry) => entry.startsWith('PARENT_') && entry.endsWith(`=${parent}`)), parent);
  }
});

test('zero and fifty folders each get exactly one mount rule', () => {
  const folders = Array.from({ length: 50 }, (_, index) => ({ source: `/f/${index}`, writable: index % 2 === 0 }));
  const many = buildSeatbeltProfile({ ...minimal, mounts: [...minimal.mounts, ...folders] });
  assert.equal(many.params.filter((entry) => entry.startsWith('MOUNT_')).length, 51);
  assert.equal(lines(many.profile).filter((rule) => rule.startsWith('(deny file-write* (subpath')).length, 25);
  const none = buildSeatbeltProfile({ home: '/h', temp: '/t' });
  assert.equal(none.params.filter((entry) => entry.startsWith('MOUNT_')).length, 0);
});

test('system roots never include a whole etc or var folder, and PATH ends with the system folders', () => {
  const directories = new Set(['/usr/bin', '/usr/lib', '/System', '/private/etc', '/opt/homebrew',
    '/opt/homebrew/bin', '/opt/homebrew/Cellar', '/opt/homebrew/etc', '/opt/homebrew/etc/openssl@3',
    '/opt/homebrew/var', '/Library/Developer/CommandLineTools', '/agent', '/agent/bin']);
  const links = new Map([['/private/var/db/xcode_select_link', '/Library/Developer/CommandLineTools']]);
  const fsImpl = {
    realpathSync(value) {
      const resolved = links.get(value) || value;
      if (!directories.has(resolved)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return resolved;
    },
    statSync: () => ({ isDirectory: () => true })
  };
  const roots = seatbeltSystemRoots({ fsImpl });
  assert.ok(roots.includes('/opt/homebrew/etc/openssl@3'));
  assert.ok(roots.includes('/Library/Developer/CommandLineTools'));
  for (const excluded of ['/opt/homebrew/etc', '/opt/homebrew/var', '/opt/homebrew']) {
    assert.ok(!roots.includes(excluded), excluded);
  }
  assert.equal(seatbeltSearchPath(['/agent'], { fsImpl, prefixes: ['/opt/homebrew'] }),
    '/agent/bin:/agent:/opt/homebrew/bin:/usr/bin:/bin');
});

test('every granted root is guarded against rename, swap, removal and replacement, after every allow', () => {
  const { profile, params } = buildSeatbeltProfile({
    home: '/p/home', temp: '/p/tmp', stateRoots: ['/u/.codex'],
    runtimeRoots: ['/u/.codex/pkg/1/bin', '/opt/agent'],
    mounts: [{ source: '/w', writable: true }, { source: '/r', writable: false },
      { source: '/w/x/y/inner', writable: true }]
  });
  const rules = lines(profile);
  const named = (prefix, value) => params.find((entry) => entry.startsWith(prefix) && entry.endsWith(`=${value}`))
    ?.split('=')[0];
  const lastAllow = Math.max(...rules.map((rule, index) => (rule.startsWith('(allow') ? index : -1)));
  for (const [prefix, root] of [['HOME', '/p/home'], ['TEMP', '/p/tmp'], ['STATE_', '/u/.codex'], ['MOUNT_', '/w'],
    ['MOUNT_', '/r'], ['MOUNT_', '/w/x/y/inner'], ['RUNTIME_', '/u/.codex/pkg/1/bin'], ['RUNTIME_', '/opt/agent']]) {
    const guard = rules.indexOf(`(deny file-write-unlink (literal (param "${named(prefix, root)}")))`);
    assert.ok(guard > lastAllow, root);
  }
  // A folder between a writable root and a nested root of any kind, writable ones included.
  const guards = params.filter((entry) => entry.startsWith('GUARD_')).map((entry) => entry.split('=')[1]);
  assert.deepEqual(guards, ['/u/.codex/pkg', '/u/.codex/pkg/1', '/w/x', '/w/x/y']);
  // The installation inside the writable state root stays read-only: its deny follows the state allow.
  const state = named('STATE_', '/u/.codex');
  const runtime = named('RUNTIME_', '/u/.codex/pkg/1/bin');
  assert.ok(rules.indexOf(`(allow file-read* file-write* process-exec* (subpath (param "${state}")))`)
    < rules.indexOf(`(deny file-write* (subpath (param "${runtime}")))`));
  assert.equal(rules.includes(`(allow network-outbound (subpath (param "${runtime}")))`), false);
});

test('an installation that is itself a writable root keeps its grant', () => {
  const { params } = buildSeatbeltProfile({ home: '/h', temp: '/t', mounts: [{ source: '/w', writable: true }],
    runtimeRoots: ['/w', '/w/node_modules'] });
  assert.deepEqual(params.filter((entry) => entry.startsWith('RUNTIME_')), ['RUNTIME_0=/w/node_modules']);
});

test('a program link inside a writable root is guarded with the folders above it; one outside needs no rule', () => {
  const { profile, params } = buildSeatbeltProfile({ home: '/h', temp: '/t', stateRoots: ['/u/.codex'],
    links: ['/u/.local/bin/codex', '/u/.codex/packages/standalone/current'] });
  assert.deepEqual(params.filter((entry) => entry.startsWith('LINK_')),
    ['LINK_0=/u/.codex/packages/standalone/current']);
  assert.ok(lines(profile).includes('(deny file-write-unlink (literal (param "LINK_0")))'));
  assert.deepEqual(params.filter((entry) => entry.startsWith('GUARD_')).map((entry) => entry.split('=')[1]),
    ['/u/.codex/packages', '/u/.codex/packages/standalone']);
  // A link is named by its own path, but the folder holding it must be real.
  const moved = (value) => (value === '/u/.codex/sub' ? '/elsewhere' : value);
  assert.throws(() => buildSeatbeltProfile({ home: '/h', temp: '/t', stateRoots: ['/u/.codex'],
    links: ['/u/.codex/sub/x'] }, { realpath: moved }), { exitCode: 5, message: /parameter LINK_0/u });
});
