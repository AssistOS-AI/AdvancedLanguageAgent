import test from 'node:test';
import assert from 'node:assert/strict';

import { startOpenCodeServer } from '../src/coding-agents/opencode-server.mjs';
import { createProtocolProvider } from '../src/coding-agents/provider-client.mjs';
import { createChannelPair, createFakeProvider } from './fake-provider.mjs';
import { directProvider } from './direct-provider.mjs';
import { createOrigin, loadApiDocument } from './fixtures/opencode-origin.mjs';

const api = await loadApiDocument();

// The only adapter with connection code of its own: OpenCode is a `service` whose loopback server ALA reaches through
// connections the provider passes. This drives the real startOpenCodeServer against a fake provider server, so the
// version-check `run`, the `service` start, the announce, the authenticated health and API probes, and the stop all
// cross the protocol, and no HTTP socket is opened by ALA.
test('OpenCode runs its version check, service and HTTP exchanges through the protocol provider', async (context) => {
  const origin = await createOrigin(context, { api });
  const { client, server } = createChannelPair();
  const fake = createFakeProvider(server, {
    inventory: [{ name: 'opencode', version: '1.15.13' }],
    behavior({ request, stdout, exit }) {
      if (request.args.includes('--version')) { stdout.write('1.15.13\n'); exit(0); return; }
      stdout.write(`opencode server listening on http://127.0.0.1:${origin.port}\n`);
    },
    onConnect: (stream, endpoint) => {
      assert.deepEqual(endpoint, { kind: 'loopback-port', host: '127.0.0.1', port: origin.port });
      origin.accept(stream);
    }
  });
  const provider = createProtocolProvider({ channel: client, baseEnv: {} });
  context.after(() => provider.close());
  const opened = await startOpenCodeServer({
    binary: 'opencode', workspace: '/projects/g', websearch: false, env: {},
    sandbox: { provider, backend: 'opencode', home: '/home/robot', folders: [], ignoredPaths: [] }
  });
  assert.deepEqual(origin.requests.slice(0, 2).map(({ path }) => path), ['/global/health', '/doc']);
  for (const request of origin.requests) {
    assert.match(request.headers.authorization, /^Basic /u, 'every exchange is authenticated');
    assert.equal(new URLSearchParams(request.search).get('directory'), '/projects/g');
  }

  const [version, service] = fake.starts.map(({ request }) => request);
  assert.equal(version.processClass, 'run');
  assert.deepEqual(version.args, ['--version']);
  assert.equal(service.processClass, 'service');
  assert.deepEqual(service.communication, { kind: 'service', endpoint: 'loopback-port', stdin: 'ignore' });
  assert.deepEqual(service.lifecycle, { stopGraceMs: 2000, ready: { condition: 'announced-endpoint', timeoutMs: 30000 } });
  assert.deepEqual(service.args, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
  assert.equal(service.executable, 'opencode');
  assert.equal(service.cwd, '/projects/g');
  assert.match(service.env.OPENCODE_SERVER_PASSWORD, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(service.env.OPENCODE_ENABLE_EXA, '0');
  assert.deepEqual(Object.keys(service.env).sort(),
    ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_ENABLE_EXA', 'OPENCODE_SERVER_PASSWORD']);
  assert.equal(JSON.stringify(fake.messages).includes(service.env.OPENCODE_SERVER_PASSWORD), true,
    'the per-server password reaches only the start request that launches the server');
  const connects = fake.messages.filter((message) => message.type === 'connect');
  assert.ok(connects.length >= 1, 'HTTP exchanges used provider connections');
  assert.ok(connects.every((message) => message.process === 2), 'connections name the service process');
  assert.deepEqual(await opened.request('/global/health'), { healthy: true, version: '1.15.13' });

  await opened.stop();
  assert.deepEqual(fake.stops, [{ process: 2, graceMs: 2000 }]);
});

test('an OpenCode server the provider refuses fails the start with an execution error and no connection', async (context) => {
  const { client, server } = createChannelPair();
  const fake = createFakeProvider(server, {
    inventory: [{ name: 'opencode', version: '1.15.13' }],
    behavior({ request, stdout, exit }) {
      if (request.args.includes('--version')) { stdout.write('1.15.13\n'); exit(0); }
    },
    refuse: (request) => (request.processClass === 'service' ? 'services are not admitted' : null)
  });
  const provider = createProtocolProvider({ channel: client, baseEnv: {} });
  context.after(() => provider.close());
  await assert.rejects(startOpenCodeServer({
    binary: 'opencode', workspace: '/projects/g', websearch: false, env: {},
    sandbox: { provider, backend: 'opencode', home: '/home/robot', folders: [], ignoredPaths: [] }
  }), /refused the request: services are not admitted|failed to start/);
  assert.equal(fake.messages.some((message) => message.type === 'connect'), false);
});

test('embedded OpenCode ignores an inherited overlay and forwards the names ALA generates even when they equal inherited ones', async (context) => {
  const origin = await createOrigin(context, { api });
  const { client, server } = createChannelPair();
  const inherited = JSON.stringify({ permission: 'allow', mcp: { inherited: { type: 'remote', url: 'http://synthetic.invalid' } } });
  const fake = createFakeProvider(server, {
    inventory: [{ name: 'opencode', version: '1.15.13' }],
    behavior({ request, stdout, exit }) {
      if (request.args.includes('--version')) { stdout.write('1.15.13\n'); exit(0); return; }
      stdout.write(`opencode server listening on http://127.0.0.1:${origin.port}\n`);
    },
    onConnect: (stream) => origin.accept(stream)
  });
  // ALA's own (synthetic) environment already holds an overlay and a value equal to the one ALA will generate.
  const own = { OPENCODE_CONFIG_CONTENT: inherited, OPENCODE_ENABLE_EXA: '0', SYNTHETIC_OTHER: 'inherited' };
  const provider = createProtocolProvider({ channel: client, baseEnv: own });
  context.after(() => provider.close());
  const opened = await startOpenCodeServer({
    binary: 'opencode', workspace: '/projects/g', websearch: false, env: own,
    sandbox: { provider, backend: 'opencode', home: '/home/robot', folders: [], ignoredPaths: [] }
  });
  for (const { request } of fake.starts) {
    const overlay = JSON.parse(request.env.OPENCODE_CONFIG_CONTENT);
    assert.equal('mcp' in overlay, false, 'nothing from the inherited overlay crosses');
    assert.equal(typeof overlay.permission, 'object');
    assert.equal(overlay.permission.question, 'deny');
    assert.equal(request.env.OPENCODE_ENABLE_EXA, '0', 'a generated name equal to an inherited value is still forwarded');
    assert.equal('SYNTHETIC_OTHER' in request.env, false, 'an inherited value equal to ALA\'s own is not forwarded');
  }
  assert.equal(fake.starts[1].request.env.OPENCODE_SERVER_PASSWORD.length > 20, true);
  assert.equal('OPENCODE_SERVER_PASSWORD' in fake.starts[0].request.env, false);
  await opened.stop();
});

// The embedded branch of startOpenCodeServer: an overlay inherited from ALA's own environment is ignored, while the
// standalone launch still merges it into the generated overlay as at the base revision.
test('an inherited OPENCODE_CONFIG_CONTENT never reaches an embedded request and is still merged when standalone', async (context) => {
  const sentinel = 'SYNTHETIC-OVERLAY-SENTINEL';
  const inherited = JSON.stringify({ permission: 'allow', mcp: { [sentinel]: { type: 'remote', url: 'http://synthetic.invalid' } } });

  const embeddedOrigin = await createOrigin(context, { api });
  const { client, server } = createChannelPair();
  const fake = createFakeProvider(server, {
    inventory: [{ name: 'opencode', version: '1.15.13' }],
    behavior({ request, stdout, exit }) {
      if (request.args.includes('--version')) { stdout.write('1.15.13\n'); exit(0); return; }
      stdout.write(`opencode server listening on http://127.0.0.1:${embeddedOrigin.port}\n`);
    },
    onConnect: (stream) => embeddedOrigin.accept(stream)
  });
  const own = { OPENCODE_CONFIG_CONTENT: inherited };
  const provider = createProtocolProvider({ channel: client, baseEnv: own });
  context.after(() => provider.close());
  const embedded = await startOpenCodeServer({
    binary: 'opencode', workspace: '/projects/g', websearch: false, env: own,
    sandbox: { provider, backend: 'opencode', home: '/home/robot', folders: [], ignoredPaths: [] }
  });
  assert.equal(fake.starts.length, 2);
  assert.equal(JSON.stringify(fake.messages).includes(sentinel), false, 'the sentinel never reaches the provider');
  await embedded.stop();

  // Standalone: a recording provider around the direct test provider sees the merged overlay.
  const standaloneOrigin = await createOrigin(context, { api });
  const recorded = [];
  const direct = directProvider();
  const recording = { ...direct, start: (launch) => { recorded.push(launch.env); return direct.start(launch); } };
  const input = standaloneOrigin.serverInput();
  const standalone = await startOpenCodeServer({ ...input, sandbox: { provider: recording },
    env: { ...input.env, OPENCODE_CONFIG_CONTENT: inherited } });
  await standalone.stop();
  const overlay = JSON.parse(recorded.at(-1).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(overlay.mcp), [sentinel], 'standalone still merges the inherited overlay');
  assert.equal(overlay.permission['*'], 'allow');
  assert.equal(overlay.permission.question, 'deny');
});
