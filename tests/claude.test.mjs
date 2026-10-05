import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildClaudeArguments, listClaudeModels, requireClaudeVersion, runClaude } from '../src/coding-agents/claude.mjs';
import { collectAgentStateMounts, sandboxEnvironment } from '../src/coding-agents/sandbox.mjs';

const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function harness(t, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-claude-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'args.log');
  const fullEnv = { ...process.env, FAKE_CLAUDE_LOG: log, ...env };
  // Tests run the fake CLI directly; production always runs inside Bubblewrap.
  const spawnImpl = ({ binary, args, cwd, stdio }) => spawn(binary, args, { cwd, stdio, env: fullEnv });
  const calls = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { root, calls, input: { binary: fake, workspace: root, hostWorkspace: root, env: fullEnv, spawnImpl } };
}

test('arguments select a new or resumed session, permissions, model, effort and MCP servers', () => {
  assert.deepEqual(buildClaudeArguments({ sessionId: 's1' }), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--session-id', 's1', '--permission-mode', 'bypassPermissions']);
  const resumed = buildClaudeArguments({ sessionId: 's1', resume: true, model: 'opus', effort: 'high', permissionMode: 'ask-for-approval',
    mcpServers: [{ name: 'browser', url: 'http://127.0.0.1:48100/mcp' }] });
  assert.deepEqual(resumed.slice(7), ['--resume', 's1', '--model', 'opus', '--effort', 'high',
    '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--mcp-config', JSON.stringify({ mcpServers: { browser: { type: 'http', url: 'http://127.0.0.1:48100/mcp' } } }), '--strict-mcp-config']);
});

test('a turn streams assistant text and tool output, reports the session and returns the result', async (t) => {
  const h = await harness(t);
  const visible = [];
  const sessions = [];
  const result = await runClaude({ ...h.input, prompt: 'Do it TOOL', permissionMode: 'full-access',
    onVisibleText: (text, metadata) => visible.push([text, metadata]), onSession: (value) => sessions.push(value) });
  assert.match(result.outputText, /^final:Do it TOOL:none$/);
  assert.deepEqual(sessions, [result.continuation]);
  assert.match(result.continuation.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(visible.filter(([, metadata]) => metadata.outputKind === 'assistant').map(([text, metadata]) => [text, metadata.outputId, Boolean(metadata.outputComplete)]),
    [['Working ', 'msg_1', false], ['on it.', 'msg_1', false], ['', 'msg_1', true]]);
  assert.deepEqual(visible.filter(([, metadata]) => metadata.outputKind === 'output').map(([text]) => text),
    ['Write: {"file_path":"probe.txt","content":"hello"}\n', 'File created\n']);
  const [args] = (await h.calls()).filter((call) => call[0] === '-p');
  assert.equal(args[args.indexOf('--session-id') + 1], result.continuation.sessionId);
});

test('a continued turn resumes the saved native session', async (t) => {
  const h = await harness(t);
  const continuation = { sessionId: '11111111-2222-4333-8444-555555555555' };
  const result = await runClaude({ ...h.input, prompt: 'Again', continuation });
  assert.deepEqual(result.continuation, continuation);
  const [args] = (await h.calls()).filter((call) => call[0] === '-p');
  assert.equal(args[args.indexOf('--resume') + 1], continuation.sessionId);
  assert.equal(args.includes('--session-id'), false);
});

test('ask-for-approval routes permission prompts to the host and returns its decision', async (t) => {
  for (const [optionId, behavior] of [['allow', 'allow'], ['deny', 'deny']]) {
    const h = await harness(t);
    const asked = [];
    const permissionRequests = { request(request) { asked.push(request); const promise = Promise.resolve(optionId); promise.id = 'host-1'; return promise; }, cancel() {} };
    const result = await runClaude({ ...h.input, prompt: 'Write TOOL', permissionMode: 'ask-for-approval', permissionRequests });
    assert.equal(result.outputText, `final:Write TOOL:${behavior}`);
    assert.equal(asked[0].agent, 'claude');
    assert.equal(asked[0].title, 'Claude Code: Write');
    assert.deepEqual(asked[0].options.map((option) => option.id), ['allow', 'deny']);
    assert.match(asked[0].detail, /probe\.txt/);
  }
});

test('messages sent while a turn runs are delivered and the turn ends after their result', async (t) => {
  const h = await harness(t);
  let send;
  const result = await runClaude({ ...h.input, prompt: 'First TOOL', permissionMode: 'ask-for-approval',
    permissionRequests: { request() { const promise = (async () => { assert.deepEqual(await send('Second'), { delivery: 'delivered' }); return 'allow'; })(); promise.id = 'h'; return promise; }, cancel() {} },
    setMessageHandler: (handler) => { if (handler) send = handler; } });
  assert.equal(result.outputText, 'final:Second:none');
});

test('a failed turn reports the error and keeps the native session for continuation', async (t) => {
  const h = await harness(t);
  await assert.rejects(runClaude({ ...h.input, prompt: 'FAIL now' }), (error) => {
    assert.match(error.message, /Claude Code turn failed: boom/);
    assert.match(error.continuation.sessionId, /^[0-9a-f-]{36}$/);
    return true;
  });
});

test('an old Claude Code version is rejected before any session starts', async (t) => {
  const h = await harness(t, { FAKE_CLAUDE_VERSION: '1.0.99 (Claude Code)' });
  await assert.rejects(requireClaudeVersion(h.input), /version 1\.0\.99 \(Claude Code\) is incompatible/);
  await assert.rejects(runClaude({ ...h.input, prompt: 'x' }), /incompatible/);
});

test('models and their effort levels come from the initialize control response', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await listClaudeModels({ ...h.input }), ['opus', 'haiku']);
  assert.deepEqual(await listClaudeModels({ ...h.input, details: true }), [
    { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] },
    { id: 'haiku', label: 'Haiku 4.5', efforts: [] },
  ]);
});

test('the sandbox gives Claude Code its own state directory and only Anthropic credentials', async (t) => {
  const env = sandboxEnvironment('claude', [], { CLAUDE_CODE_OAUTH_TOKEN: 'token', ANTHROPIC_API_KEY: 'key', OPENAI_API_KEY: 'other' });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/ala/.claude');
  assert.equal(env.IS_SANDBOX, '1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'token');
  assert.equal(env.ANTHROPIC_API_KEY, 'key');
  assert.equal(env.OPENAI_API_KEY, undefined);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-claude-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.claude'));
  assert.deepEqual(collectAgentStateMounts('claude', { HOME: home }).map((mount) => [mount.target, mount.writable]), [['/home/ala/.claude', true]]);
});
