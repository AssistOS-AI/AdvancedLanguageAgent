import test from 'node:test';
import assert from 'node:assert/strict';

import { ALAError, EXIT_CODES } from '../src/errors.mjs';
import { openJsonChannel } from '../src/coding-agents/json-channel.mjs';
import { selectSpawn } from '../src/coding-agents/process.mjs';
import { createProtocolProvider } from '../src/coding-agents/provider-client.mjs';
import { PROVIDER_PROTOCOL } from '../src/coding-agents/provider.mjs';
import { createChannelPair, createFakeProvider, duplexPair } from './fake-provider.mjs';
import {
  collect, createServiceOrigin, defineProviderConformance, defineRawWireConformance
} from './provider-conformance.mjs';

const view = { home: '/home/robot', cwd: '/projects/g', folder: '/projects/g', outside: '/outside' };
const fixtures = {
  run: { binary: 'codex', args: ['run'], stdout: 'out\n', stderr: 'err\n', code: 0 },
  fail: { binary: 'codex', args: ['fail'], code: 3 },
  session: { binary: 'claude', args: ['echo'] },
  hold: { binary: 'codex', args: ['hold'] },
  service: { binary: 'codex', args: ['serve'], port: 4321, body: 'service-ok' }
};

const script = ({ request, stdin, stdout, stderr, exit }) => {
  switch (request.args[0]) {
    case 'run': stdout.write('out\n'); stderr.write('err\n'); exit(0); break;
    case 'fail': exit(3); break;
    case 'echo':
      stdin.on('data', (chunk) => stdout.write(chunk));
      stdin.on('end', () => exit(0));
      break;
    case 'serve': stdout.write('server listening on http://127.0.0.1:4321\n'); break;
    default:
  }
};

function open(options = {}, providerOptions = {}) {
  const { client, server } = createChannelPair();
  const origin = createServiceOrigin('service-ok');
  const fake = createFakeProvider(server, {
    refuse: (request) => (request.cwd.startsWith('/outside') ? 'outside the admitted view' : null),
    behavior: script, onConnect: (stream) => origin.accept(stream), ...options
  });
  const provider = createProtocolProvider({ channel: client, baseEnv: {}, ...providerOptions });
  return { provider, fake, client, server, close: async () => { await provider.close(); origin.close(); } };
}

const launch = (extra = {}) => ({
  processClass: 'run', binary: 'codex', args: ['run'], cwd: view.cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'],
  sandbox: { home: view.home, folders: [{ source: view.folder, target: view.folder, writable: false }], ignoredPaths: [] },
  ...extra
});

defineProviderConformance({ label: 'protocol client with the fake provider', test, harness: { view, fixtures, open: async () => open() } });

// The same fake, exercised below the client with crafted messages, tests the server's own admission decisions.
defineRawWireConformance({
  label: 'fake provider server', test,
  harness: {
    view, readOnlyFolder: '/projects/ro', makeHandle: duplexPair,
    openRaw: async () => {
      const { client, server } = createChannelPair();
      createFakeProvider(server, { grants: [{ path: '/projects/g', access: 'write' }, { path: '/projects/ro', access: 'read' }],
        behavior: () => {} });
      return { channel: client, close: async () => client.disconnect() };
    }
  }
});

test('the handshake completes before any other message leaves the client', async () => {
  const { provider, fake, server, close } = open({ answerHello: false });
  const child = provider.start(launch());
  const finished = collect(child);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.messages.map((message) => message.type), ['hello']);
  assert.deepEqual(fake.messages[0], { type: 'hello', protocol: PROVIDER_PROTOCOL, versions: [1] });
  server.send({ type: 'hello', protocol: PROVIDER_PROTOCOL, version: 1 });
  assert.equal((await finished).code, 0);
  assert.deepEqual(fake.messages.map((message) => message.type), ['hello', 'start']);
  await close();
});

test('a start request carries exactly the section 5.3 fields for a fixed input', async () => {
  const { provider, fake, close } = open();
  const child = provider.start({
    processClass: 'session', binary: 'codex', args: ['app-server', '--stdio'], cwd: '/projects/g/src',
    env: { OPENCODE_ENABLE_EXA: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    sandbox: {
      home: '/home/robot', ignoredPaths: ['/projects/g/private'],
      folders: [{ source: '/projects/g', target: '/projects/g', writable: true },
        { source: '/projects/ref', target: '/projects/ref', writable: false }]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.starts, [{ process: 1, request: {
    processClass: 'session',
    executable: 'codex',
    args: ['app-server', '--stdio'],
    env: { OPENCODE_ENABLE_EXA: '1' },
    home: '/home/robot',
    cwd: '/projects/g/src',
    folders: [{ path: '/projects/g', access: 'write' }, { path: '/projects/ref', access: 'read' }],
    exclusions: ['/projects/g/private'],
    communication: { kind: 'streams', stdin: 'pipe' },
    lifecycle: { stopGraceMs: 2000 },
    network: 'robot-egress',
    requirements: { privateProc: true }
  } }]);
  child.kill('SIGKILL');
  await close();
});

test('only explicit additions cross the protocol, never a value from ALA itself', async () => {
  const sentinel = { ALA_SENTINEL_CREDENTIAL: 'secret-value', OPENAI_API_KEY: 'key', HOME: '/host/home', PATH: '/bin' };
  const { provider, fake, close } = open({}, { baseEnv: sentinel });
  const env = { ...sentinel, OPENCODE_SERVER_PASSWORD: 'per-server', OPENCODE_ENABLE_EXA: '1' };
  const finished = collect(provider.start(launch({ env })));
  await finished;
  assert.deepEqual(fake.starts[0].request.env, { OPENCODE_SERVER_PASSWORD: 'per-server', OPENCODE_ENABLE_EXA: '1' });
  assert.equal(JSON.stringify(fake.messages).includes('secret-value'), false);
  for (const reserved of ['HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'PATH']) {
    assert.throws(() => provider.start(launch({ env: { [reserved]: '/x' } })), (error) => (
      error instanceof ALAError && error.exitCode === EXIT_CODES.execution && /owns the environment variable/.test(error.message)));
  }
  assert.throws(() => provider.start(launch({ env: { 'BAD NAME': 'x' } })), /Invalid execution-provider environment name/);
  await close();
});

test('backend controls ALA sets in its standalone sandbox are explicit additions in embedded requests', async () => {
  const { provider, fake, close } = open();
  const sandbox = (backend) => ({ backend, home: view.home, folders: [], ignoredPaths: [] });
  await collect(provider.start(launch({ binary: 'claude', sandbox: sandbox('claude'), env: { ANTHROPIC_BASE_URL: 'u' } })));
  await collect(provider.start(launch({ binary: 'pi', sandbox: sandbox('pi') })));
  await collect(provider.start(launch({ binary: 'codex', sandbox: sandbox('codex') })));
  await collect(provider.start(launch({ binary: 'opencode', sandbox: sandbox('opencode'), env: { OPENCODE_ENABLE_EXA: '1' } })));
  assert.deepEqual(fake.starts.map(({ request }) => request.env), [
    { ANTHROPIC_BASE_URL: 'u', IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' },
    { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
    {},
    { OPENCODE_ENABLE_EXA: '1' }
  ]);
  await close();
});

test('the client refuses invalid HOME, virtual paths and unknown process classes before sending', async () => {
  const { provider, fake, close } = open();
  const bad = [
    launch({ sandbox: { home: '/home/other', folders: [], ignoredPaths: [] } }),
    launch({ cwd: 'relative/dir' }),
    launch({ cwd: '/projects/../etc' }),
    launch({ sandbox: { home: view.home, folders: [{ source: '/a/../b', target: '/a/../b' }], ignoredPaths: [] } }),
    launch({ sandbox: { home: view.home, folders: [], ignoredPaths: ['rel'] } }),
    launch({ processClass: 'terminal' }),
    launch({ network: 'open' })
  ];
  for (const request of bad) {
    assert.throws(() => provider.start(request), (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.execution);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.messages.map((message) => message.type), ['hello']);
  await close();
});

test('stop requests map SIGTERM to the grace period and SIGKILL to an immediate stop', async () => {
  const { provider, fake, close } = open({ onStop: () => {} });
  const first = provider.start(launch({ args: ['hold'] }));
  const second = provider.start(launch({ args: ['hold'] }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(first.kill('SIGTERM'), true);
  assert.equal(second.kill('SIGKILL'), true);
  assert.throws(() => first.kill('SIGUSR1'), /Unsupported signal/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.stops, [{ process: 1, graceMs: 2000 }, { process: 2, graceMs: 0 }]);
  await close();
});

// A provider failure of each kind must fail every process class and the inventory with an explicit execution error.
const failureCases = [
  ['version mismatch', { version: 2 }, /protocol version 2 is not supported/],
  ['unknown protocol', { protocol: 'other' }, /unknown protocol/],
  ['refusal', { refuse: () => 'no capacity' }, /refused the request: no capacity/],
  ['crash during start', { crashOnStart: true }, /connection closed/],
  ['setup failure', { failOnStart: true }, /Execution provider failed: sandbox setup failed/],
  ['failure after the process started', { failAfterStarted: true }, /Execution provider failed: workload domain was lost/],
  ['channel-wide failure', { failAll: true }, /Execution provider failed: worker is shutting down/]
];
for (const processClass of ['run', 'session', 'service']) {
  for (const [name, options, expected] of failureCases) {
    test(`a ${name} fails a ${processClass} process with an explicit execution error`, async () => {
      const { provider, fake, close } = open(options);
      const stdio = processClass === 'session' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
      const result = await collect(provider.start(launch({ processClass, stdio })));
      assert.ok(result.error instanceof ALAError, 'an ALAError is raised');
      assert.equal(result.error.exitCode, EXIT_CODES.execution);
      assert.match(result.error.message, expected);
      assert.equal(result.code, null);
      assert.equal(fake.live.size, 0);
      await close();
    });
  }
}

test('inventory fails with an explicit execution error for each provider failure', async () => {
  const applicable = ['version mismatch', 'unknown protocol', 'channel-wide failure'];
  for (const [, options, expected] of failureCases.filter(([name]) => applicable.includes(name))) {
    const { provider, close } = open(options);
    await assert.rejects(provider.inventory(), (error) => error instanceof ALAError
      && error.exitCode === EXIT_CODES.execution && expected.test(error.message));
    await close();
  }
  const crashed = open({});
  const pending = crashed.provider.inventory();
  crashed.server.disconnect();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(crashed.provider.inventory(), /connection closed/);
  await crashed.close();
});

test('a provider that never answers the handshake fails the operation', async () => {
  const { provider, close } = open({ answerHello: false }, { handshakeTimeoutMs: 20 });
  const result = await collect(provider.start(launch()));
  assert.match(result.error.message, /did not answer the handshake/);
  await assert.rejects(provider.inventory(), /did not answer the handshake/);
  await close();
});

test('refusal text from the provider is untrusted: control characters and length are bounded', async () => {
  const { provider, close } = open({ refuse: () => `bad\u001b[31m\nline${'x'.repeat(5000)}` });
  const result = await collect(provider.start(launch()));
  assert.equal(/[\u0000-\u001f]/.test(result.error.message), false);
  assert.ok(result.error.message.length < 700);
  await close();
});

test('a malformed provider message is a protocol violation that fails the running process', async () => {
  const { provider, server, close } = open({ behavior: () => {} });
  const finished = collect(provider.start(launch({ args: ['hold'] })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  server.send({ type: 'surprise', process: 1 });
  const result = await finished;
  assert.match(result.error.message, /protocol violation/);
  await close();
});

test('the inventory, temporary directory and connection answers are validated', async () => {
  const names = await open().provider.inventory();
  assert.deepEqual(names, [{ name: 'codex', version: '0.1.0' }, { name: 'claude', version: '2.1.0' }]);
  for (const inventory of [[{ name: 'rm' }], [{ name: 'codex' }, { name: 'codex' }], 'codex', [{ name: 'pi', version: 3 }]]) {
    await assert.rejects(open({ inventory }).provider.inventory(), /invalid backend inventory/);
  }
  assert.equal(await open({ tempdir: '/tmp/ala-9' }).provider.tempdir(), '/tmp/ala-9');
  for (const tempdir of ['relative', '/', '/a/../b', '/tmp/a\u001b[31mb', `/${'x'.repeat(5000)}`]) {
    await assert.rejects(open({ tempdir }).provider.tempdir(), /invalid temporary directory/);
  }
  const { provider, close } = open({ behavior: () => {} });
  const child = provider.start(launch({ args: ['hold'] }));
  await assert.rejects(provider.connect({ process: child, port: 4321 }), /requires a running execution-provider service/);
  const service = provider.start(launch({ processClass: 'service' }));
  await assert.rejects(provider.connect({ process: service, host: '10.0.0.5', port: 4321 }), /loopback port/);
  await assert.rejects(provider.connect({ process: service, port: 0 }), /loopback port/);
  await close();
});

test('an injected spawn function cannot bypass a protocol provider', async () => {
  const { provider, fake, close } = open();
  let bypassed = false;
  const spawnImpl = () => { bypassed = true; throw new Error('spawnImpl must not be used'); };
  const input = { binary: 'claude', workspace: view.cwd, env: {}, spawnImpl,
    sandbox: { provider, home: view.home, folders: [], ignoredPaths: [] } };
  const channel = openJsonChannel(input, ['--mode', 'rpc']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bypassed, false);
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0].request.processClass, 'session');
  await channel.close();
  assert.equal(selectSpawn({ sandbox: { provider }, spawnImpl }) === spawnImpl, false);
  assert.equal(selectSpawn({ sandbox: { provider: { kind: 'bubblewrap' } }, spawnImpl }), spawnImpl);
  await close();
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('requests that wait for an answer are bounded, and a running process is not', async () => {
  const silent = open({ silentAfterHello: true }, { requestTimeoutMs: 40 });
  await assert.rejects(silent.provider.inventory(), (error) => error instanceof ALAError
    && error.exitCode === EXIT_CODES.execution && /did not answer the inventory request/.test(error.message));
  await assert.rejects(silent.provider.tempdir(), /did not answer the tempdir request/);
  const result = await collect(silent.provider.start(launch()));
  assert.match(result.error.message, /did not answer the start request/);
  await settle(10);
  assert.deepEqual(silent.fake.messages.filter((message) => message.type === 'stop'), [{ type: 'stop', process: 1, graceMs: 0 }],
    'a start that never answered is stopped');
  // A late answer to an abandoned request is not a protocol violation.
  silent.server.send({ type: 'result', id: 1, ok: true, value: [] });
  await settle();
  await assert.rejects(silent.provider.inventory(), /did not answer the inventory request/);
  await silent.close();

  const service = open({ behavior: script, ignoreConnect: true }, { requestTimeoutMs: 40 });
  const child = service.provider.start(launch({ processClass: 'service', args: ['serve'] }));
  const finished = collect(child);
  await settle(10);
  await assert.rejects(service.provider.connect({ process: child, port: 4321 }), /did not answer the connect request/);
  await settle(120);
  assert.equal(child.exitCode, null, 'a running process outlives the request timeout');
  child.kill('SIGTERM');
  assert.equal((await finished).error, null);
  await service.close();
});

test('a write error from the channel fails the operation with an execution error, never an unhandled event', async () => {
  const { provider, client, close } = open({ behavior: () => {} });
  const running = collect(provider.start(launch({ args: ['hold'] })));
  await settle();
  client.breakWrites();
  const inventory = provider.inventory();
  const later = await collect(provider.start(launch()));
  await assert.rejects(inventory, (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.execution
    && /connection is closed/.test(error.message));
  assert.match(later.error.message, /connection is closed/);
  assert.match((await running).error.message, /connection is closed/);
  await close();
});

test('closing before the provider answers the handshake sends nothing but the hello', async () => {
  const { provider, fake } = open({ answerHello: false });
  await settle();
  provider.start(launch());
  await provider.close();
  await settle();
  assert.deepEqual(fake.messages.map((message) => message.type), ['hello']);
});

test('a handle attached to started, or a stream that arrives after exit, is a protocol violation', async () => {
  const first = open({ behavior: () => {} });
  const child = collect(first.provider.start(launch({ args: ['hold'] })));
  await settle();
  first.server.send({ type: 'started', process: 1 }, duplexPair()[0]);
  assert.match((await child).error.message, /handle arrived with started/);
  await first.close();

  const second = open();
  await collect(second.provider.start(launch()));
  await settle();
  second.server.send({ type: 'stream', process: 1, stream: 'stdout' }, duplexPair()[0]);
  await settle();
  await assert.rejects(second.provider.inventory(), /protocol violation: message for an unknown or ended process/);
  await second.close();
});

test('a start that timed out is abandoned: its late started, streams and exit do not fail the channel', async () => {
  const { provider, server, fake, close } = open({ silentAfterHello: true }, { requestTimeoutMs: 40 });
  const result = await collect(provider.start(launch({ stdio: ['pipe', 'pipe', 'pipe'], processClass: 'session' })));
  assert.match(result.error.message, /did not answer the start request/);
  const streams = [duplexPair(), duplexPair(), duplexPair()];
  server.send({ type: 'started', process: 1 });
  ['stdin', 'stdout', 'stderr'].forEach((stream, index) => {
    server.send({ type: 'stream', process: 1, stream }, streams[index][1]);
  });
  server.send({ type: 'exit', process: 1, code: null, signal: 'SIGKILL' });
  await settle();
  assert.equal(streams.every(([, remote]) => remote.destroyed), true, 'every late handle is destroyed');
  // The channel still works: a provider that answers now serves the next operation.
  fake.messages.length = 0;
  const inventory = provider.inventory();
  await settle(5);
  const asked = fake.messages.find((message) => message.type === 'inventory');
  server.send({ type: 'result', id: asked.id, ok: true, value: [{ name: 'codex' }] });
  assert.deepEqual(await inventory, [{ name: 'codex' }]);
  // The late exit retired the id: a further stream for it is now a violation, as for any ended process.
  const extra = duplexPair();
  server.send({ type: 'stream', process: 1, stream: 'stdout' }, extra[1]);
  await settle();
  assert.equal(extra[1].destroyed, true);
  await assert.rejects(provider.inventory(), /protocol violation: message for an unknown or ended process/);
  await close();
});
