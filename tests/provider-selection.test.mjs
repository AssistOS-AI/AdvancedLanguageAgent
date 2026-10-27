import test from 'node:test';
import assert from 'node:assert/strict';

import { ALAError, EXIT_CODES } from '../src/errors.mjs';
import { parseArguments } from '../src/arguments.mjs';
import { createProtocolProvider } from '../src/coding-agents/provider-client.mjs';
import { resolveProviderName, selectExecutionProvider } from '../src/coding-agents/provider-select.mjs';
import { createChannelPair, createFakeProvider } from './fake-provider.mjs';

function spies() {
  const built = [];
  return {
    built,
    dependencies: {
      createBubblewrapProvider: () => { built.push('bubblewrap'); return { kind: 'bubblewrap', start() {} }; },
      createProtocolProvider: () => { built.push('protocol'); return { kind: 'protocol', start() {} }; }
    }
  };
}

test('without a selection the standalone Bubblewrap provider is the default and the protocol is never inferred', () => {
  const { built, dependencies } = spies();
  const { client } = createChannelPair();
  // A connected control channel selects nothing: there is no auto-detection.
  assert.equal(selectExecutionProvider({ env: {}, channel: client, dependencies }).kind, 'bubblewrap');
  assert.deepEqual(built, ['bubblewrap']);
  assert.equal(resolveProviderName({ env: {} }), 'bubblewrap');
});

test('the option and the environment value select explicitly and the option wins', () => {
  const { built, dependencies } = spies();
  assert.equal(selectExecutionProvider({ env: { ALA_EXECUTION_PROVIDER: 'protocol' }, dependencies }).kind, 'protocol');
  assert.equal(selectExecutionProvider({ name: 'bubblewrap', env: { ALA_EXECUTION_PROVIDER: 'protocol' }, dependencies }).kind,
    'bubblewrap');
  assert.equal(selectExecutionProvider({ name: 'protocol', env: { ALA_EXECUTION_PROVIDER: 'bubblewrap' }, dependencies }).kind,
    'protocol');
  assert.deepEqual(built, ['protocol', 'bubblewrap', 'protocol']);
});

test('the protocol provider takes the environment it was selected with as the base of its additions', () => {
  const seen = [];
  const env = { SYNTHETIC_BASE: 'one' };
  selectExecutionProvider({ name: 'protocol', env, channel: { connected: true },
    dependencies: { createProtocolProvider: (options) => { seen.push(options); return { kind: 'protocol', start() {} }; } } });
  assert.equal(seen[0].baseEnv, env);
  assert.deepEqual(seen[0].channel, { connected: true });
});

test('selecting the protocol provider never constructs the Bubblewrap provider, so embedded mode never probes', () => {
  const { built, dependencies } = spies();
  selectExecutionProvider({ name: 'protocol', env: {}, dependencies });
  assert.deepEqual(built, ['protocol']);
});

test('an unknown or empty selection is a usage error, never a fallback', () => {
  for (const [name, env] of [['containerd', {}], ['', {}], [null, { ALA_EXECUTION_PROVIDER: 'Protocol' }],
    [null, { ALA_EXECUTION_PROVIDER: '' }], [null, { ALA_EXECUTION_PROVIDER: 'auto' }]]) {
    const { built, dependencies } = spies();
    assert.throws(() => selectExecutionProvider({ name, env, dependencies }),
      (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.usage && /must be bubblewrap or protocol/.test(error.message));
    assert.deepEqual(built, []);
  }
});

test('the protocol provider fails closed without a connected descriptor and does not fall back', () => {
  for (const channel of [null, {}, { send() {}, on() {}, connected: false }]) {
    assert.throws(() => createProtocolProvider({ channel }),
      (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.execution
        && /descriptor is missing/.test(error.message));
  }
  const { built, dependencies } = spies();
  const realProtocol = (options) => { built.push('protocol'); return createProtocolProvider(options); };
  assert.throws(() => selectExecutionProvider({ name: 'protocol', env: {}, channel: { connected: false },
    dependencies: { ...dependencies, createProtocolProvider: realProtocol } }), /descriptor is missing/);
  assert.deepEqual(built, ['protocol']);
});

test('a connected descriptor yields a protocol provider that sends hello first', async () => {
  const { client, server } = createChannelPair();
  const fake = createFakeProvider(server, {});
  const provider = selectExecutionProvider({ name: 'protocol', env: {}, channel: client });
  assert.equal(provider.kind, 'protocol');
  assert.deepEqual(await provider.inventory(), [{ name: 'codex', version: '0.1.0' }, { name: 'claude', version: '2.1.0' }]);
  assert.equal(fake.messages[0].type, 'hello');
  await provider.close();
});

test('the command line accepts the option for execution, agent and status commands and validates it', () => {
  assert.equal(parseArguments(['--execution-provider', 'protocol', 'task']).executionProvider, 'protocol');
  assert.equal(parseArguments(['agent', 'list', '--execution-provider', 'protocol']).executionProvider, 'protocol');
  assert.equal(parseArguments(['agent', 'models', 'codex', '--execution-provider', 'bubblewrap']).executionProvider, 'bubblewrap');
  assert.equal(parseArguments(['status', '--execution-provider', 'protocol']).executionProvider, 'protocol');
  assert.equal(parseArguments(['task']).executionProvider, undefined);
  for (const argv of [['--execution-provider', 'docker'], ['agent', 'list', '--execution-provider', 'x'], ['status', '--execution-provider']]) {
    assert.throws(() => parseArguments(argv), (error) => error instanceof ALAError && error.exitCode === EXIT_CODES.usage);
  }
});
