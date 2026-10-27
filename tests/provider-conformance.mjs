import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createOpenCodeHttpClient } from '../src/coding-agents/opencode-http.mjs';

// Execution-provider conformance. The suite drives any provider object (the Bubblewrap provider, the protocol
// client against a fake or real worker) through the interface only. A harness supplies the provider and the
// deterministic fixtures that its backends run, so the same checks verify the server side that robo-work
// implements:
//
//   harness.open() -> { provider, close() }
//   harness.view   -> { home, cwd, folder, outside }   paths the provider admits, and one it must refuse
//   harness.fixtures.run      -> { binary, args, stdout, stderr, code }   a one-shot process
//   harness.fixtures.fail     -> { binary, args, code }                   a process that exits non-zero
//   harness.fixtures.session  -> { binary, args }                         echoes standard input to output
//   harness.fixtures.hold     -> { binary, args }                         runs until it is stopped
//   harness.fixtures.service  -> { binary, args, port, body }             announces a loopback HTTP service

export function collect(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error = null;
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (value) => { error = value; });
    child.once('close', (code, signal) => resolve({ stdout, stderr, code, signal, error }));
  });
}

function request(harness, fixture, extra = {}) {
  const { view } = harness;
  return {
    processClass: 'run', binary: fixture.binary, args: fixture.args, cwd: view.cwd, env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
    sandbox: { home: view.home, folders: [{ source: view.folder, target: view.folder, writable: false }], ignoredPaths: [] },
    ...extra
  };
}

export function defineProviderConformance({ label, test, harness }) {
  const withProvider = (body) => async () => {
    const opened = await harness.open();
    try { await body(opened.provider, opened); } finally { await opened.close(); }
  };

  test(`${label}: a run process delivers its output and exit status`, withProvider(async (provider) => {
    const { run } = harness.fixtures;
    const result = await collect(provider.start(request(harness, run)));
    assert.equal(result.error, null);
    assert.equal(result.stdout, run.stdout);
    assert.equal(result.stderr, run.stderr);
    assert.equal(result.code, run.code);
  }));

  test(`${label}: a non-zero exit status is reported unchanged`, withProvider(async (provider) => {
    const { fail } = harness.fixtures;
    const result = await collect(provider.start(request(harness, fail)));
    assert.equal(result.code, fail.code);
  }));

  test(`${label}: a session relays standard input and output`, withProvider(async (provider) => {
    const child = provider.start(request(harness, harness.fixtures.session,
      { processClass: 'session', stdio: ['pipe', 'pipe', 'pipe'] }));
    const finished = collect(child);
    child.stdin.write('first\n');
    child.stdin.end('second\n');
    const result = await finished;
    assert.equal(result.stdout, 'first\nsecond\n');
    assert.equal(result.code, 0);
  }));

  test(`${label}: stop ends a running process and reports it`, withProvider(async (provider) => {
    const child = provider.start(request(harness, harness.fixtures.hold));
    const finished = collect(child);
    setTimeout(() => child.kill('SIGTERM'), 25);
    const result = await finished;
    assert.ok(result.code !== 0 || result.signal !== null, 'a stopped process does not report success');
  }));

  test(`${label}: a request outside the admitted view is refused, not started`, withProvider(async (provider) => {
    const result = await collect(provider.start(request(harness, harness.fixtures.run, { cwd: harness.view.outside })));
    assert.ok(result.error, 'the refusal surfaces as an error');
    assert.equal(result.stdout, '');
    assert.equal(result.code, null);
  }));

  test(`${label}: a service is reached through provider connections`, withProvider(async (provider) => {
    const { service } = harness.fixtures;
    const child = provider.start(request(harness, service, { processClass: 'service', stdio: ['ignore', 'pipe', 'pipe'] }));
    const finished = collect(child);
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const client = createOpenCodeHttpClient({ connect: (host, port) => provider.connect({ process: child, host, port }) });
    try {
      const response = await client.request(new URL(`http://127.0.0.1:${service.port}/ping`));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), service.body);
    } finally {
      client.close();
      child.kill('SIGTERM');
      await finished;
    }
  }));
}

// A loopback HTTP origin that answers `body` and accepts connections handed to it as already connected streams.
export function createServiceOrigin(body) {
  const server = createServer((_request, response) => { response.end(body); });
  return { accept: (stream) => server.emit('connection', stream), close: () => server.close() };
}

// Raw-wire conformance. These checks send crafted messages straight to a server, below the protocol client, so the
// server's own admission decisions are tested rather than the client's validation. A harness supplies:
//
//   harness.openRaw() -> { channel, close() }   channel has send(message, handle?) and on('message'|'disconnect')
//   harness.view      -> { home, cwd, folder, outside }   a path the server admits, and one it must refuse
//   harness.readOnlyFolder, harness.writableFolder   admitted grants; the read-only one must refuse write access
//
// Every crafted request below is outside what the client would build. The server must answer `refused` (or `failure`)
// for that process and must never answer `started`; a message with a handle or of an unknown type must be rejected.
export function defineRawWireConformance({ label, test, harness }) {
  const PROTOCOL = 'ala-execution-provider';
  const open = async () => {
    const opened = await harness.openRaw();
    const received = [];
    opened.channel.on('message', (message) => received.push(message));
    const waitFor = async (predicate, limit = 1000) => {
      for (let waited = 0; waited < limit; waited += 5) {
        const found = received.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return null;
    };
    opened.channel.send({ type: 'hello', protocol: PROTOCOL, versions: [1] });
    assert.ok(await waitFor((message) => message.type === 'hello'), 'the server answers the handshake');
    return { ...opened, received, waitFor };
  };
  const valid = () => ({
    processClass: 'run', executable: 'codex', args: ['run'], env: {}, home: harness.view.home, cwd: harness.view.cwd,
    folders: [{ path: harness.view.folder, access: 'read' }], exclusions: [],
    communication: { kind: 'streams', stdin: 'ignore' }, lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress',
    requirements: { privateProc: true }
  });
  const crafted = [
    ['an unknown process class', { processClass: 'terminal' }],
    ['an executable path instead of a backend name', { executable: '/bin/sh' }],
    ['a backend outside the tool inventory', { executable: 'not-a-backend' }],
    ['a HOME other than the robot HOME', { home: '/home/other' }],
    ['a working directory outside the admitted view', () => ({ cwd: harness.view.outside })],
    ['a folder outside the admitted grants', () => ({ folders: [{ path: harness.view.outside, access: 'read' }] })],
    ['a write folder wider than a read-only grant', () => ({ folders: [{ path: harness.readOnlyFolder, access: 'write' }] })],
    ['an environment name the provider owns', { env: { HOME: '/tmp' } }],
    ['an environment name in the XDG family', { env: { XDG_DATA_HOME: '/tmp' } }],
    ['an exclusion that cannot be enforced', () => ({ exclusions: [harness.view.outside] })],
    ['a network mode wider than the matrix', { network: 'open' }],
    ['a missing private /proc requirement', { requirements: { privateProc: false } }]
  ];
  for (const [name, change] of crafted) {
    test(`${label}: the server refuses ${name} and never starts it`, async () => {
      const raw = await open();
      try {
        const overrides = typeof change === 'function' ? change() : change;
        raw.channel.send({ type: 'start', process: 1, request: { ...valid(), ...overrides } });
        const answer = await raw.waitFor((message) => message.process === 1 && message.type !== 'hello');
        assert.ok(answer, 'the server answers the crafted start');
        assert.ok(['refused', 'failure'].includes(answer.type), `answered ${answer.type}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(raw.received.some((message) => ['started', 'stream', 'exit'].includes(message.type)), false);
      } finally { await raw.close(); }
    });
  }

  test(`${label}: the server rejects a client message that carries a handle`, async () => {
    const raw = await open();
    try {
      const [handle] = harness.makeHandle();
      raw.channel.send({ type: 'inventory', id: 1 }, handle);
      const answer = await raw.waitFor((message) => message.type === 'failure' || message.type === 'result');
      assert.equal(answer?.type, 'failure');
      assert.equal(raw.received.some((message) => message.type === 'result'), false);
    } finally { await raw.close(); }
  });

  test(`${label}: the server rejects a client message of an unknown type`, async () => {
    const raw = await open();
    try {
      raw.channel.send({ type: 'shell', command: 'true' });
      const answer = await raw.waitFor((message) => message.type === 'failure');
      assert.ok(answer, 'an unknown message type is a failure');
    } finally { await raw.close(); }
  });

  test(`${label}: a valid crafted start is admitted, so the refusals above are decided by the server`, async () => {
    const raw = await open();
    try {
      raw.channel.send({ type: 'start', process: 1, request: valid() });
      assert.ok(await raw.waitFor((message) => message.type === 'started'), 'the control request is started');
    } finally { await raw.close(); }
  });
}
