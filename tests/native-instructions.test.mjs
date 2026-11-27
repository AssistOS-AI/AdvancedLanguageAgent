import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENT_NAMES } from '../src/coding-agents/registry.mjs';
import { prepareNativeInstructions, validateSystemPrompt } from '../src/coding-agents/native-instructions.mjs';
import { buildNativeSessionLaunch } from '../src/coding-agents/native-session.mjs';
import { parseArguments } from '../src/arguments.mjs';
import { canStartBubblewrap, findBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { onlyOnLinux } from './helpers.mjs';

const text = 'Session instructions: "review"\n$(touch /tmp/never-run-this) `id` \\ ü';
const describe = (agent, systemPrompt, extra = {}) => buildNativeSessionLaunch({
  agent, systemPrompt, binary: '/usr/bin/fake-agent', workspace: '/tmp/project',
  env: {}, bwrap: '/usr/bin/bwrap', probePrivateProc: () => true,
  launch: value => value, ...extra
});

test('systemPrompt validates UTF-8 length and rejects NUL and non-text', () => {
  for (const value of [undefined, null, '']) assert.equal(validateSystemPrompt(value), null);
  assert.equal(validateSystemPrompt('ü'.repeat(8192)).length, 8192);
  for (const value of [false, {}, [], 'a\0b', 'ü'.repeat(8193)]) {
    assert.throws(() => validateSystemPrompt(value), /systemPrompt/u);
  }
});

for (const agent of AGENT_NAMES) {
  test(`${agent}: native instructions are isolated data and preserve resume arguments`, t => {
    const a = describe(agent, text, { nativeArgs: ['--resume', 'session-1'], loginShell: '/bin/bash' });
    const b = describe(agent, 'Other session');
    t.after(() => { a.cleanup(); b.cleanup(); });
    assert.equal(a.binary, '/bin/bash');
    assert.equal(a.args[2], 'exec "$0" "$@"');
    const index = a.args.indexOf('--resume');
    assert.equal(a.args[index + 1], 'session-1');
    // The caller text is never passed as a positional user prompt or evaluated as shell source.
    assert.equal(a.args.includes(text), false);
    for (const file of a.sandbox.fileMounts) {
      assert.ok(file.target.startsWith('/tmp/'), 'generated profiles must not alter a shared home');
      assert.ok(!b.sandbox.fileMounts.some(other => other.source === file.source || other.target === file.target));
      const contents = fs.readFileSync(file.source, 'utf8');
      assert.ok(contents.includes(text) || contents.includes(JSON.stringify(text)));
    }
    if (agent === 'codex') {
      const option = a.args.find(arg => arg.startsWith('developer_instructions='));
      assert.equal(JSON.parse(option.slice('developer_instructions='.length)), text);
    } else assert.ok(a.sandbox.fileMounts.length);
    const sources = a.sandbox.fileMounts.map(file => file.source);
    a.cleanup();
    for (const source of sources) assert.equal(fs.existsSync(source), false);
    assert.ok(b.sandbox.fileMounts.every(file => fs.existsSync(file.source)));
  });
}

test('instruction profiles have stable native names on relaunch and private host files', () => {
  const first = prepareNativeInstructions('vibe', text);
  const resumed = prepareNativeInstructions('vibe', text);
  try {
    assert.deepEqual(first.args, resumed.args);
    assert.equal(first.fileMounts[0].target, resumed.fileMounts[0].target);
    assert.notEqual(first.fileMounts[0].source, resumed.fileMounts[0].source);
  } finally { first.cleanup(); resumed.cleanup(); }
});

test('OpenCode extends existing inline configuration and instruction paths', () => {
  const result = describe('opencode', text, { env: { OPENCODE_CONFIG_CONTENT:
    JSON.stringify({ model: 'fixture/model', instructions: ['/project/rules.md'] }) } });
  try {
    const config = JSON.parse(result.args.find(arg => arg.startsWith('OPENCODE_CONFIG_CONTENT=')).split('=').slice(1).join('='));
    assert.equal(config.model, 'fixture/model');
    assert.deepEqual(config.instructions, ['/project/rules.md', result.sandbox.fileMounts[0].target]);
  } finally { result.cleanup(); }
});

test('an unsupported backend refuses instructions rather than submitting a user turn', () => {
  assert.throws(() => prepareNativeInstructions('missing', text), /not supported/u);
});

test('CLI accepts system instructions only for native interactive sessions', () => {
  assert.equal(parseArguments(['--native-interactive', '--system-prompt', text]).systemPrompt, text);
  assert.throws(() => parseArguments(['--system-prompt', text]), /requires --native-interactive/u);
});

const bwrap = findBubblewrap();
test('Bubblewrap exposes generated instructions only to their session, without writing shared home', {
  skip: onlyOnLinux(canStartBubblewrap(bwrap) ? false : 'Bubblewrap cannot start in this test process')
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ala-native-instruction-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const binary = path.join(workspace, 'fake-agent');
  fs.writeFileSync(binary, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --append-system-prompt) shift; /bin/cat "$1"; exit;;
    --agent) shift; /bin/cat "/tmp/$1/$1.toml"; exit;;
  esac
  shift
done
exit 11
`, { mode: 0o700 });
  for (const agent of ['pi', 'vibe']) {
    const launch = buildNativeSessionLaunch({ agent, binary, workspace, home, env: {}, bwrap,
      systemPrompt: text, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(text) || result.stdout.includes(JSON.stringify(text)));
      assert.deepEqual(fs.readdirSync(home), []);
      assert.deepEqual(fs.readdirSync(workspace), ['fake-agent']);
    } finally { launch.cleanup(); }
  }
});

const nativeMcp = { name: 'robowork_worker', command: '/usr/bin/node', args: ['/run/robowork-worker/mcp.mjs'], extension: '/run/robowork-worker/mcp.mjs' };
for (const agent of AGENT_NAMES) test(`${agent}: native worker tools coexist with system instructions without changing shared files`, () => {
  const result = prepareNativeInstructions(agent, 'Supervise work', {}, nativeMcp);
  try {
    const config = JSON.stringify({ args: result.args, env: result.env, files: result.fileMounts.map(f => fs.readFileSync(f.source, 'utf8')) });
    assert.ok(config.includes('/run/robowork-worker/mcp.mjs'));
    if (agent === 'opencode') {
      const inline = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(inline.instructions.length, 1);
      assert.deepEqual(inline.mcp.servers.robowork_worker.command, [nativeMcp.command, ...nativeMcp.args]);
    }
    assert.ok(result.fileMounts.every(f => f.target.startsWith('/tmp/')));
  } finally { result.cleanup(); }
});
test('invalid native MCP configuration is rejected before launch', () => {
  for (const change of [{ name: 'bad.name' }, { command: 'node' }, { args: ['a\0b'] }, { extension: 'relative.mjs' }]) {
    assert.throws(() => prepareNativeInstructions('codex', null, {}, { ...nativeMcp, ...change }), /Invalid native MCP/u);
  }
});

test('native argument flags are forwarded as values, including explicit session resume', () => {
  assert.deepEqual(parseArguments(['--native-interactive', '--native-arg', '--session', '--native-arg', 'ses_test']).nativeArgs, ['--session', 'ses_test']);
  assert.throws(() => parseArguments(['--native-interactive', '--native-arg']), /requires a value/u);
});
