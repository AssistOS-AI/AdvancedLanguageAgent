import test from 'node:test';
import assert from 'node:assert/strict';

import { createPermissionRequestManager } from '../src/permission-requests.mjs';

const request = {
  agent: 'codex', method: 'item/commandExecution/requestApproval', title: 'Run command',
  message: 'Write scratch.txt', detail: { command: 'touch scratch.txt' },
  options: [{ id: 'choice-allow', label: 'Allow' }, { id: 'choice-deny', label: 'Deny' }]
};

function manager() {
  const events = [];
  const warnings = [];
  const requests = createPermissionRequestManager({
    eventSink: (event) => events.push(event), logger: { warn: (message) => warnings.push(message) }
  });
  return { requests, events, warnings };
}

test('correlates concurrent choices and refuses invalid or replayed responses without answering another request', async () => {
  const { requests, events, warnings } = manager();
  requests.setReplyCapability(true);
  const first = requests.request(request);
  const second = requests.request(request);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
  assert.throws(() => requests.resolve({ id: first.id, optionId: 'choice-allow', cancelled: true }));
  assert.throws(() => requests.resolve({ id: first.id, optionId: 'native-accept' }));
  assert.throws(() => requests.resolve({ id: first.id, cancelled: false }));
  assert.equal(events.filter((event) => event.type === 'coding-agent-request-resolved').length, 0);
  requests.resolve({ id: second.id, optionId: 'choice-deny' });
  assert.equal(await second, 'choice-deny');
  assert.throws(() => requests.resolve({ id: second.id, optionId: 'choice-allow' }), /stale/);
  requests.resolve({ id: first.id, optionId: 'choice-allow' });
  assert.equal(await first, 'choice-allow');
  assert.deepEqual(events.filter((event) => event.type === 'coding-agent-request-resolved').map(({ id, reason }) =>
    ({ id, reason })), [{ id: second.id, reason: 'answered' }, { id: first.id, reason: 'answered' }]);
  assert.equal(warnings.length, 4);
});

test('without an explicitly attached reply channel declines visibly and never leaves a pending approval', async () => {
  const { requests, events, warnings } = manager();
  const cancellations = [];
  const result = requests.request(request, { onCancel: (reason) => cancellations.push(reason) });
  assert.equal(await result, null);
  assert.deepEqual(cancellations, ['control-unavailable']);
  assert.match(warnings[0], /control-capable host/);
  assert.deepEqual(events, []);
  assert.throws(() => requests.resolve({ id: result.id, optionId: 'choice-allow' }), /stale/);
});

test('control loss clears every pending request once and later requests remain fail-closed', async () => {
  const { requests, events } = manager();
  requests.setReplyCapability(true);
  let cancellations = 0;
  const first = requests.request(request, { onCancel: () => { cancellations += 1; } });
  const second = requests.request(request, { onCancel: () => { cancellations += 1; } });
  requests.setReplyCapability(false);
  requests.cancelAll('cancelled');
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(cancellations, 2);
  assert.deepEqual(events.filter((event) => event.type === 'coding-agent-request-resolved').map((event) => event.reason),
    ['cancelled', 'cancelled']);
  assert.equal(await requests.request(request), null);
});

test('native resolution dismisses a host request without cancelling the already resolved backend operation', async () => {
  const { requests, events } = manager();
  requests.setReplyCapability(true);
  let cancelled = false;
  const answer = requests.request(request, { onCancel: () => { cancelled = true; } });
  requests.cancel(answer.id, 'backend-resolved');
  assert.equal(await answer, null);
  assert.equal(cancelled, false);
  assert.deepEqual(events.at(-1), { type: 'coding-agent-request-resolved', id: answer.id, reason: 'backend-resolved' });
  assert.throws(() => requests.resolve({ id: answer.id, optionId: 'choice-allow' }), /stale/);
});

test('abort and turn expiry settle pending approvals rather than retaining callbacks into the next turn', async () => {
  const { requests, events } = manager();
  requests.setReplyCapability(true);
  const controller = new AbortController();
  const reasons = [];
  const interrupted = requests.request(request, { signal: controller.signal, onCancel: (reason) => reasons.push(reason) });
  controller.abort();
  const expired = requests.request(request, { onCancel: (reason) => reasons.push(reason) });
  requests.cancelAll('expired');
  assert.deepEqual(await Promise.all([interrupted, expired]), [null, null]);
  assert.deepEqual(reasons, ['cancelled', 'expired']);
  assert.deepEqual(events.filter((event) => event.type === 'coding-agent-request-resolved').map((event) => event.reason),
    ['cancelled', 'expired']);
});
