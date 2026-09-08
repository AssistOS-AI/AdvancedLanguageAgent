import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOpenCode } from '../src/coding-agents/opencode.mjs';
import { openCodeEnvironment } from '../src/coding-agents/opencode-server.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { createPermissionRequestManager } from '../src/permission-requests.mjs';

const sandboxSupported = canStartBubblewrap();
const nativeTest = (name, callback) => test(name, {
  skip: sandboxSupported ? false : 'Bubblewrap cannot start in this test process'
}, callback);
const fixture = fileURLToPath(new URL('./fixtures/opencode-server.mjs', import.meta.url));
const configBytes = '{"model":"keep/model","permission":{"external_directory":"deny"}}\n';

async function setup(context, onRequest = null, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-server-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await Promise.all([mkdir(workspace), mkdir(home)]);
  await writeFile(join(workspace, 'opencode.json'), configBytes);
  await writeFile(join(workspace, 'fixture-options.json'), JSON.stringify(options));
  const events = [];
  const warnings = [];
  const permissionRequests = createPermissionRequestManager({
    eventSink: (event) => {
      events.push(event);
      if (event.type === 'coding-agent-request') onRequest?.(event, permissionRequests);
    },
    logger: { warn: (message) => warnings.push(message) }
  });
  permissionRequests.setReplyCapability(Boolean(onRequest));
  const input = {
    binary: fixture, prompt: 'historical-idle', workspace: '/workspace', hostWorkspace: workspace,
    websearch: false, env: { HOME: home }, permissionMode: 'ask-for-approval', permissionRequests,
    sandbox: { hostWorkspace: workspace, backend: 'opencode', mounts: [], home },
    onSession: async ({ sessionId }) => writeFile(join(workspace, 'persisted-before-work'), sessionId)
  };
  const records = async () => (await readFile(join(workspace, 'native-events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const unchanged = async () => assert.equal(await readFile(join(workspace, 'opencode.json'), 'utf8'), configBytes);
  const stopped = async () => {
    const address = await readFile(join(workspace, 'server-address'), 'utf8');
    await assert.rejects(fetch(`${address}/global/health`, { signal: AbortSignal.timeout(1000) }));
  };
  return { input, workspace, records, unchanged, stopped, events, warnings };
}

nativeTest('ignores historical idle and old assistant text, then stops its authenticated server', async (context) => {
  const run = await setup(context);
  const visible = [];
  const result = await runOpenCode({ ...run.input, model: 'provider/model/variant',
    onVisibleText: (text) => visible.push(text) });
  assert.deepEqual(result, { outputText: 'current turn, not historical text', continuation: { sessionId: 'ses_owned' } });
  assert.equal(visible.join(''), result.outputText);
  const log = await run.records();
  assert.equal(log.filter((event) => event.type === 'prompt').length, 1);
  assert.equal(log.some((event) => event.type === 'abort'), false);
  await run.stopped();
  await run.unchanged();
});

nativeTest('denies child-session native mutation, resumes the same session and grants only a new request', async (context) => {
  let choice = 'deny';
  const run = await setup(context, (event, manager) => {
    assert.equal(event.detail.permission, 'edit');
    assert.deepEqual(event.detail.patterns, ['scratch.txt']);
    manager.resolve({ id: event.id, optionId: choice });
  });
  const denied = await runOpenCode({ ...run.input, prompt: 'permission' });
  assert.equal(denied.outputText, 'mutation denied');
  await assert.rejects(access(join(run.workspace, 'scratch.txt')), { code: 'ENOENT' });
  choice = 'allow-once';
  const allowed = await runOpenCode({ ...run.input, prompt: 'permission', continuation: denied.continuation });
  assert.equal(allowed.outputText, 'mutation approved');
  assert.deepEqual(allowed.continuation, denied.continuation);
  assert.equal(await readFile(join(run.workspace, 'scratch.txt'), 'utf8'), 'allowed mutation');
  const log = await run.records();
  assert.deepEqual(log.filter((event) => event.type === 'reply').map((event) => event.reply), ['reject', 'once']);
  assert.equal(log.filter((event) => event.type === 'create').length, 1);
  assert.equal(log.filter((event) => event.type === 'update').length, 1);
  assert.equal(run.events.filter((event) => event.type === 'coding-agent-request').length, 2);
  await run.unchanged();
});

nativeTest('reconciles missed child approval events and sends native always without reusing a UI request ID', async (context) => {
  const run = await setup(context, (event, manager) => {
    assert.notEqual(event.id, 'per_native');
    assert.match(event.options.find((option) => option.id === 'allow-session').description, /\*\.txt/u);
    manager.resolve({ id: event.id, optionId: 'allow-session' });
  });
  const result = await runOpenCode({ ...run.input, prompt: 'missed-event' });
  assert.equal(result.outputText, 'mutation approved');
  assert.deepEqual((await run.records()).filter((event) => event.type === 'reply').map((event) => event.reply), ['always']);
});

nativeTest('dismisses backend-resolved approvals without sending a second reply or aborting continuation', async (context) => {
  const run = await setup(context, () => {});
  const result = await runOpenCode({ ...run.input, prompt: 'backend-resolved' });
  assert.equal(result.outputText, 'native request resolved elsewhere');
  assert.equal(run.events.find((event) => event.type === 'coding-agent-request-resolved').reason, 'backend-resolved');
  assert.equal((await run.records()).some((event) => ['reply', 'abort'].includes(event.type)), false);
});

nativeTest('cancels pending approval by aborting owned root and child sessions and stopping its server', async (context) => {
  const run = await setup(context, (event, manager) => manager.resolve({ id: event.id, cancelled: true }));
  await assert.rejects(runOpenCode({ ...run.input, prompt: 'permission' }), { name: 'AbortError' });
  const log = await run.records();
  assert.deepEqual(log.filter((event) => event.type === 'abort').map((event) => event.sessionID).sort(),
    ['ses_child', 'ses_owned']);
  await run.stopped();
  await assert.rejects(access(join(run.workspace, 'scratch.txt')), { code: 'ENOENT' });
});

nativeTest('aborts a running native turn on control loss and dismisses the pending host request', async (context) => {
  const run = await setup(context, (event, manager) => manager.setReplyCapability(false));
  await assert.rejects(runOpenCode({ ...run.input, prompt: 'permission' }), { name: 'AbortError' });
  assert.equal(run.events.find((event) => event.type === 'coding-agent-request-resolved').reason, 'cancelled');
  await run.stopped();
});

nativeTest('declines when no reply-capable host exists rather than auto-approving', async (context) => {
  const run = await setup(context);
  const result = await runOpenCode({ ...run.input, prompt: 'permission' });
  assert.equal(result.outputText, 'mutation denied');
  assert.match(run.warnings.join('\n'), /control-capable host/u);
  assert.equal(run.events.length, 0);
  await assert.rejects(access(join(run.workspace, 'scratch.txt')), { code: 'ENOENT' });
});

nativeTest('SSE loss fails instead of reporting HTTP acceptance as success and preserves saved continuation', async (context) => {
  const run = await setup(context);
  await assert.rejects(runOpenCode({ ...run.input, prompt: 'stream-failure' }), (error) => {
    assert.match(error.message, /event stream closed/u);
    assert.deepEqual(error.continuation, { sessionId: 'ses_owned' });
    return true;
  });
  const log = await run.records();
  assert.equal(log.some((event) => event.type === 'abort' && event.sessionID === 'ses_owned'), true);
  await run.stopped();
  await run.unchanged();
});

nativeTest('incompatible served API fails before native session creation or model work', async (context) => {
  const run = await setup(context, null, { incompatible: true });
  await assert.rejects(runOpenCode(run.input), /OPENCODE_BIN/u);
  assert.equal((await run.records()).some((event) => ['create', 'prompt'].includes(event.type)), false);
  await run.stopped();
  await run.unchanged();
});

nativeTest('preserves actionable native provider failure details and stops its server', async (context) => {
  const run = await setup(context);
  await assert.rejects(runOpenCode({ ...run.input, prompt: 'provider-failure' }), /authentication required/u);
  await run.stopped();
});

nativeTest('applies resumed full-access to ask mode change before any new mutation', async (context) => {
  const run = await setup(context, (event, manager) => manager.resolve({ id: event.id, optionId: 'deny' }));
  const first = await runOpenCode({ ...run.input, prompt: 'permission', permissionMode: 'full-access' });
  assert.equal(first.outputText, 'mutation approved');
  assert.equal(run.events.length, 0);
  await writeFile(join(run.workspace, 'scratch.txt'), 'must stay');
  const second = await runOpenCode({ ...run.input, prompt: 'permission', continuation: first.continuation });
  assert.equal(second.outputText, 'mutation denied');
  assert.equal(await readFile(join(run.workspace, 'scratch.txt'), 'utf8'), 'must stay');
  assert.equal(run.events.filter((event) => event.type === 'coding-agent-request').length, 1);
  await run.unchanged();
});

nativeTest('surfaces a refused native permission policy before prompting and preserves the native session', async (context) => {
  const run = await setup(context, null, { refusePolicy: true });
  await assert.rejects(runOpenCode(run.input), (error) => {
    assert.match(error.message, /refused.*ask-for-approval/u);
    assert.deepEqual(error.continuation, { sessionId: 'ses_owned' });
    return true;
  });
  assert.equal((await run.records()).some((event) => event.type === 'prompt'), false);
  assert.equal(await readFile(join(run.workspace, 'persisted-before-work'), 'utf8'), 'ses_owned');
});

test('process-only web overlay preserves unrelated configuration and does not force allow when web is enabled', () => {
  const original = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'provider/kept',
    permission: { external_directory: 'deny', webfetch: 'ask' } }) };
  const enabled = JSON.parse(openCodeEnvironment(original, true).OPENCODE_CONFIG_CONTENT);
  const disabled = JSON.parse(openCodeEnvironment(original, false).OPENCODE_CONFIG_CONTENT);
  assert.equal(enabled.model, 'provider/kept');
  assert.equal(enabled.permission.webfetch, 'ask');
  assert.equal(disabled.permission.webfetch, 'deny');
  assert.equal(disabled.permission.websearch, 'deny');
  assert.equal(disabled.permission.external_directory, 'deny');
  assert.equal(JSON.parse(original.OPENCODE_CONFIG_CONTENT).permission.webfetch, 'ask');
});
