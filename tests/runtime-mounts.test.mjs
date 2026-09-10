import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxArgs, canStartBubblewrap, findBubblewrap,
  sandboxRuntimeMounts } from '../src/coding-agents/sandbox.mjs';
import { runProcess } from '../src/coding-agents/process.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ala-runtime-mounts-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, 'host-workspace', '.data', 'tools', 'generation');
  const packageRoot = join(prefix, 'lib/node_modules/native-agent');
  const workspace = join(root, 'task');
  const home = join(root, 'home');
  await Promise.all([mkdir(join(prefix, 'bin'), { recursive: true }),
    mkdir(packageRoot, { recursive: true }), mkdir(workspace), mkdir(home)]);
  const script = join(packageRoot, 'agent.mjs');
  await writeFile(script, `#!/usr/bin/env node
import fs from 'node:fs';
const state = new URL('./runtime-state.txt', import.meta.url);
let runtimeWritable = false;
try { fs.writeFileSync(state, 'changed'); runtimeWritable = true; } catch {}
const session = process.env.HOME + '/native-thread.txt';
const previous = fs.existsSync(session) ? fs.readFileSync(session, 'utf8') : null;
if (!previous) fs.writeFileSync(session, 'native-thread-1');
fs.writeFileSync('/workspace/result.txt', 'task result');
console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME,
  runtime: import.meta.url, runtimeWritable, previous,
  thread: fs.readFileSync(session, 'utf8'), argument: process.argv[2] }));
`, { mode: 0o755 });
  const binary = join(prefix, 'bin/native-agent');
  await symlink('../lib/node_modules/native-agent/agent.mjs', binary);
  return { root, prefix: await realpath(prefix), workspace, home, binary };
}

test('relocates only prefixes hidden by the workspace bind and preserves node_modules lookup', () => {
  const sources = ['/workspace/.data/tools/generation', '/workspace/repo/node_modules',
    '/data/tools/generation', '/opt/tools', '/tmp/install', '/workspace-other/tools'];
  const mounts = sandboxRuntimeMounts(sources);
  assert.deepEqual(mounts.map((mount) => mount.target), [
    '/run/ala-agent-runtime/0/generation', '/run/ala-agent-runtime/1/node_modules', ...sources.slice(2)
  ]);
  assert.deepEqual(mounts.map((mount) => mount.source), sources);
  assert.equal(mounts.every((mount) => !mount.writable && mount.purpose === 'agent-runtime'), true);
});

test('keeps noncolliding package paths read-only without widening the exposed installation', {
  skip: process.platform !== 'linux'
}, async (context) => {
  const f = await fixture(context);
  const args = buildSandboxArgs({ workspace: f.workspace, backend: 'codex', binary: f.binary,
    args: ['unchanged argument'], home: f.home, isolatedSkills: true, bwrap: '/fake/bwrap', privateProc: true });
  const runtimeMount = args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === f.prefix);
  assert.notEqual(runtimeMount, -1);
  assert.equal(args[runtimeMount + 2], f.prefix);
  assert.equal(args.some((value, index) => value === '--bind' && args[index + 1] === f.prefix), false);
  assert.equal(args.some((value, index) => ['--bind', '--ro-bind'].includes(value)
    && [f.root, join(f.root, 'host-workspace')].includes(args[index + 1])), false);
  const command = args.lastIndexOf('--');
  assert.equal(args[command + 1], join(f.prefix, 'lib/node_modules/native-agent/agent.mjs'));
  assert.equal(args[command + 2], 'unchanged argument');
  const envPath = args.findIndex((value, index) => value === '--setenv' && args[index + 1] === 'PATH');
  assert.equal(args[envPath + 2].split(':')[0], join(f.prefix, 'bin'));
  assert.equal(args.some((value, index) => value === '--bind' && args[index + 1] === f.home
    && args[index + 2] === '/home/ala'), true);
  assert.equal(args.some((value, index) => value === '--bind' && args[index + 1] === f.workspace
    && args[index + 2] === '/workspace'), true);
});

test('runtime stays read-only across processes with the same home, cwd and native state', {
  skip: canStartBubblewrap(findBubblewrap()) ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const f = await fixture(context);
  const input = { binary: f.binary, args: ['unchanged argument'], cwd: '/workspace',
    sandbox: { backend: 'pi', hostWorkspace: f.workspace, home: f.home, mounts: [], isolatedSkills: true } };
  const results = [];
  for (let index = 0; index < 2; index += 1) {
    const result = await runProcess(input);
    assert.equal(result.code, 0, result.stderr);
    results.push(JSON.parse(result.stdout));
  }
  for (const result of results) {
    assert.equal(result.cwd, '/workspace');
    assert.equal(result.home, '/home/ala');
    assert.equal(result.runtime, `file://${f.prefix}/lib/node_modules/native-agent/agent.mjs`);
    assert.equal(result.runtimeWritable, false);
    assert.equal(result.thread, 'native-thread-1');
    assert.equal(result.argument, 'unchanged argument');
  }
  assert.equal(results[0].previous, null);
  assert.equal(results[1].previous, results[0].thread);
  assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'task result');
  assert.equal(await readFile(join(f.home, 'native-thread.txt'), 'utf8'), 'native-thread-1');
});

test('preserves absolute in-prefix interpreters and helper symlinks outside the workspace overlay', {
  skip: canStartBubblewrap(findBubblewrap()) ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const f = await fixture(context);
  const interpreter = join(f.prefix, 'bin/interpreter');
  const helper = join(f.prefix, 'bin/helper');
  const binary = join(f.prefix, 'bin/absolute-agent');
  await writeFile(interpreter, '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
  await writeFile(join(f.prefix, 'bin/value'), 'absolute-helper-preserved');
  await symlink(join(f.prefix, 'bin/value'), helper);
  await writeFile(binary, `#!${interpreter}\ncat '${helper}'\n`, { mode: 0o755 });
  const result = await runProcess({ binary, args: [], cwd: '/workspace',
    sandbox: { backend: 'pi', hostWorkspace: f.workspace, home: f.home, mounts: [] } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'absolute-helper-preserved');
});
