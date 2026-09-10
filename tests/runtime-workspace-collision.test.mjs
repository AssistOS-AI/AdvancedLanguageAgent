import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxArgs, canStartBubblewrap, findBubblewrap } from '../src/coding-agents/sandbox.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const bwrap = findBubblewrap();
const supported = canStartBubblewrap(bwrap);

for (const local of [false, true]) {
  const layout = local ? 'local node_modules' : 'global npm prefix';
  test(`runs a ${layout} installed below /workspace across the task workspace overlay`, {
    skip: supported ? false : 'Bubblewrap cannot start in this test process'
  }, (context) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'ala-runtime-collision-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const modules = path.join(root, local ? 'project/node_modules' : 'tools/generation/lib/node_modules');
    const pkg = path.join(modules, 'native-agent');
    const dependency = path.join(modules, 'native-dependency');
    for (const folder of [pkg, dependency, path.join(root, 'task/.agents'), path.join(root, 'task/integration'),
      path.join(root, 'caller-runtime'), path.join(root, 'home')]) {
      fs.mkdirSync(folder, { recursive: true });
    }
    fs.writeFileSync(path.join(pkg, 'cli.mjs'), `#!/usr/bin/env node
import fs from 'node:fs';
import dependency from 'native-dependency';
let writable = false;
try { fs.writeFileSync(new URL('./write.txt', import.meta.url), 'changed'); writable = true; } catch {}
const integration = fs.readFileSync('/workspace/integration/caller-config.txt', 'utf8');
let integrationWritable = false;
try { fs.writeFileSync('/workspace/integration/caller-config.txt', 'changed'); integrationWritable = true; } catch {}
const state = process.env.HOME + '/thread.txt';
const previous = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : null;
if (!previous) fs.writeFileSync(state, 'saved-native-state');
fs.writeFileSync('/workspace/result.txt', 'task result');
console.log(JSON.stringify({ dependency, writable, integration, integrationWritable,
  cwd: process.cwd(), home: process.env.HOME,
  runtime: import.meta.url, previous, thread: fs.readFileSync(state, 'utf8'), argument: process.argv[2],
  hostOnlyVisible: fs.existsSync('/workspace/host-only.txt') }));
`, { mode: 0o755 });
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"type":"module","exports":"./index.mjs"}');
    fs.writeFileSync(path.join(dependency, 'index.mjs'), 'export default "sibling-loaded";\n');
    fs.writeFileSync(path.join(root, 'host-only.txt'), 'must be hidden');
    fs.writeFileSync(path.join(root, 'caller-runtime/caller-config.txt'), 'opaque caller-owned configuration');
    const binary = `/workspace/${path.relative(root, path.join(pkg, 'cli.mjs'))}`;
    // The outer sandbox gives the disposable installation the exact colliding host path.
    const input = `import { runProcess } from '/ala-src/coding-agents/process.mjs';
const results = [];
for (let index = 0; index < 2; index += 1) {
  const result = await runProcess({ binary: ${JSON.stringify(binary)}, args: ['unchanged argument'],
    cwd: '/workspace', env: {}, sandbox: { backend: 'pi', hostWorkspace: '/workspace/task',
      home: '/workspace/home', mounts: [], isolatedSkills: true,
      folders: [{ source: '/workspace/caller-runtime', alias: 'integration' }] } });
  if (result.code !== 0) { console.error(result.stderr); process.exit(result.code || 1); }
  results.push(JSON.parse(result.stdout));
}
console.log(JSON.stringify(results));`;
    const args = buildSandboxArgs({ workspace: root, binary: process.execPath,
      args: ['--input-type=module', '-'], backend: 'pi', env: {}, bwrap,
      mounts: [{ source, target: '/ala-src', writable: false }] });
    const execution = spawnSync(bwrap, args, { input, encoding: 'utf8', timeout: 15000 });
    assert.equal(execution.status, 0, execution.error?.message || execution.stderr);
    const results = JSON.parse(execution.stdout);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.dependency, 'sibling-loaded');
      assert.equal(result.writable, false);
      assert.equal(result.integration, 'opaque caller-owned configuration');
      assert.equal(result.integrationWritable, false);
      assert.equal(result.cwd, '/workspace');
      assert.equal(result.home, '/home/ala');
      assert.equal(result.thread, 'saved-native-state');
      assert.equal(result.argument, 'unchanged argument');
      assert.equal(result.hostOnlyVisible, false);
      const relative = local ? 'node_modules/native-agent/cli.mjs' : 'generation/lib/node_modules/native-agent/cli.mjs';
      assert.equal(result.runtime, `file:///run/ala-agent-runtime/0/${relative}`);
    }
    assert.equal(results[0].previous, null);
    assert.equal(results[1].previous, results[0].thread);
    assert.equal(fs.readFileSync(path.join(root, 'home/thread.txt'), 'utf8'), 'saved-native-state');
    assert.equal(fs.readFileSync(path.join(root, 'task/result.txt'), 'utf8'), 'task result');
    assert.equal(fs.existsSync(path.join(pkg, 'write.txt')), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'task')).sort(), ['.agents', 'integration', 'result.txt']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'task/.agents')), []);
    assert.equal(fs.readFileSync(path.join(root, 'caller-runtime/caller-config.txt'), 'utf8'),
      'opaque caller-owned configuration');
  });
}
