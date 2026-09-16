import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';

for (const name of ['codex', 'opencode', 'pi']) {
  test(name + ' receives the skills instruction only at native conversation start', async t => {
    const calls = [];
    const record = {};
    const sessionState = { record, save: async patch => Object.assign(record, patch) };
    const runners = { [name]: async input => {
      calls.push(input);
      return { outputText: 'done', continuation: { id: 'native-conversation' } };
    } };
    const options = { agents: [{ name, available: true, binary: '/fake/' + name }],
      isolatedSkills: true, sessionState, runners };
    const first = createCodingAgentService(options);
    t.after(() => first.close());
    await first.execute('First request');
    assert.equal(calls[0].prompt, 'Task skills are mounted in .agents/skills. Read the relevant SKILL.md files and follow their instructions when applicable.\n\nFirst request');
    await first.execute('Second request');
    assert.equal(calls[1].prompt, 'Second request');
    await first.close();
    const resumed = createCodingAgentService(options);
    t.after(() => resumed.close());
    await resumed.execute('After process restart');
    assert.equal(calls[2].prompt, 'After process restart');
    assert.deepEqual(calls[2].continuation, record.continuation);
  });
}

test('failed launch without continuation preserves the instruction for the next attempt', async t => {
  const calls = [];
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }], isolatedSkills: true,
    runners: { codex: async input => {
      calls.push(input.prompt);
      if (calls.length === 1) throw new Error('Launch failed');
      return { outputText: 'done', continuation: { threadId: 'accepted' } };
    } }
  });
  t.after(() => service.close());
  await assert.rejects(service.execute('Request'), /Launch failed/);
  await service.execute('Request');
  assert.equal(calls[0], calls[1]);
  assert.match(calls[1], /^Task skills are mounted/);
});
