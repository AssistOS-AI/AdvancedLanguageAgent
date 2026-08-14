import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as achillesModule from 'ploinky-agent-lib';
import { buildCodexArguments, parseCodexOutput } from '../src/coding-agents/codex.mjs';
import { discoverCodingAgents } from '../src/coding-agents/discovery.mjs';
import { buildOpenCodeArguments, parseOpenCodeOutput } from '../src/coding-agents/opencode.mjs';
import { buildPiArguments, parsePiOutput } from '../src/coding-agents/pi.mjs';
import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { captureStream } from './helpers.mjs';

async function executable(root, name, source = '#!/bin/sh\nexit 0\n') {
  const filePath = join(root, name);
  await writeFile(filePath, source);
  await chmod(filePath, 0o700);
  return filePath;
}

test('discovers configured and PATH coding-agent executables in configured priority', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-agent-discovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codex = await executable(root, 'codex');
  const opencode = await executable(root, 'custom-opencode');
  const agents = await discoverCodingAgents({
    env: { HOME: join(root, 'home'), PATH: root, OPENCODE_BIN: opencode },
    priority: ['opencode', 'pi', 'codex']
  });
  assert.deepEqual(agents.map((agent) => agent.name), ['opencode', 'pi', 'codex']);
  assert.equal(agents[0].binary, opencode);
  assert.equal(agents[1].available, false);
  assert.equal(agents[2].binary, codex);
});

test('builds and parses native coding-agent protocols', () => {
  assert.deepEqual(buildCodexArguments({ prompt: 'continue', continuation: { threadId: 'thread-1' } }).slice(-5), [
    'resume', '--json', '--skip-git-repo-check', 'thread-1', 'continue'
  ]);
  const codex = parseCodexOutput([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })
  ].join('\n'));
  assert.deepEqual(codex, { outputText: 'done', continuation: { threadId: 'thread-1' } });
  assert.equal(parseOpenCodeOutput(JSON.stringify({ type: 'text', part: { text: 'open' } })), 'open');
  assert.deepEqual(buildOpenCodeArguments({
    prompt: 'next', workspace: '/tmp/work', sessionId: 'session-1'
  }).slice(-3), ['--session', 'session-1', 'next']);
  assert.equal(parsePiOutput(JSON.stringify({
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'pi' }] }
  })), 'pi');
  assert.deepEqual(buildPiArguments({
    prompt: 'next', sessionId: 'session-1', sessionDir: '/tmp/sessions'
  }).slice(0, 6), ['--mode', 'json', '--session-id', 'session-1', '--session-dir', '/tmp/sessions']);
});

test('forwards cancellation to an active coding-agent process', async () => {
  const controller = new AbortController();
  const running = runProcess({
    binary: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, { name: 'AbortError' });
});

test('pins continuation to one agent and removes its temporary workspace', async () => {
  const calls = [];
  const runners = {
    codex: async (input) => {
      calls.push(input);
      return { outputText: `result-${calls.length}`, continuation: { threadId: 'thread-1' } };
    }
  };
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    runners
  });
  assert.equal(await service.execute('first'), 'result-1');
  assert.equal(await service.execute('second'), 'result-2');
  assert.equal(calls[0].workspace, calls[1].workspace);
  assert.deepEqual(calls[1].continuation, { threadId: 'thread-1' });
  const workspace = calls[0].workspace;
  await service.close();
  await assert.rejects(() => access(workspace));
});

test('does not switch backends after a delegated process fails', async () => {
  const service = createCodingAgentService({
    agents: [
      { name: 'codex', available: true, binary: '/fake/codex' },
      { name: 'opencode', available: true, binary: '/fake/opencode' }
    ],
    runners: {
      codex: async () => { throw new Error('failed after launch'); },
      opencode: async () => ({ outputText: 'unexpected', continuation: { sessionId: 'one' } })
    }
  });
  await assert.rejects(() => service.execute('first', { agent: 'codex' }), /failed after launch/);
  await assert.rejects(() => service.execute('second', { agent: 'opencode' }), /pinned to codex/);
  await service.close();
});

test('registers and explicitly executes the built-in coding-agent Code Skill', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-codex-fake-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = await executable(root, 'codex', `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-test"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"delegated"}}'
`);
  const runtime = await createRuntime({
    achillesModule,
    repositories: [],
    codingAgents: [{ name: 'codex', available: true, binary }],
    options: { agent: 'codex', tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal((await runtime.execute('perform task')).result, 'delegated');
});
