import test from 'node:test';
import assert from 'node:assert/strict';

import { defineAgent } from '../src/coding-agents/define-agent.mjs';
import { AGENT_NAMES, AGENTS, enumerate, getAgent } from '../src/coding-agents/registry.mjs';

test('registry keeps the fixed agent order and resolves names', () => {
  assert.deepEqual(AGENT_NAMES, ['codex', 'opencode', 'pi', 'omp', 'claude']);
  assert.equal(getAgent('pi').label, 'Pi');
  assert.equal(getAgent('unknown'), null);
});

test('enumerate formats agent lists for messages', () => {
  assert.equal(enumerate(['a']), 'a');
  assert.equal(enumerate(['a', 'b'], { word: 'and' }), 'a and b');
  assert.equal(enumerate(['a', 'b', 'c']), 'a, b, or c');
  assert.equal(enumerate(['a', 'b', 'c'], { serial: false }), 'a, b or c');
});

for (const agent of AGENTS) {
  test(`${agent.name} descriptor satisfies the agent contract`, async () => {
    assert.deepEqual(agent.login.files.filter((file) => file.startsWith('/')), []);
    const state = agent.state({}, '/host');
    assert.ok(state.length > 0);
    assert.ok(state.every(({ source, target }) => source.startsWith('/host/') && target.startsWith('/home/ala/')));
    assert.ok(state.filter(({ login }) => login).length <= 1);
    assert.ok(agent.sandbox.credentialEnv.every((name) => agent.sandbox.envAllow.includes(name)));
    assert.equal(typeof await agent.login.detect('/nonexistent/ala-agent-state'), 'boolean');
    const adapter = await agent.adapter();
    assert.equal(typeof adapter.run, 'function');
    assert.equal(typeof adapter.listModels, 'function');
    assert.ok(adapter.runLive === undefined || typeof adapter.runLive === 'function');
  });
}

test('defineAgent rejects an incomplete descriptor', () => {
  assert.throws(() => defineAgent({ name: 'partial', label: 'Partial' }), /partial is missing description/);
  assert.throws(() => defineAgent({ name: 'Bad Name' }), /missing a lowercase name/);
});
