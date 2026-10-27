import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../src/cli.mjs';
import { EXIT_CODES } from '../src/errors.mjs';
import { discoverProviderAgents } from '../src/coding-agents/discovery.mjs';
import { piSessionDirectory } from '../src/coding-agents/pi.mjs';
import { resolveVirtualFolders, resolveVirtualHome, virtualPathProblem } from '../src/coding-agents/virtual-paths.mjs';
import { createProtocolProvider } from '../src/coding-agents/provider-client.mjs';
import { createChannelPair, createFakeProvider } from './fake-provider.mjs';
import { captureStream, inputStream } from './helpers.mjs';

// Embedded mode: the protocol provider owns the filesystem, so ALA works on virtual paths, touches none of them and
// refuses every input or command that would make it read or write the host.
const CODEX_RUN = [
  { type: 'thread.started', thread_id: 'thread-embedded' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'hello from the provider' } }
].map((event) => `${JSON.stringify(event)}\n`).join('');

function codexModels({ request, stdin, stdout, exit }) {
  if (request.args.includes('exec')) { stdout.write(CODEX_RUN); exit(0); return; }
  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk;
    for (const line of buffer.split('\n').slice(0, -1)) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      if (message.method === 'model/list') {
        stdout.write(`${JSON.stringify({ id: message.id, result: { data: [{ id: 'gpt-fixture',
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] } })}\n`);
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
}

async function harness(context, providerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ala-embedded-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  await writeFile(config, '{}\n');
  const previous = process.env.ALA_SESSIONS;
  process.env.ALA_SESSIONS = join(root, 'sessions');
  context.after(() => { if (previous === undefined) delete process.env.ALA_SESSIONS; else process.env.ALA_SESSIONS = previous; });
  const h = { root, config, fakes: [], base: ['--execution-provider', 'protocol', '--config', config] };
  // Every invocation gets its own descriptor, as every orchestration domain does; closing it ends the channel.
  h.run = async (argv, { stdin = inputStream(''), env = process.env } = {}) => {
    const { client, server } = createChannelPair();
    const fake = createFakeProvider(server, { behavior: codexModels, ...providerOptions });
    h.fakes.push(fake);
    h.fake = fake;
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({ argv, env, stdin, stdout, stderr, cwd: root, providerChannel: client });
    return { code, stdout: stdout.read(), stderr: stderr.read(), fake };
  };
  return h;
}

test('an embedded task runs on virtual paths and the host filesystem is never touched', async (context) => {
  const h = await harness(context);
  const result = await h.run([...h.base, '--cwd', '/projects/g', '--home', '/home/robot', '--folder', '/projects/ref',
    '--folder', '/projects/rw', 'write', '--ignore', '/projects/g/private', '--task', 'hello']);
  assert.equal(result.code, EXIT_CODES.success, result.stderr);
  assert.equal(result.stdout.trim(), 'hello from the provider');
  assert.equal(h.fake.starts.length, 1);
  const { request } = h.fake.starts[0];
  assert.equal(request.processClass, 'run');
  assert.equal(request.executable, 'codex', 'a backend name, never a host path');
  assert.equal(request.cwd, '/projects/g');
  assert.equal(request.home, '/home/robot');
  assert.deepEqual(request.folders, [{ path: '/projects/ref', access: 'read' }, { path: '/projects/rw', access: 'write' }]);
  assert.deepEqual(request.exclusions, ['/projects/g/private']);
  assert.deepEqual(request.env, {}, 'no value of ALA\'s own environment crosses the protocol');
  assert.equal(JSON.stringify(h.fake.messages).includes(h.root), false, 'no host path reaches the provider');
  for (const path of ['/projects', '/projects/g']) await assert.rejects(access(path), { code: 'ENOENT' });
});

test('the additions base is the environment runCli was given, not the process environment', async (context) => {
  const h = await harness(context);
  const synthetic = { ALA_SESSIONS: join(h.root, 'sessions'), SYNTHETIC_SENTINEL: 'not-a-real-value' };
  const result = await h.run([...h.base, '--cwd', '/projects/g', '--task', 'hello'], { env: synthetic });
  assert.equal(result.code, EXIT_CODES.success, result.stderr);
  assert.deepEqual(h.fake.starts[0].request.env, {});
  assert.equal(JSON.stringify(h.fake.messages).includes('not-a-real-value'), false);
});

test('without a working directory the provider supplies a private temporary directory', async (context) => {
  const h = await harness(context);
  const result = await h.run([...h.base, '--task', 'hello']);
  assert.equal(result.code, EXIT_CODES.success, result.stderr);
  assert.deepEqual(h.fake.messages.map((message) => message.type), ['hello', 'inventory', 'tempdir', 'start']);
  assert.equal(h.fake.starts[0].request.cwd, '/tmp/ala-execution-1');
});

const refusals = [
  [['--file', 'notes.txt'], /--file is not available/],
  [['--url', 'https://example.com/x'], /--url is not available/],
  [['--taskFile', 'task.md'], /--taskFile is not available/],
  [['--output', 'out.txt'], /--output is not available/],
  [['--cwd', '/projects/g', 'as', 'alias'], /--cwd as is not available/],
  [['--cwd', 'relative/dir'], /--cwd must be an absolute path/],
  [['--cwd', '/projects/../etc'], /--cwd must be normalized/],
  [['--home', '/home/other'], /--home must be \/home\/robot/],
  [['--folder', '/projects/ref', 'as', 'alias'], /--folder as, at and expose are not available/],
  [['--folder', '/projects/ref', 'at', '/mnt/ref'], /--folder as, at and expose are not available/],
  [['--folder', 'relative'], /--folder must be an absolute path/],
  [['--folder', '/home/robot/sub'], /conflicts with the robot HOME/],
  [['--folder', '/projects/a', '--folder', '/projects/a/b'], /destinations overlap/],
  [['--ignore', 'relative'], /--ignore must be an absolute path/]
];
for (const [extra, expected] of refusals) {
  test(`embedded mode refuses ${extra.join(' ')} before any process starts`, async (context) => {
    const h = await harness(context);
    const cwd = extra.includes('--cwd') ? [] : ['--cwd', '/projects/g'];
    const result = await h.run([...h.base, ...cwd, ...extra, '--task', 'hello']);
    assert.equal(result.code, EXIT_CODES.usage, result.stderr);
    assert.match(result.stderr, expected);
    assert.equal(result.fake.starts.length, 0);
  });
}

test('embedded mode requires an absolute session location and an existing absolute managed configuration', async (context) => {
  const h = await harness(context);
  const argv = ['--execution-provider', 'protocol', '--cwd', '/projects/g', '--task', 'hello'];
  const missingSessions = { ...process.env };
  delete missingSessions.ALA_SESSIONS;
  const cases = [
    [[...argv, '--config', h.config], missingSessions, /requires ALA_SESSIONS/],
    [[...argv, '--config', h.config], { ...process.env, ALA_SESSIONS: 'relative/sessions' }, /requires ALA_SESSIONS/],
    [argv, process.env, /requires --config/],
    [[...argv, '--config', 'config.json'], process.env, /requires --config/],
    [[...argv, '--config', join(h.root, 'missing.json')], process.env, /managed configuration file is unavailable/]
  ];
  for (const [args, env, expected] of cases) {
    const result = await h.run(args, { env });
    assert.equal(result.code, EXIT_CODES.usage, result.stderr);
    assert.match(result.stderr, expected);
  }
  assert.equal(h.fakes.every((fake) => fake.starts.length === 0), true);
});

test('embedded interactive commands cannot change the stored configuration and the file stays byte-identical', async (context) => {
  const h = await harness(context);
  const before = await readFile(h.config, 'utf8');
  const stdin = inputStream(['/agent use claude', '/agent codex model gpt-x', '/agent codex effort high', '/status', '/exit', ''].join('\n'));
  const result = await h.run([...h.base, '--cwd', '/projects/g', '--interactive'], { stdin });
  assert.equal(result.code, EXIT_CODES.success, result.stderr);
  for (const command of ['/agent use', '/agent codex model', '/agent codex effort', '/status']) {
    assert.match(result.stderr, new RegExp(`${command} is not available when an execution provider owns the configuration`));
  }
  assert.equal(await readFile(h.config, 'utf8'), before);
  assert.equal(h.fake.starts.length, 0);
});

test('embedded status is refused because logins live in the workload filesystem', async (context) => {
  const h = await harness(context);
  const result = await h.run(['status', '--execution-provider', 'protocol']);
  assert.equal(result.code, EXIT_CODES.usage);
  assert.match(result.stderr, /ala status is not available when an execution provider owns the configuration/);
});

test('embedded agent list and models use the provider inventory and a provider temporary directory', async (context) => {
  const h = await harness(context);
  const list = await h.run(['agent', 'list', '--json', '--execution-provider', 'protocol']);
  assert.equal(list.code, EXIT_CODES.success, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), ['codex', 'claude']);
  const models = await h.run(['agent', 'models', 'codex', '--json', '--execution-provider', 'protocol']);
  assert.equal(models.code, EXIT_CODES.success, models.stderr);
  assert.deepEqual(JSON.parse(models.stdout), [{ id: 'gpt-fixture', efforts: ['high'], defaultEffort: 'high' }]);
  assert.equal(models.fake.starts.at(-1).request.processClass, 'session');
  assert.equal(models.fake.starts.at(-1).request.cwd, '/tmp/ala-execution-1');
  const missing = await h.run(['agent', 'models', 'pi', '--execution-provider', 'protocol']);
  assert.equal(missing.code, EXIT_CODES.execution);
  assert.match(missing.stderr, /Coding agent is not available: pi/);
});

test('a missing descriptor ends a protocol-selected command with an execution error and no fallback', async (context) => {
  const h = await harness(context);
  const missing = { connected: false };
  for (const argv of [['agent', 'list', '--execution-provider', 'protocol'],
    ['agent', 'models', 'codex', '--execution-provider', 'protocol'],
    ['--execution-provider', 'protocol', '--config', h.config, '--cwd', '/projects/g', '--task', 'x']]) {
    const stderr = captureStream();
    const code = await runCli({ argv, env: process.env,
      stdin: inputStream(''), stdout: captureStream(), stderr, cwd: h.root, providerChannel: missing });
    assert.equal(code, EXIT_CODES.execution, argv.join(' '));
    assert.match(stderr.read(), /descriptor is missing/);
  }
});

test('virtual path rules accept only normalized absolute POSIX paths', () => {
  for (const good of ['/', '/projects', '/projects/g/src', '/a.b/c_d']) assert.equal(virtualPathProblem(good), null, good);
  for (const bad of ['', 'a', './a', '/a/', '/a//b', '/a/./b', '/a/../b', '/a\0b', 3, null, undefined]) {
    assert.notEqual(virtualPathProblem(bad), null, String(bad));
  }
  assert.equal(resolveVirtualHome(undefined), '/home/robot');
  assert.throws(() => resolveVirtualHome('/home/ala'), /--home must be \/home\/robot/);
  assert.deepEqual(resolveVirtualFolders([{ source: '/projects/ref' }, { source: '/projects/rw', writable: true }]), [
    { source: '/projects/ref', target: '/projects/ref', writable: false },
    { source: '/projects/rw', target: '/projects/rw', writable: true }]);
  assert.deepEqual(resolveVirtualFolders([{ source: '/projects' }], { cwd: '/projects/g' }).length, 1,
    'a read-only ancestor may contain the working directory');
  assert.throws(() => resolveVirtualFolders([{ source: '/projects/g' }], { cwd: '/projects/g' }), /duplicates the working directory/);
});

test('Pi keeps its native sessions under the provider HOME and ALA creates no directory on the host', () => {
  assert.deepEqual(piSessionDirectory({ workspace: '/projects/g', hostWorkspace: null, sandbox: { home: '/home/robot' } }),
    { sessionDir: '/home/robot/.ala-pi-sessions', hosted: false });
  assert.deepEqual(piSessionDirectory({ workspace: '/w', hostWorkspace: '/w', sandbox: {} }),
    { sessionDir: '/w/.ala-pi-sessions', hosted: true });
});

test('provider inventory becomes the fixed-order agent list referred to by name', async () => {
  const { client, server } = createChannelPair();
  createFakeProvider(server, { inventory: [{ name: 'claude', version: '2.1.0' }, { name: 'pi' }] });
  const provider = createProtocolProvider({ channel: client });
  assert.deepEqual(await discoverProviderAgents(provider), [
    { name: 'codex', available: false, binary: null },
    { name: 'opencode', available: false, binary: null },
    { name: 'pi', available: true, binary: 'pi' },
    { name: 'claude', available: true, binary: 'claude', version: '2.1.0' }
  ]);
  await provider.close();
});
