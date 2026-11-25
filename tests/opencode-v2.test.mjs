import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOpenCodeV2Turn } from '../src/coding-agents/agents/opencode/v2-turn.mjs';
import { openCodeV2Environment, openCodeV2Model } from '../src/coding-agents/agents/opencode/v2-contract.mjs';
import { createPermissionRequestManager } from '../src/permission-requests.mjs';
import { requireOpenCodeVersion } from '../src/coding-agents/agents/opencode/server.mjs';
import { requireOpenCodeV2Api } from '../src/coding-agents/agents/opencode/v2-contract.mjs';

test('newer OpenCode majors are admitted by version and still require a compatible API', () => {
  for (const version of ['2.4.1', '3.0.0', '10.1.2']) {
    assert.equal(requireOpenCodeVersion(`opencode v${version}`), version);
  }
  assert.throws(() => requireOpenCodeVersion('1.14.0'));
  assert.throws(() => requireOpenCodeV2Api({ paths: {} }), /Unsupported OpenCode V2 server API/);
});

function fixture({ rejectResume = false, permission = false, disconnect = false } = {}) {
  let stream, promptID, rules;
  const calls = [];
  const send = (type, data) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\n\n`));
  const complete = () => {
    send('session.text.delta', { sessionID: 'ses_old', assistantMessageID: 'msg_answer', delta: 'new answer' });
    send('session.execution.succeeded', { sessionID: 'ses_old' });
  };
  const server = {
    signal: new AbortController().signal, failure: new Promise(() => {}), workspace: '/project',
    async request(path, options = {}) {
      calls.push([path, options.body]);
      if (path === '/api/event') {
        const body = new ReadableStream({ start(controller) {
          stream = controller;
          options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/api/session/ses_old') {
        if (rejectResume) throw new Error('session not found');
        if (options.method === 'PATCH') { rules = options.body.permissions; return null; }
        return { data: { id: 'ses_old', permissions: rules } };
      }
      if (path.endsWith('/model')) return null;
      if (path.endsWith('/prompt')) {
        promptID = options.body.id;
        if (disconnect) stream.close();
        else if (permission) send('permission.asked', {
          id: 'per_test', sessionID: 'ses_old', action: 'edit', resources: ['file.txt'], save: ['file.txt']
        });
        else complete();
        return { data: { id: promptID } };
      }
      if (path.endsWith('/reply')) { complete(); return null; }
      if (path.includes('/message?')) return { data: [
        { id: 'msg_answer', type: 'assistant', time: { completed: 1 }, content: [{ type: 'text', text: 'new answer' }] },
        { id: promptID, type: 'user' },
        { id: 'msg_old', type: 'assistant', content: [{ type: 'text', text: 'old answer' }] }
      ], cursor: {} };
      if (path.endsWith('/interrupt')) return {};
      throw new Error(`unexpected route ${path}`);
    }
  };
  return { server, calls };
}

test('V2 resumes exact native ID, sets policy/model before prompt and reads only this turn', async () => {
  const { server, calls } = fixture();
  const result = await executeOpenCodeV2Turn(server, { continuation: { sessionId: 'ses_old' },
    prompt: 'continue', model: 'provider/model', effort: 'high', websearch: true });
  assert.deepEqual(result, { outputText: 'new answer', continuation: { sessionId: 'ses_old' } });
  assert.equal(calls.some(([path]) => path === '/api/session'), false);
  assert.deepEqual(calls.find(([path]) => path.endsWith('/model'))[1], {
    model: { providerID: 'provider', id: 'model', variant: 'high' }
  });
});

test('V2 never creates a replacement for a missing saved session', async () => {
  const { server, calls } = fixture({ rejectResume: true });
  await assert.rejects(executeOpenCodeV2Turn(server, { continuation: { sessionId: 'ses_old' }, prompt: 'continue' }),
    /session not found/);
  assert.equal(calls.some(([path]) => path.endsWith('/prompt') || path === '/api/session'), false);
});

test('V2 replies to native approval without exposing a native ID as the host choice', async () => {
  const { server, calls } = fixture({ permission: true });
  const manager = createPermissionRequestManager({ eventSink: event => {
    if (event.type === 'coding-agent-request') {
      assert.notEqual(event.id, 'per_test');
      manager.resolve({ id: event.id, optionId: 'deny' });
    }
  }, logger: { warn() {} } });
  manager.setReplyCapability(true);
  await executeOpenCodeV2Turn(server, { continuation: { sessionId: 'ses_old' }, prompt: 'edit',
    permissionMode: 'ask-for-approval', permissionRequests: manager });
  assert.deepEqual(calls.find(([path]) => path.endsWith('/reply'))[1], { decision: 'reject' });
});

test('V2 stream loss interrupts the native session and retains continuation', async () => {
  const { server, calls } = fixture({ disconnect: true });
  await assert.rejects(executeOpenCodeV2Turn(server, { continuation: { sessionId: 'ses_old' }, prompt: 'run' }),
    error => error.continuation.sessionId === 'ses_old');
  assert.ok(calls.some(([path]) => path.endsWith('/interrupt')));
});

test('V2 transient MCP overlay preserves user configuration and native model variants', () => {
  const config = { providers: { custom: {} }, mcp: { servers: { saved: { type: 'remote', url: 'https://saved' } } } };
  const env = openCodeV2Environment({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, true,
    [{ name: 'desktop', url: 'http://localhost:8100/mcp' }]);
  const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(overlay.providers, config.providers);
  assert.deepEqual(overlay.mcp.servers.saved, config.mcp.servers.saved);
  assert.equal(overlay.mcp.servers.desktop.oauth, false);
  assert.deepEqual(openCodeV2Model('provider/model#high'), { providerID: 'provider', id: 'model', variant: 'high' });
});
