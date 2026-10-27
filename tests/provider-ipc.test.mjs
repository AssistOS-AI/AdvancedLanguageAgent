import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpenCodeHttpClient } from '../src/coding-agents/opencode-http.mjs';
import { createFakeProvider } from './fake-provider.mjs';

// The real transport: ALA is started with a Node IPC channel as its provider descriptor and this test process is the
// supervisor. Standard streams reach ALA as connected Unix sockets passed as handles, which is how the worker passes
// them. These tests run the actual executable, so they cover descriptor validation, the handshake, handle receipt and
// the clean exit that depends on ALA disconnecting its channel.
const entry = fileURLToPath(new URL('../bin/ala.mjs', import.meta.url));
const CODEX_RUN = [
  { type: 'thread.started', thread_id: 'thread-ipc' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'hello over ipc' } }
].map((event) => `${JSON.stringify(event)}\n`).join('');

// A pair of connected Unix sockets. The provider keeps the connecting end and passes the accepted end, which is
// created paused: the sender never reads from a descriptor it is about to pass, so neither bytes nor an early
// end-of-stream are consumed or lost before the receiver owns it.
async function socketFactory(context) {
  const directory = await mkdtemp(join('/tmp', 'ala-ipc-'));
  const path = join(directory, 's');
  const server = net.createServer({ pauseOnConnect: true });
  await new Promise((resolve) => server.listen(path, resolve));
  context.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  return async function pair() {
    const accepted = once(server, 'connection');
    const kept = net.connect(path);
    await once(kept, 'connect');
    const [passed] = await accepted;
    return [kept, passed];
  };
}

function run(context, args, env, options, pair) {
  const child = fork(entry, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  context.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const fake = createFakeProvider(child, { pair, ...options });
  // 'close' is not always emitted after the supervisor itself ends the channel, so the result is complete once the
  // process has exited and both of its output streams have ended.
  const ended = (stream) => (stream.readableEnded ? Promise.resolve() : once(stream, 'end'));
  const finished = once(child, 'exit').then(async ([code, signal]) => {
    await Promise.all([ended(child.stdout), ended(child.stderr)]);
    return { code, signal, stdout, stderr };
  });
  return { child, fake, finished };
}

test('agent list runs over a real IPC descriptor and ALA exits after disconnecting it', async (context) => {
  const { fake, finished } = run(context, ['agent', 'list', '--json', '--execution-provider', 'protocol'], {}, {}, undefined);
  const result = await finished;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['codex', 'claude']);
  assert.deepEqual(fake.messages.map((message) => message.type), ['hello', 'inventory']);
});

test('a task turn runs over real IPC with standard streams delivered as socket handles', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ala-ipc-config-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json');
  await writeFile(config, '{}\n');
  const pair = await socketFactory(context);
  const behavior = ({ request, stdout, exit }) => {
    if (request.args.includes('exec')) { stdout.write(CODEX_RUN); exit(0); } else exit(2);
  };
  const { fake, finished } = run(context, ['--execution-provider', 'protocol', '--config', config, '--cwd', '/projects/g',
    '--home', '/home/robot', '--task', 'hello'], { ALA_SESSIONS: join(directory, 'sessions') }, { behavior }, pair);
  const result = await finished;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'hello over ipc');
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0].request.executable, 'codex');
  assert.equal(fake.starts[0].request.cwd, '/projects/g');
  assert.deepEqual(fake.starts[0].request.env, {});
});

test('a protocol selection without a descriptor fails with exit 5 and starts nothing', async () => {
  const child = spawn(process.execPath, [entry, 'agent', 'list', '--execution-provider', 'protocol'],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 5);
  assert.match(stderr, /execution-provider descriptor is missing/);
});

test('a provider that ends the channel during a turn fails the turn with an execution error', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ala-ipc-crash-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config.json');
  await writeFile(config, '{}\n');
  const { finished } = run(context, ['--execution-provider', 'protocol', '--config', config, '--cwd', '/projects/g',
    '--task', 'hello'], { ALA_SESSIONS: join(directory, 'sessions') }, { crashOnStart: true }, undefined);
  const result = await finished;
  assert.equal(result.code, 5);
  assert.match(result.stderr, /connection closed/);
});

test('the OpenCode HTTP client uses a factory-supplied socket through the agent connection callback', async (context) => {
  const directory = await mkdtemp(join('/tmp', 'ala-ipc-http-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'h');
  const origin = createServer((request, response) => { response.end(`pong ${request.method} ${request.url}`); });
  await new Promise((resolve) => origin.listen(path, resolve));
  context.after(() => origin.close());
  const requested = [];
  const client = createOpenCodeHttpClient({
    connect: async (host, port) => { requested.push([host, port]); return net.connect(path); }
  });
  context.after(() => client.close());
  const first = await client.request(new URL('http://127.0.0.1:4321/a?x=1'));
  assert.equal(await first.text(), 'pong GET /a?x=1');
  const second = await client.request(new URL('http://127.0.0.1:4321/b'), { method: 'POST', body: '{}' });
  assert.equal(await second.text(), 'pong POST /b');
  assert.deepEqual(requested[0], ['127.0.0.1', 4321]);
  const failing = createOpenCodeHttpClient({ connect: async () => { throw new Error('connection refused by provider'); } });
  await assert.rejects(failing.request(new URL('http://127.0.0.1:4321/c')), /OpenCode HTTP connection failed/);
  failing.close();
});

// The supervisor fixture starts a detached sender. These helpers track exactly the PIDs it reports so that a timeout or
// a failed assertion can never leave a sender running: the hook below checks each recorded PID and signals only that
// PID, after confirming from its command line that it is the sender fixture. Nothing is killed by name, pattern or group.
const senderScript = 'ipc-sender.mjs';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
// The exact identity of a sender: this test's own Node executable running the sender fixture with this run's unique
// result file as its first argument. A merely similar command line (a shell or ssh mentioning the script) never matches.
const isSender = (pid, result) => {
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  if (!command.startsWith(`${process.execPath} `)) return false;
  const marker = `${senderScript} ${result}`;
  const at = command.indexOf(marker);
  if (at < 0 || !command.slice(0, at).endsWith('/')) return false;
  const rest = command.slice(at + marker.length);
  return rest === '' || rest.startsWith(' ');
};
const gone = async (pid, limit = 5000) => {
  for (let waited = 0; waited < limit; waited += 20) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
};

function supervise(context, directory, name, extra = []) {
  const supervisor = fileURLToPath(new URL('./fixtures/ipc-supervisor.mjs', import.meta.url));
  const result = join(directory, name);
  const child = spawn(process.execPath, [supervisor, result, ...extra], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const record = { child, result, senderPid: null };
  const line = async (prefix) => {
    for (;;) {
      const found = lines.find((value) => value.startsWith(prefix));
      if (found) return found;
      await new Promise((resolve) => { waiters.push(resolve); });
    }
  };
  record.ready = async () => {
    record.senderPid = Number((await line('pid ')).slice(4));
    await line('armed');
    return record.senderPid;
  };
  context.after(async () => {
    // The supervisor itself is ours: end it. Then verify its sender is gone, and signal exactly that PID if it is not.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (record.senderPid === null) {
      const first = lines.find((value) => value.startsWith('pid '));
      if (first) record.senderPid = Number(first.slice(4));
    }
    if (record.senderPid !== null && !(await gone(record.senderPid))) {
      // Signal the recorded PID only on an exact identity match; otherwise leave it alone and fail.
      if (!isSender(record.senderPid, record.result)) {
        assert.fail(`PID ${record.senderPid} of ${name} is alive but is not this run's sender; it was not signalled`);
      }
      process.kill(record.senderPid, 'SIGKILL');
      assert.fail(`the sender ${record.senderPid} of ${name} outlived its supervisor and was killed`);
    }
  });
  return record;
}

async function waitForResult(file) {
  for (let waited = 0; waited < 5000; waited += 20) {
    const code = await readFile(file, 'utf8').catch(() => null);
    if (code !== null) return code;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

// A provider that dies while ALA is sending reports its write error asynchronously. ALA must treat it as a provider
// failure (exit 5), not let it escape as an unhandled channel error (exit 1 with a stack trace).
test('a provider killed while ALA is sending fails ALA with exit 5, never an unhandled channel error', async (context) => {
  const directory = await mkdtemp(join('/tmp', 'ala-ipc-kill-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = supervise(context, directory, `result-${attempt}`);
    await run.ready();
    run.child.kill('SIGKILL');
    await once(run.child, 'close');
    const code = await waitForResult(run.result);
    assert.equal(code, '5', `attempt ${attempt}: the sender ended with ${code}`);
  }
});

// Bounded cleanup of exactly the sender a supervisor started, on each way the supervisor can end.
test('the sender never outlives its supervisor: SIGKILL (sender watchdog), SIGTERM (supervisor cleanup)', async (context) => {
  const directory = await mkdtemp(join('/tmp', 'ala-ipc-clean-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  // SIGKILL cannot be handled by the supervisor. An idle sender has no provider logic to notice, so only its own
  // watchdog (parent gone) can end it, and it does so with exit code 98.
  const killed = supervise(context, directory, 'idle-killed', ['idle']);
  const killedPid = await killed.ready();
  assert.equal(isSender(killedPid, killed.result), true, 'the recorded PID is exactly this run\'s sender');
  // Identity is exact: another run's result file, or a process that merely mentions the fixture, never matches.
  assert.equal(isSender(killedPid, join(directory, 'another-run')), false);
  assert.equal(isSender(process.pid, killed.result), false);
  killed.child.kill('SIGKILL');
  await once(killed.child, 'close');
  assert.equal(await gone(killedPid), true, 'the sender disappears within the bound');
  assert.equal(await waitForResult(killed.result), '98');

  // SIGTERM is handled: the supervisor signals exactly its sender on the way out.
  const terminated = supervise(context, directory, 'terminated');
  const terminatedPid = await terminated.ready();
  assert.equal(isSender(terminatedPid, terminated.result), true, 'the recorded PID is exactly this run\'s sender');
  terminated.child.kill('SIGTERM');
  await once(terminated.child, 'close');
  assert.equal(await gone(terminatedPid), true, 'the sender disappears within the bound');
  // The supervisor's own cleanup killed it (SIGKILL runs no exit handler, so no result file exists); a sender ended by
  // its watchdog would have written 98, which would hide a missing cleanup.
  await assert.rejects(readFile(terminated.result, 'utf8'), { code: 'ENOENT' });

});
