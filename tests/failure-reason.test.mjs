import assert from 'node:assert/strict';
import test from 'node:test';

import { failureError } from '../src/coding-agents/failure-reason.mjs';
import { codexFailure } from '../src/coding-agents/agents/codex/failure.mjs';
import { createClaudeFailureTracker } from '../src/coding-agents/agents/claude/failure.mjs';
import { openCodeFailure } from '../src/coding-agents/agents/opencode/failure.mjs';

test('Codex usage limits and HTTP failures are named from codexErrorInfo', () => {
  const limit = failureError('You have hit your usage limit.', codexFailure({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }));
  assert.equal(limit.message, 'You have hit your usage limit. [reason: usage limit exceeded]');
  assert.equal(limit.failure.code, 'usageLimitExceeded');
  const http = codexFailure({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } });
  assert.deepEqual(http, { agent: 'codex', code: 'responseStreamDisconnected', reason: 'response stream disconnected', httpStatus: 502 });
  assert.equal(codexFailure({ message: 'plain' }), null);
  assert.equal(failureError('Codex turn failed.', null).message, 'Codex turn failed.');
  assert.equal(failureError('Codex turn failed.', null).failure, undefined);
});

test('Claude Code names a rejected plan limit with its window and reset time', () => {
  const tracker = createClaudeFailureTracker();
  tracker.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' } });
  assert.equal(tracker.failure(), null);
  tracker.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1795303369 } });
  tracker.push({ type: 'result', is_error: true, api_error_status: 429 });
  const error = failureError('Claude Code turn failed: limit', tracker.failure());
  assert.equal(error.message, 'Claude Code turn failed: limit [reason: usage limit reached (five hour), HTTP 429, resets at 2026-11-21T23:22:49.000Z]');
  const other = createClaudeFailureTracker();
  other.push({ type: 'result', is_error: true, api_error_status: 529 });
  assert.deepEqual(other.failure(), { agent: 'claude', code: 'api_error', reason: 'provider error', httpStatus: 529 });
});

test('OpenCode names the provider status and the error type of its response body', () => {
  const free = openCodeFailure({ name: 'APIError', data: { message: 'Usage limit reached for 5 hour.', statusCode: 429,
    responseBody: JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'limit' } }) } });
  assert.deepEqual(free, { agent: 'opencode', code: 'FreeUsageLimitError', reason: 'free usage limit error', httpStatus: 429 });
  assert.equal(failureError('OpenCode session failed: Usage limit reached for 5 hour.', free).message,
    'OpenCode session failed: Usage limit reached for 5 hour. [reason: free usage limit error, HTTP 429]');
  assert.deepEqual(openCodeFailure({ name: 'APIError', data: { statusCode: 500, responseBody: 'not json' } }),
    { agent: 'opencode', code: 'api_error', reason: 'provider error', httpStatus: 500 });
  assert.equal(openCodeFailure({ name: 'ProviderAuthError', data: { providerID: 'openai' } }).reason, 'provider authentication failed (openai)');
  assert.equal(openCodeFailure({ name: 'UnknownError', data: { message: 'x' } }), null);
});
