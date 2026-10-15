import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  OPENCODE_STARTUP_TIMEOUT_MS, consumeOpenCodeEvents, startOpenCodeServer
} from '../src/coding-agents/opencode-server.mjs';
import { createOrigin, loadApiDocument, waitFor } from './fixtures/opencode-origin.mjs';

const api = await loadApiDocument();
// Tests that await a pending promise must fail on their own instead of hanging a suite that sets no timeout.
const bounded = { timeout: 10_000 };

// Starts servers against one origin and registers an unconditional stop for each, even when an assertion fails.
function launcher(context, origin) {
  return async () => {
    const server = await startOpenCodeServer(origin.serverInput());
    context.after(() => server.stop().catch(() => {}));
    return server;
  };
}

function sseHandler(events, { end = false } = {}) {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (end) response.end();
  };
}

test('a second server on one origin never reuses a connection of the first', bounded, async (context) => {
  const origin = await createOrigin(context, { api });
  const start = launcher(context, origin);
  const first = await start();
  assert.ok(origin.requests.length >= 2, 'the first server issued its health and API probes');
  await first.stop();
  const firstSockets = new Set(origin.requests.map(({ socket }) => socket));
  // The old server is gone and a new one binds the same port; a leftover connection of the old one is dead.
  origin.nextEpoch();
  const second = await start();
  const fresh = origin.requests.filter(({ socket }) => !firstSockets.has(socket));
  assert.deepEqual(fresh.map(({ path }) => path).slice(0, 2), ['/global/health', '/doc']);
  assert.ok(fresh.every(({ epoch }) => epoch === 2), 'every request of the second server used a new connection');
  assert.ok(fresh.every(({ socket }) => !firstSockets.has(socket)));
  await second.stop();
});

test('stop destroys every connection of its server, including a live event stream', bounded, async (context) => {
  const handlers = { '/event': sseHandler([{ type: 'server.connected' }]) };
  const origin = await createOrigin(context, { api, handlers });
  const server = await launcher(context, origin)();
  const events = await server.request('/event', { stream: true });
  const reader = events.body.getReader();
  assert.equal((await reader.read()).done, false);
  const reading = reader.read();
  const outcome = assert.rejects(reading);
  assert.ok(origin.sockets.some(({ closed }) => !closed), 'the origin holds open connections before stop');
  await server.stop();
  await outcome;
  await waitFor(() => origin.sockets.every(({ closed }) => closed), 'every origin connection to close');
  await assert.rejects(server.request('/permission'), /client is closed/u);
  assert.equal(origin.requests.filter(({ path }) => path === '/permission').length, 0);
});

test('the event stream yields parsed events and cancelling it releases its socket', bounded, async (context) => {
  const sent = [{ type: 'server.connected', properties: {} }, { type: 'session.status', properties: { n: 2 } }];
  const origin = await createOrigin(context, { api, handlers: { '/event': sseHandler(sent) } });
  const server = await launcher(context, origin)();
  const response = await server.request('/event', { stream: true });
  const received = [];
  const done = new Error('enough events');
  await assert.rejects(consumeOpenCodeEvents(response, async (event) => {
    received.push(event);
    if (received.length === sent.length) throw done;
  }), done);
  assert.deepEqual(received, sent);
  const stream = origin.requests.find(({ path }) => path === '/event').socket;
  await waitFor(() => origin.sockets.find((entry) => entry.socket === stream).closed, 'the stream connection to close');
  await server.request('/permission').catch(() => {});
});

test('a server-ended event stream is reported as closed before the execution settled', bounded, async (context) => {
  const handlers = { '/event': sseHandler([{ type: 'x' }], { end: true }) };
  const origin = await createOrigin(context, { api, handlers });
  const server = await launcher(context, origin)();
  const response = await server.request('/event', { stream: true });
  await assert.rejects(consumeOpenCodeEvents(response, () => {}), /event stream closed before execution settled/u);
});

test('aborting before headers rejects with the abort reason and closes the connection', bounded, async (context) => {
  const origin = await createOrigin(context, { api, handlers: { '/permission': () => new Promise(() => {}) } });
  const server = await launcher(context, origin)();
  const controller = new AbortController();
  const pending = server.request('/permission', { signal: controller.signal });
  const outcome = assert.rejects(pending, /operator stop/u);
  await waitFor(() => origin.requests.some(({ path }) => path === '/permission'), 'the held request');
  const held = origin.requests.find(({ path }) => path === '/permission').socket;
  controller.abort(new Error('operator stop'));
  await outcome;
  await waitFor(() => origin.sockets.find((entry) => entry.socket === held).closed, 'the aborted connection to close');
  await assert.rejects(server.request('/permission', { signal: AbortSignal.abort(new Error('already')) }), /already/u);
});

test('aborting while an event stream is read errors the read with the abort reason', bounded, async (context) => {
  const handlers = { '/event': sseHandler([{ type: 'server.connected' }]) };
  const origin = await createOrigin(context, { api, handlers });
  const server = await launcher(context, origin)();
  const controller = new AbortController();
  const response = await server.request('/event', { stream: true, signal: controller.signal });
  const consuming = consumeOpenCodeEvents(response, () => {});
  const outcome = assert.rejects(consuming, /turn closed/u);
  await waitFor(() => origin.requests.some(({ path }) => path === '/event'), 'the event request');
  controller.abort(new Error('turn closed'));
  await outcome;
  const stream = origin.requests.find(({ path }) => path === '/event').socket;
  await waitFor(() => origin.sockets.find((entry) => entry.socket === stream).closed, 'the stream connection to close');
});

test('requests keep path, method, JSON body, credentials and directory scope', bounded, async (context) => {
  const origin = await createOrigin(context, { api, handlers: {
    '/session': (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'ses_1', received: true }));
    },
    '/empty': (_request, response) => { response.writeHead(204); response.end(); },
    '/broken': (_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('boom');
    },
    '/moved': (_request, response) => { response.writeHead(302, { location: '/session' }); response.end(); }
  } });
  const server = await launcher(context, origin)();
  const password = await readFile(join(origin.workspace, 'announce-password'), 'utf8');
  const body = { permission: [{ permission: '*', pattern: '*', action: 'ask' }], text: 'héllo' };
  assert.deepEqual(await server.request('/session', { method: 'POST', body }), { id: 'ses_1', received: true });
  const seen = origin.requests.find(({ path }) => path === '/session');
  assert.equal(seen.method, 'POST');
  assert.deepEqual(JSON.parse(seen.raw), body);
  assert.equal(seen.headers.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
  assert.equal(seen.headers['x-opencode-directory'], origin.workspace);
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers['accept-encoding'], 'identity');
  assert.equal(seen.headers['content-length'], String(Buffer.byteLength(JSON.stringify(body))));
  assert.equal(new URLSearchParams(seen.search).get('directory'), origin.workspace);
  assert.equal(await server.request('/empty'), null);
  await assert.rejects(server.request('/broken'), /OpenCode GET \/broken failed \(HTTP 500\)\./u);
  await assert.rejects(server.request('/moved'), /redirect refused/u);
  const get = origin.requests.find(({ path }) => path === '/global/health');
  assert.equal(get.headers['content-type'], undefined);
  assert.equal(get.headers['accept-encoding'], 'identity');
  assert.equal(get.raw, '');
});

test('a reset connection reports its code without exposing the URL or credentials', bounded, async (context) => {
  const origin = await createOrigin(context, { api, handlers: {
    '/permission': (_request, response, entry) => entry.socket.resetAndDestroy()
  } });
  const server = await launcher(context, origin)();
  await assert.rejects(server.request('/permission'), (error) => {
    assert.match(error.message, /^OpenCode HTTP connection failed \(ECONNRESET\)\.$/u);
    assert.equal(error.cause.code, 'ECONNRESET');
    return true;
  });
});

test('the startup request timer also covers a JSON body that stalls after the headers', bounded, async (context) => {
  const origin = await createOrigin(context, { api, handlers: { '/permission': (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('[');
  } } });
  const server = await launcher(context, origin)();
  mock.timers.enable({ apis: ['setTimeout'] });
  context.after(() => mock.timers.reset());
  const pending = server.request('/permission');
  const outcome = assert.rejects(pending, /OpenCode HTTP request timed out\./u);
  await waitFor(() => origin.requests.some(({ path }) => path === '/permission'), 'the stalled request');
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(OPENCODE_STARTUP_TIMEOUT_MS);
  await outcome;
  const stalled = origin.requests.find(({ path }) => path === '/permission').socket;
  await waitFor(() => origin.sockets.find((entry) => entry.socket === stalled).closed, 'the stalled socket to close');
});

test('a non-identity content encoding is refused and its connection released', bounded, async (context) => {
  const encoded = (encoding) => (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding });
    response.write('[');
  };
  const origin = await createOrigin(context, { api, handlers: {
    '/gzip': encoded('gzip'), '/mixed': encoded(' GZip, br'),
    '/identity': (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'Identity' });
      response.end('{"ok":true}');
    }
  } });
  const server = await launcher(context, origin)();
  const refusal = { message: 'OpenCode HTTP response used an unsupported content encoding.' };
  for (const path of ['/gzip', '/mixed']) {
    await assert.rejects(server.request(path), refusal);
    const socket = origin.requests.find((entry) => entry.path === path).socket;
    await waitFor(() => origin.sockets.find((entry) => entry.socket === socket).closed, `${path} socket to close`);
  }
  assert.deepEqual(await server.request('/identity'), { ok: true });
});
