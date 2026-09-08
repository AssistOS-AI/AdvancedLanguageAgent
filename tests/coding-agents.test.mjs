import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as achillesModule from 'ploinky-agent-lib';
import {
  buildCodexArguments,
  createCodexEventParser,
  createCodexStderrParser,
  parseCodexOutput
} from '../src/coding-agents/codex.mjs';
import { discoverCodingAgents } from '../src/coding-agents/discovery.mjs';
import { parseOpenCodeModels } from '../src/coding-agents/opencode.mjs';
import { buildPiArguments, createPiEventParser, parsePiModels, parsePiOutput } from '../src/coding-agents/pi.mjs';
import { requireSandbox, runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { captureStream, writeAnthropicSkill } from './helpers.mjs';

const sandboxSupported = canStartBubblewrap();

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
  const defaultCodexArguments = buildCodexArguments({ prompt: 'continue', continuation: { threadId: 'thread-1' } });
  assert.equal(defaultCodexArguments.includes('--model'), false);
  assert.deepEqual(defaultCodexArguments.slice(
    defaultCodexArguments.indexOf('--sandbox'),
    defaultCodexArguments.indexOf('--sandbox') + 2
  ), ['--sandbox', 'danger-full-access']);
  assert.deepEqual(defaultCodexArguments.slice(-5), [
    'resume', '--json', '--skip-git-repo-check', 'thread-1', 'continue'
  ]);
  assert.deepEqual(buildCodexArguments({ prompt: 'run', model: 'gpt-test' }).slice(0, 2), ['--model', 'gpt-test']);
  assert.equal(buildCodexArguments({ prompt: 'research', websearch: true }).includes('--search'), true);
  assert.deepEqual(buildCodexArguments({ prompt: 'offline' }).slice(0, 2), [
    '--config', 'web_search="disabled"'
  ]);
  assert.deepEqual(buildCodexArguments({
    prompt: 'desktop', mcpServers: [{ name: 'desktop', url: 'http://127.0.0.1:8100/mcp' }]
  }).slice(0, 2), ['--config', 'mcp_servers.desktop.url="http://127.0.0.1:8100/mcp"']);
  const codex = parseCodexOutput([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })
  ].join('\n'));
  assert.deepEqual(codex, { outputText: 'done', continuation: { threadId: 'thread-1' } });
  assert.equal(parsePiOutput(JSON.stringify({
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'pi' }] }
  })), 'pi');
  assert.deepEqual(buildPiArguments({
    prompt: 'next', sessionId: 'session-1', sessionDir: '/tmp/sessions'
  }).slice(0, 6), ['--mode', 'json', '--session-id', 'session-1', '--session-dir', '/tmp/sessions']);
  assert.deepEqual(buildPiArguments({
    prompt: 'next', sessionId: 'session-1', sessionDir: '/tmp/sessions', model: 'provider/model'
  }).slice(-4), ['--model', 'provider/model', '--approve', 'next']);
  const webPiArguments = buildPiArguments({
    prompt: 'research', sessionId: 'session-1', sessionDir: '/tmp/sessions', websearch: true
  });
  assert.equal(webPiArguments.includes('--extension'), false);
  assert.equal(webPiArguments.includes('--exclude-tools'), false);
  assert.deepEqual(parseOpenCodeModels('\u001b[32mopenai/gpt-test\u001b[0m\nlocal/model'), [
    'openai/gpt-test', 'local/model'
  ]);
  assert.deepEqual(parsePiModels([
    'provider  model  context  max-out  thinking  images',
    'openai    gpt-test  200K  32K      yes       yes'
  ].join('\n')), ['openai/gpt-test']);
});


test('streams supported Codex and Pi events across chunk boundaries', () => {
  const codexText = [];
  const codex = createCodexEventParser({ onText: (text) => codexText.push(text) });
  codex.push(Buffer.from('{"type":"thread.started","thread_id":"thread-stream"}\n{"type":"item.comp'));
  codex.push(Buffer.from('leted","item":{"type":"command_execution","aggregated_output":"checked"}}\n'));
  codex.push(Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'));
  codex.finish();
  assert.deepEqual(codex.result(), {
    outputText: 'done', continuation: { threadId: 'thread-stream' }
  });
  assert.deepEqual(codexText, ['checked']);

  const intermediateText = [];
  const intermediateCodex = createCodexEventParser({ onText: (text) => intermediateText.push(text) });
  intermediateCodex.push(Buffer.from([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I will inspect it.\n' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'inspected\n' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } })
  ].join('\n')));
  intermediateCodex.finish();
  assert.deepEqual(intermediateText, ['I will inspect it.\n', 'inspected\n']);
  assert.equal(intermediateCodex.result().outputText, 'final answer');

  const stderrText = [];
  const codexStderr = createCodexStderrParser({ onText: (text) => stderrText.push(text) });
  codexStderr.push(Buffer.from('Reading additional input from std'));
  codexStderr.push(Buffer.from('in...\n2026-08-25T12:00:35Z ERROR codex_rollout::list: state db returned stale '));
  codexStderr.push(Buffer.from('rollout path for thread old: /home/ala/.codex/sessions/old.jsonl\nimportant diagnostic\n'));
  codexStderr.finish();
  assert.deepEqual(stderrText, ['important diagnostic\n']);

  const piText = [];
  const pi = createPiEventParser({ onText: (text) => piText.push(text) });
  pi.push(Buffer.from('{"type":"message_start","message":{"role":"assistant"}}\n'));
  pi.push(Buffer.from('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hel'));
  pi.push(Buffer.from('lo"}}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}\n'));
  pi.push(Buffer.from('{"type":"tool_execution_update","toolCallId":"one","partialResult":{"content":"abc"}}\n'));
  pi.push(Buffer.from('{"type":"tool_execution_end","toolCallId":"one","result":{"content":"abcd"}}'));
  pi.finish();
  assert.equal(pi.finalText(), 'hello');
  assert.deepEqual(piText, ['hello', 'abc', 'd']);
});


test('passes configured models and mutable websearch state to coding-agent invocations', async () => {
  const calls = [];
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    models: { codex: 'gpt-configured' },
    websearch: false,
    runners: {
      codex: async (input) => {
        calls.push(input);
        return { outputText: 'done', continuation: null };
      }
    }
  });
  await service.execute('first');
  service.setModel('codex', 'gpt-updated');
  service.setWebsearch(true);
  await service.execute('second');
  service.setModel('codex', null);
  await service.execute('third');
  assert.equal(calls[0].model, 'gpt-configured');
  assert.equal(calls[1].model, 'gpt-updated');
  assert.equal(calls[0].websearch, false);
  assert.equal(calls[1].websearch, true);
  assert.equal(calls[2].model, null);
  await service.close();
});

test('forwards live backend text and terminates an incomplete diagnostic line', async () => {
  const visible = [];
  const events = [];
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    eventSink: (event) => events.push(event),
    runners: {
      codex: async ({ onVisibleText }) => {
        onVisibleText('working');
        return { outputText: 'done', continuation: { threadId: 'thread-live' } };
      }
    }
  });
  service.setOutputSink((text) => visible.push(text));
  assert.equal(await service.execute('task'), 'done');
  assert.deepEqual(visible, ['working', '\n']);
  assert.deepEqual(events, [
    { type: 'coding-agent-selected', agent: 'codex', permissionMode: 'full-access' },
    { type: 'coding-agent-message', agent: 'codex', message: 'working' },
    { type: 'coding-agent-final', agent: 'codex', message: 'done' }
  ]);
  await service.close();
});

test('forwards cancellation to an active coding-agent process', async () => {
  assert.throws(() => requireSandbox(null), /must run inside the ALA Bubblewrap sandbox/);
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
  const workspace = calls[0].hostWorkspace;
  await service.close();
  await assert.rejects(() => access(workspace));
});

test('mounts Anthropic skill directories in the coding-agent workspace', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-agent-skills-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directoryPath = await writeAnthropicSkill(root, 'echo');
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    skills: [{ name: 'echo', directoryPath }],
    runners: {
      codex: async ({ workspace, sandbox }) => {
        assert.equal(workspace, '/workspace');
        const mount = sandbox.mounts.find((entry) => entry.target === '/workspace/.agents/skills/echo');
        return { outputText: await readFile(join(mount.source, 'SKILL.md'), 'utf8'), continuation: null };
      }
    }
  });
  context.after(() => service.close());
  assert.match(await service.execute('use echo'), /name: echo/u);
});

test('refreshes skill links while preserving workspace artifacts and native continuation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-agent-refresh-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstDirectory = await writeAnthropicSkill(join(root, 'first'), 'first-skill');
  const secondDirectory = await writeAnthropicSkill(join(root, 'second'), 'second-skill');
  const calls = [];
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    skills: [{ name: 'first-skill', directoryPath: firstDirectory }],
    runners: {
      codex: async (input) => {
        calls.push(input);
        return { outputText: 'done', continuation: { threadId: 'thread-1' } };
      }
    }
  });
  context.after(() => service.close());

  await service.execute('first');
  const workspace = calls[0].hostWorkspace;
  await writeFile(join(workspace, 'artifact.txt'), 'preserved');
  await service.refreshSkills([{ name: 'second-skill', directoryPath: secondDirectory }]);

  assert.equal(await readFile(join(workspace, 'artifact.txt'), 'utf8'), 'preserved');
  await assert.rejects(() => access(join(workspace, '.agents', 'skills', 'first-skill')));
  await service.execute('second');
  assert.equal(calls[1].hostWorkspace, workspace);
  assert.deepEqual(calls[1].continuation, { threadId: 'thread-1' });
  assert.deepEqual(calls[1].sandbox.mounts.filter((mount) => mount.purpose === 'task-skill').map((mount) => mount.target), [
    '/workspace/.agents/skills/second-skill'
  ]);
  await assert.rejects(() => service.refreshSkills([
    { name: 'duplicate', directoryPath: firstDirectory },
    { name: 'duplicate', directoryPath: secondDirectory }
  ]));
  await service.refreshSkills([]);
  await assert.rejects(() => access(join(workspace, '.agents', 'skills', 'second-skill')));
  assert.equal(await readFile(join(workspace, 'artifact.txt'), 'utf8'), 'preserved');
  await service.execute('third');
  assert.equal(calls[2].hostWorkspace, workspace);
  assert.deepEqual(calls[2].continuation, { threadId: 'thread-1' });
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

test('ask mode rejects selected Pi before workspace creation or native session mutation without fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-pi-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents = [
    { name: 'pi', available: true, binary: '/fake/pi' },
    { name: 'codex', available: true, binary: '/fake/codex' }
  ];
  let calls = 0;
  const service = createCodingAgentService({
    agents, workspace: root, permissionMode: 'ask-for-approval',
    sessionState: { record: { agent: 'pi' }, save: async () => { calls += 1; } },
    runners: {
      pi: async () => { calls += 1; return { outputText: 'Pi ran', continuation: null }; },
      codex: async () => { calls += 1; return { outputText: 'wrong backend', continuation: null }; }
    }
  });
  t.after(() => service.close());
  await assert.rejects(service.execute('task'), {
    message: 'Pi does not support ask-for-approval; select full-access or use Codex/OpenCode.', exitCode: 2
  });
  assert.equal(calls, 0);
  await assert.rejects(access(join(root, '.agents')));
  service.setPermissionMode('full-access');
  assert.equal(await service.execute('task'), 'Pi ran');
  service.setPermissionMode('ask-for-approval');
  await assert.rejects(service.execute('next'), /Pi does not support ask-for-approval/);
});

test('service cancellation releases pending approval and interrupts the active native operation', {
  timeout: 2000
}, async (t) => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const events = [];
  let answer;
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    permissionMode: 'ask-for-approval',
    eventSink: (event) => events.push(event),
    runners: { codex: async ({ signal, permissionRequests }) => {
      answer = permissionRequests.request({
        agent: 'codex', method: 'item/commandExecution/requestApproval', title: 'Run', message: 'Write scratch',
        options: [{ id: 'allow', label: 'Allow' }]
      }, { signal });
      ready();
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }
  });
  t.after(() => service.close());
  service.permissionRequests.setReplyCapability(true);
  const execution = service.execute('task');
  await started;
  service.cancel('host stopped');
  await assert.rejects(execution, { exitCode: 130 });
  assert.equal(await answer, null);
  assert.equal(events.some((event) => event.type === 'coding-agent-final'), false);
  assert.deepEqual(events.at(-1), { type: 'coding-agent-request-resolved', id: answer.id, reason: 'cancelled' });
});

test('registers and explicitly executes the built-in coding-agent Code Skill', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
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
