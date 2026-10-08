import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
import { applyCodingAgentOverrides } from '../src/config.mjs';
import { canStartBubblewrap, canMountPrivateProc } from '../src/coding-agents/sandbox.mjs';
import { captureStream, inputStream } from './helpers.mjs';

test('invocation settings preserve home defaults and isolate overrides to the selected backend', () => {
  const config = { models: { codex: 'robot', claude: 'other' }, efforts: { codex: 'low', claude: 'max' } };
  const original = structuredClone(config);
  assert.deepEqual(applyCodingAgentOverrides(config, { agent: 'codex' }), config);
  assert.deepEqual(applyCodingAgentOverrides(config, { agent: 'codex', model: 'chat', effort: 'high' }),
    { models: { codex: 'chat', claude: 'other' }, efforts: { codex: 'high', claude: 'max' } });
  assert.deepEqual(applyCodingAgentOverrides(config, { agent: 'codex', effort: 'default' }).efforts, { claude: 'max' });
  assert.deepEqual(applyCodingAgentOverrides(config, { agent: 'codex', model: 'chat' }).efforts, { claude: 'max' });
  assert.throws(() => applyCodingAgentOverrides({}, { agent: 'codex', effort: 'high' }), /requires --model/);
  assert.deepEqual(config, original);
});

test('CLI arguments override home model and effort without rewriting home configuration', {
  skip: canStartBubblewrap() && canMountPrivateProc() ? false : 'Bubblewrap unavailable',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ala-effort-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), cwd = join(root, 'project'), binary = join(root, 'codex');
  await mkdir(join(home, '.ala'), { recursive: true });
  await mkdir(cwd);
  const configFile = join(home, '.ala/config.json');
  const original = JSON.stringify({ codingAgent: 'codex', models: { codex: 'robot' }, efforts: { codex: 'low' } });
  await writeFile(configFile, original);
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'model/list' ? { data: ['robot', 'chat'].map(id => ({ id,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] })) } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  });
} else {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
    text: JSON.stringify(process.argv.slice(2)) } }) + '\\n');
}
`, { mode: 0o700 });
  const env = { ...process.env, CODEX_BIN: binary, HOME: join(root, 'unrelated'), ALA_CONFIG_PATH: '' };
  const cases = [
    { options: ['--ca', 'auto'], model: 'robot', effort: 'low' },
    { options: ['--model', 'chat', '--effort', 'high'], model: 'chat', effort: 'high' },
    { options: ['--effort', 'high'], model: 'robot', effort: 'high' },
    { options: ['--model', 'robot', '--effort', 'default'], model: 'robot', effort: null },
    { options: ['--ca', 'auto', '--model', 'chat'], model: 'chat', effort: null },
  ];
  for (const scenario of cases) {
    const stdout = captureStream(), stderr = captureStream();
    const code = await runCli({ argv: ['--home', home, '--cwd', cwd, ...scenario.options, 'Inspect'], env,
      stdin: inputStream(), stdout, stderr, cwd: root });
    assert.equal(code, 0, stderr.read());
    const args = JSON.parse(stdout.read());
    assert.equal(args[args.indexOf('--model') + 1], scenario.model);
    assert.deepEqual(args.filter(arg => arg.startsWith('model_reasoning_effort=')),
      scenario.effort ? [`model_reasoning_effort="${scenario.effort}"`] : []);
    assert.equal(await readFile(configFile, 'utf8'), original);
  }
  const stderr = captureStream();
  assert.equal(await runCli({ argv: ['--home', home, '--cwd', cwd, '--effort', 'unsupported', 'Inspect'], env,
    stdin: inputStream(), stdout: captureStream(), stderr, cwd: root }), 5);
  assert.match(stderr.read(), /does not advertise this effort/);
});
