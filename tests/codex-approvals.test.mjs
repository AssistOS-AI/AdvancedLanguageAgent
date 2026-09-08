import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPermissionRequestManager } from '../src/permission-requests.mjs';
import { attachCodexApprovals, codexApprovalChoices, verifyCodexPolicy, codexThreadPolicy }
  from '../src/coding-agents/codex-approvals.mjs';
import { buildCodexArguments } from '../src/coding-agents/codex.mjs';

function fixture() {
  const events = [];
  const responses = [];
  const errors = [];
  let interruptions = 0;
  const permissionRequests = createPermissionRequestManager({ eventSink: (event) => events.push(event),
    logger: { warn() {} } });
  permissionRequests.setReplyCapability(true);
  const rpc = { events: new EventEmitter(), respond: (id, result) => responses.push({ id, result }),
    respondError: (id, error) => errors.push({ id, error }) };
  const adapter = attachCodexApprovals({ rpc, input: { permissionRequests },
    interrupt: () => { interruptions += 1; }, fail: (error) => errors.push(error) });
  const request = (id, method = 'item/commandExecution/requestApproval', params = {}) => {
    rpc.events.emit('request', { id, method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', ...params } });
    return events.findLast((event) => event.type === 'coding-agent-request');
  };
  return { events, responses, errors, rpc, adapter, permissionRequests, request,
    get interruptions() { return interruptions; } };
}

test('Codex does not authorize an operation while pending or after denial', async (t) => {
  const f = fixture(); t.after(() => f.adapter.close());
  const event = f.request(1, undefined, { command: 'touch scratch', availableDecisions: ['accept', 'decline'] });
  let sideEffect = false;
  await Promise.resolve();
  assert.deepEqual(f.responses, []);
  f.permissionRequests.resolve({ id: event.id, optionId: event.options.find((option) => option.label === 'Deny').id });
  await Promise.resolve();
  if (f.responses[0].result.decision === 'accept') sideEffect = true;
  assert.equal(sideEffect, false);
  assert.deepEqual(f.responses, [{ id: 1, result: { decision: 'decline' } }]);
  assert.throws(() => f.permissionRequests.resolve({ id: event.id, optionId: event.options[0].id }), /stale/);
  assert.equal(f.responses.length, 1);
});

test('Codex exposes only advertised decisions and preserves exact policy amendment scope', () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } };
  const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.org', action: 'deny' } } };
  const choices = codexApprovalChoices('item/commandExecution/requestApproval', {
    availableDecisions: ['decline', amendment, network], proposedExecpolicyAmendment: ['bash']
  });
  assert.deepEqual(choices.map((choice) => choice.result.decision), ['decline', amendment, network]);
  assert.match(choices[1].description, /git/);
  assert.match(choices[2].description, /example.org/);
  assert.throws(() => codexApprovalChoices('item/commandExecution/requestApproval', { availableDecisions: [] }), /no approval/);
  assert.throws(() => codexApprovalChoices('item/commandExecution/requestApproval', {
    availableDecisions: ['invented-always']
  }), /unsupported/);
});

test('permission profile grants preserve requested scope without command decision enums', () => {
  const permissions = { fileSystem: { write: ['/workspace/scratch'], read: ['/workspace/input'] },
    network: { enabled: false } };
  const choices = codexApprovalChoices('item/permissions/requestApproval', { permissions });
  assert.deepEqual(choices.map((choice) => choice.result), [
    { permissions: {}, scope: 'turn' }, { permissions, scope: 'turn' }, { permissions, scope: 'session' }
  ]);
});

test('file approval includes matching item paths and diff, not unrelated item metadata', (t) => {
  const f = fixture(); t.after(() => f.adapter.close());
  f.rpc.events.emit('event', { method: 'item/started', params: { threadId: 'thread', turnId: 'turn',
    item: { id: 'item', type: 'fileChange', changes: [{ path: '/workspace/scratch', diff: '+approved content' }] } } });
  f.rpc.events.emit('event', { method: 'item/started', params: { threadId: 'other', turnId: 'turn',
    item: { id: 'item', type: 'fileChange', changes: [{ path: '/workspace/unrelated' }] } } });
  const event = f.request(4, 'item/fileChange/requestApproval', { grantRoot: '/workspace' });
  assert.match(event.detail, /scratch/);
  assert.match(event.detail, /approved content/);
  assert.doesNotMatch(event.detail, /unrelated/);
  assert.match(event.detail, /grantRoot/);
});

for (const completion of ['resolved', 'turn', 'failure']) {
  test(`native ${completion} dismisses pending host requests without a late native answer`, async (t) => {
    const f = fixture(); t.after(() => f.adapter.close());
    const event = f.request(7);
    if (completion === 'resolved') {
      f.rpc.events.emit('event', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: '7' } });
      assert.equal(f.events.filter((entry) => entry.type === 'coding-agent-request-resolved').length, 0);
      f.rpc.events.emit('event', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 7 } });
    } else if (completion === 'turn') {
      f.rpc.events.emit('event', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
    } else f.rpc.events.emit('failure', new Error('server exited'));
    await Promise.resolve();
    assert.equal(f.events.at(-1).reason, 'backend-resolved');
    assert.equal(f.interruptions, 0);
    assert.deepEqual(f.responses, []);
    assert.throws(() => f.permissionRequests.resolve({ id: event.id, optionId: event.options[0].id }), /stale/);
  });
}

test('host cancellation and control loss interrupt rather than grant permissions', async (t) => {
  const f = fixture(); t.after(() => f.adapter.close());
  const event = f.request(8, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
  f.permissionRequests.resolve({ id: event.id, cancelled: true });
  await Promise.resolve();
  assert.ok(f.interruptions > 0);
  assert.deepEqual(f.responses, [{ id: 8, result: { permissions: {}, scope: 'turn' } }]);
  f.request(9);
  f.permissionRequests.setReplyCapability(false);
  await Promise.resolve();
  assert.deepEqual(f.responses.at(-1), { id: 9, result: { decision: 'cancel' } });
});

test('unsupported user input fails visibly without approval choices', async (t) => {
  const f = fixture(); t.after(() => f.adapter.close());
  f.request(10, 'item/tool/requestUserInput');
  await Promise.resolve();
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.responses, []);
  assert.equal(f.errors[0].error.code, -32601);
  assert.match(f.errors[1].message, /Unsupported Codex native request/);
});

test('Codex rejects a changed effective policy and cannot use exec for ask mode', () => {
  const requested = codexThreadPolicy('ask-for-approval');
  assert.throws(() => verifyCodexPolicy({ approvalPolicy: 'never', approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' } }, requested), /refused/);
  assert.throws(() => verifyCodexPolicy({ ...requested, approvalsReviewer: 'guardian_subagent',
    sandbox: { type: 'dangerFullAccess' } }, requested), /refused/);
  assert.throws(() => buildCodexArguments({ prompt: 'work', permissionMode: 'ask-for-approval' }), /app-server/);
});
