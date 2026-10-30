import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DESCRIPTOR = `import path from 'node:path';
import { defineAgent } from '../../define-agent.mjs';
import { SANDBOX_HOME } from '../../paths.mjs';
export default defineAgent({
  name: 'fake', label: 'Fake', description: 'Fake Agent',
  binary: { env: 'FAKE_BIN', installPaths: (home) => [path.join(home, '.local', 'bin', 'fake')] },
  capabilities: { approvals: false, privateProc: false },
  state: (env, home) => [{ source: path.join(home, '.fake'), target: SANDBOX_HOME + '/.fake' }],
  sandbox: { envAllow: ['FAKE_API_KEY'], envSet: { FAKE_STATE: SANDBOX_HOME + '/.fake' }, credentialEnv: ['FAKE_API_KEY'] },
  login: { files: ['auth'], detect: async () => false },
  adapter: () => import('./adapter.mjs')
});
`;
const ADAPTER = `import { executionError, runProcess } from '../../process.mjs';
export async function run({ binary, prompt, workspace, env, signal, sandbox }) {
  const result = await runProcess({ binary, args: [prompt], cwd: workspace, env, signal, sandbox });
  if (result.code !== 0) throw executionError('Fake', result);
  return { outputText: result.stdout.trim() };
}
export async function listModels() { return [{ id: 'fake-1', efforts: [] }]; }
`;

// The proof of the registry: a new agent is one folder and one line in registry.mjs, on a copy of the
// sources, and every CLI surface then works without any other source change.
test('a new agent needs only its folder and a registry line', {
  skip: canStartBubblewrap() ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-add-agent-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'copy');
  for (const entry of ['src', 'bin', 'package.json']) await cp(join(projectRoot, entry), join(copy, entry), { recursive: true });
  await mkdir(join(copy, 'src/coding-agents/agents/fake'));
  await writeFile(join(copy, 'src/coding-agents/agents/fake/index.mjs'), DESCRIPTOR);
  await writeFile(join(copy, 'src/coding-agents/agents/fake/adapter.mjs'), ADAPTER);
  const registryFile = join(copy, 'src/coding-agents/registry.mjs');
  const registry = await readFile(registryFile, 'utf8');
  await writeFile(registryFile, registry
    .replace("import codex from", "import fake from './agents/fake/index.mjs';\nimport codex from")
    .replace('Object.freeze([codex,', 'Object.freeze([fake, codex,'));

  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const binary = join(root, 'bin', 'fake');
  await Promise.all([mkdir(join(home, '.fake'), { recursive: true }), mkdir(workspace), mkdir(dirname(binary))]);
  await writeFile(binary, '#!/bin/sh\nprintf "fake:%s:%s:%s\\n" "$1" "$FAKE_STATE" "$FAKE_API_KEY"\n');
  await chmod(binary, 0o755);
  const env = { PATH: '/usr/bin:/bin', HOME: home, FAKE_BIN: binary, FAKE_API_KEY: 'key', ALA_CONFIG_PATH: root };
  const ala = (args, options = {}) => run(process.execPath, [join(copy, 'bin/ala.mjs'), ...args], { env, ...options });

  assert.equal(JSON.parse((await ala(['agent', 'list', '--json'])).stdout)[0], 'fake');
  assert.match((await ala(['--help'])).stdout, /agent models <fake\|codex/u);
  const status = JSON.parse((await ala(['status', '--json'])).stdout);
  assert.deepEqual(status.agents.find((agent) => agent.name === 'fake').login.env, ['FAKE_API_KEY']);
  assert.deepEqual(JSON.parse((await ala(['agent', 'models', 'fake', '--json'])).stdout)[0].id, 'fake-1');
  assert.equal((await ala(['--ca', 'fake', '--cwd', workspace, 'hello'])).stdout.trim(),
    'fake:hello:/home/ala/.fake:key');
  const child = execFile(process.execPath, [join(copy, 'bin/ala.mjs'), '-i', '--cwd', workspace], { env });
  child.stdin.end('/agent use fake\n/quit\n');
  await new Promise((done) => child.on('close', done));
  assert.equal(JSON.parse(await readFile(join(root, '.ala/config.json'), 'utf8')).codingAgent, 'fake');
  await assert.rejects(ala(['--ca', 'fake', '--permissions', 'ask-for-approval', '--cwd', workspace, 'hello']),
    /Fake, Pi and OMP support full-access only/u);
});
