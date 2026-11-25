import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startOpenCodeServer } from '../src/coding-agents/agents/opencode/server.mjs';
import { executeOpenCodeV2Turn } from '../src/coding-agents/agents/opencode/v2-turn.mjs';

// Opt-in native contract test. The only selected model is this process's loopback mock; no subscription is used.
test('released V2 executes and resumes through the adapter with a local fake provider', {
  skip: !process.env.ALA_TEST_OPENCODE_V2_BIN, timeout: 60000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-v2-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const provider = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Local V2 works' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
    ]) {
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'mock', ...item
      })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const config = {
    update: 'disable', model: 'local/mock', agents: { title: { model: 'local/mock' } },
    providers: {
      local: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'test' },
        models: { mock: { name: 'Mock', limit: { context: 32000, output: 4096 },
          capabilities: { tools: true, input: ['text'], output: ['text'] } } }
      }
    }
  };
  const env = { HOME: root, XDG_CONFIG_HOME: `${root}/.config`, XDG_DATA_HOME: `${root}/.local/share`,
    XDG_CACHE_HOME: `${root}/.cache`, XDG_STATE_HOME: `${root}/.local/state`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  const input = { binary: process.env.ALA_TEST_OPENCODE_V2_BIN, workspace: root, env, websearch: false,
    signal: AbortSignal.timeout(45000) };
  let server = await startOpenCodeServer(input);
  let first;
  try {
    first = await executeOpenCodeV2Turn(server, { prompt: 'Say hello', model: 'local/mock', websearch: false });
    assert.equal(first.outputText, 'Local V2 works');
  } finally { await server.stop(); }
  server = await startOpenCodeServer(input);
  try {
    const second = await executeOpenCodeV2Turn(server, {
      prompt: 'Continue', model: 'local/mock', websearch: false, continuation: first.continuation
    });
    assert.equal(second.outputText, 'Local V2 works');
    assert.deepEqual(second.continuation, first.continuation);
    assert.ok(calls >= 2);
  } finally { await server.stop(); }
});
