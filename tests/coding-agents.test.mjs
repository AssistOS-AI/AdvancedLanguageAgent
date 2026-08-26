import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  buildOpenCodeArguments,
  configureOpenCodeWebsearch,
  openCodeEnvironment,
  parseOpenCodeModels,
  parseOpenCodeOutput,
  runOpenCode
} from '../src/coding-agents/opencode.mjs';
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
  assert.deepEqual(defaultCodexArguments.slice(-5), [
    'resume', '--json', '--skip-git-repo-check', 'thread-1', 'continue'
  ]);
  assert.deepEqual(buildCodexArguments({ prompt: 'run', model: 'gpt-test' }).slice(0, 2), ['--model', 'gpt-test']);
  assert.equal(buildCodexArguments({ prompt: 'research', websearch: true }).includes('--search'), true);
  assert.deepEqual(buildCodexArguments({ prompt: 'offline' }).slice(0, 2), [
    '--config', 'web_search="disabled"'
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
  assert.deepEqual(buildOpenCodeArguments({
    prompt: 'next', workspace: '/tmp/work', model: 'provider/model'
  }).slice(-3), ['--model', 'provider/model', 'next']);
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

test('configures OpenCode web tools and its opt-in search environment', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-websearch-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await configureOpenCodeWebsearch(root, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8')).permission, {
    websearch: 'allow', webfetch: 'allow'
  });
  assert.equal(openCodeEnvironment({ KEEP: 'yes' }, true).OPENCODE_ENABLE_EXA, '1');
  await configureOpenCodeWebsearch(root, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8')).permission, {
    websearch: 'deny', webfetch: 'deny'
  });
  assert.equal(openCodeEnvironment({}, false).OPENCODE_ENABLE_EXA, '0');
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

test('uses native OpenCode output while exporting the final assistant message', {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-runner-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  const configRoot = join(root, 'config');
  const dataRoot = join(root, 'data');
  const cacheRoot = join(root, 'cache');
  await Promise.all([
    mkdir(workspace),
    mkdir(join(stateRoot, 'opencode'), { recursive: true }),
    mkdir(join(configRoot, 'opencode'), { recursive: true }),
    mkdir(join(dataRoot, 'opencode'), { recursive: true }),
    mkdir(join(cacheRoot, 'opencode'), { recursive: true })
  ]);
  const binary = await executable(root, 'opencode', `#!/bin/sh
case "$1" in
  run)
    shift
    title=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--title' ]; then title="$2"; shift 2; else shift; fi
    done
    printf '[{"id":"session-test","title":"%s","directory":"/workspace"}]' "$title" > "$XDG_STATE_HOME/opencode/sessions.json"
    printf 'native progress\n'
    ;;
  session)
    cat "$XDG_STATE_HOME/opencode/sessions.json"
    ;;
  export)
    printf '%s\n' '{"messages":[{"info":{"role":"assistant"},"parts":[{"type":"text","text":"exported final"}]}]}'
    ;;
esac
`);
  const visible = [];
  const result = await runOpenCode({
    binary,
    prompt: 'perform task',
    workspace: '/workspace',
    hostWorkspace: workspace,
    continuation: null,
    model: null,
    websearch: false,
    env: {
      HOME: root,
      XDG_STATE_HOME: stateRoot,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      XDG_CACHE_HOME: cacheRoot
    },
    signal: null,
    sandbox: { hostWorkspace: workspace, backend: 'opencode', mounts: [] },
    onVisibleText: (text) => visible.push(text)
  });
  assert.deepEqual(result, { outputText: 'exported final', continuation: { sessionId: 'session-test' } });
  assert.equal(visible.join(''), 'native progress\n');
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
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
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
