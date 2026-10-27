import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { runControlledExecution } from '../src/controlled-execution.mjs';
import { startOpenCodeServer } from '../src/coding-agents/opencode-server.mjs';
import { executeOpenCodeTurn } from '../src/coding-agents/opencode-turn.mjs';
import { directSandbox } from './direct-provider.mjs';

const fixture = fileURLToPath(new URL('./fixtures/opencode-server.mjs', import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Path coverage, not a deterministic regression: OpenCode runs one server per execution and the service reports
// 'queued' for it, so a message received during a turn is replayed as a second execution against a new server on
// the same loopback origin. The deterministic connection-reuse regression is in opencode-http-scope.test.mjs.
const bounded = { timeout: 30_000 };

test('a message received during a turn runs as a second turn on a new server', bounded, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-queued-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'fixture-options.json'), JSON.stringify({ anyDirectory: true }));
  const port = String(await freePort());
  const env = { HOME: root, OPENCODE_FIXTURE_PORT: port };
  let continuation;
  const prompts = [];
  const runtime = {
    sendMessage: async () => ({ delivery: 'queued' }),
    async execute(prompt, { signal }) {
      prompts.push(prompt);
      const input = { binary: fixture, workspace, env, websearch: false, signal, prompt, continuation,
        sandbox: directSandbox(),
        permissionMode: 'full-access',
        onSession: async () => writeFile(join(workspace, 'persisted-before-work'), '1') };
      const server = await startOpenCodeServer(input);
      try {
        const result = await executeOpenCodeTurn(server, input);
        continuation = result.continuation;
        return result.outputText;
      } finally { await server.stop(); }
    }
  };
  const input = new PassThrough();
  const events = [];
  const eventSink = (event) => events.push(event);
  const execution = runControlledExecution(runtime, 'historical-idle', { input, eventSink });
  input.write(`${JSON.stringify({ type: 'message', id: 'follow-up', message: 'historical-idle' })}\n`);
  assert.equal(await execution, 'current turn, not historical text');
  assert.deepEqual(prompts, ['historical-idle', 'historical-idle']);
  const accepted = events.filter((event) => event.type === 'message-accepted');
  assert.deepEqual(accepted.map(({ id, delivery }) => ({ id, delivery })), [{ id: 'follow-up', delivery: 'queued' }]);
  const lines = (await readFile(join(workspace, 'native-events.jsonl'), 'utf8')).trim().split('\n');
  const log = lines.map((line) => JSON.parse(line));
  assert.equal(log.filter((event) => event.type === 'start').length, 2, 'two servers ran');
  assert.equal(log.filter((event) => event.type === 'prompt').length, 2, 'both turns reached OpenCode');
  assert.equal(log.filter((event) => event.type === 'create').length, 1, 'the second turn resumed the first session');
  assert.equal(await readFile(join(workspace, 'server-address'), 'utf8'), `http://127.0.0.1:${port}`);
});
