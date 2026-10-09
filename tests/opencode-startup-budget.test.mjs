import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import * as serverModule from '../src/coding-agents/opencode-server.mjs';

const fixture = fileURLToPath(new URL('./fixtures/opencode-server.mjs', import.meta.url));
const TIMED_OUT = /OpenCode HTTP request timed out\./u;

// The fake OpenCode holds the first request to `hold` until the test writes a release file, so the test controls
// how long bootstrap "takes" through mocked timers instead of real waiting. Timers are mocked before any request.
async function launch(context, hold) {
  const root = await mkdtemp(join(tmpdir(), 'ala-opencode-startup-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'fixture-options.json'), JSON.stringify({ anyDirectory: true, hold }));
  const state = { server: null };
  context.after(async () => {
    mock.timers.reset();
    await state.server?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  return {
    state,
    start: (extra = {}) => serverModule.startOpenCodeServer({
      binary: fixture, workspace, env: { HOME: root }, websearch: false, ...extra
    }),
    async held() {
      for (let index = 0; index < 500 && !existsSync(join(workspace, 'held')); index += 1) await sleep(10);
      assert.ok(existsSync(join(workspace, 'held')), 'fake OpenCode never received the held request');
    },
    release: () => writeFile(join(workspace, 'release'), '1')
  };
}

test('startup waits on a slow first request for 20 s of bootstrap instead of failing at 15 s', async (context) => {
  const run = await launch(context, '/global/health');
  const starting = run.start();
  await run.held();
  mock.timers.tick(20_000);
  await run.release();
  run.state.server = await starting;
  assert.ok(run.state.server.request);
});

test('the first directory-scoped request after startup also gets the startup budget', async (context) => {
  const run = await launch(context, '/event');
  run.state.server = await run.start();
  const pending = run.state.server.request('/event', { stream: true });
  await run.held();
  mock.timers.tick(20_000);
  await run.release();
  const events = await pending;
  await events.body.cancel();
  assert.ok(events.ok);
});

test('a request after readiness keeps the 15 s header timeout', async (context) => {
  const run = await launch(context, '/permission');
  run.state.server = await run.start();
  const events = await run.state.server.request('/event', { stream: true });
  await events.body.cancel();
  const outcome = assert.rejects(run.state.server.request('/permission'), TIMED_OUT);
  await run.held();
  mock.timers.tick(14_999);
  await sleep(20);
  mock.timers.tick(1);
  await outcome;
});

test('the startup budget is bounded by the named limit', async (context) => {
  const limit = serverModule.OPENCODE_STARTUP_TIMEOUT_MS;
  assert.ok(limit > 15_000 && limit <= 120_000);
  const run = await launch(context, '/global/health');
  const starting = run.start();
  const outcome = assert.rejects(starting, TIMED_OUT);
  await run.held();
  mock.timers.tick(limit - 1);
  await sleep(20);
  mock.timers.tick(1);
  await outcome;
});

test('user abort during the long startup wait terminates promptly without any timer firing', async (context) => {
  const run = await launch(context, '/global/health');
  const controller = new AbortController();
  const starting = run.start({ signal: controller.signal });
  const outcome = assert.rejects(starting, /cancelled/u);
  await run.held();
  const began = Date.now();
  controller.abort(new Error('cancelled'));
  await outcome;
  assert.ok(Date.now() - began < 3000);
});

test('startup timeout override is strictly validated and hard-bounded', () => {
  const resolve = serverModule.resolveOpenCodeStartupTimeout;
  assert.equal(resolve({}), serverModule.OPENCODE_STARTUP_TIMEOUT_MS);
  assert.equal(resolve({ ALA_OPENCODE_STARTUP_TIMEOUT_MS: '45000' }), 45_000);
  assert.equal(resolve({ ALA_OPENCODE_STARTUP_TIMEOUT_MS: '300000' }), 300_000);
  for (const bad of ['300001', '14999', '0', '-5', '1e5', '45000.5', ' 45000', 'abc', '']) {
    assert.throws(() => resolve({ ALA_OPENCODE_STARTUP_TIMEOUT_MS: bad }), /ALA_OPENCODE_STARTUP_TIMEOUT_MS/u, bad);
  }
});
