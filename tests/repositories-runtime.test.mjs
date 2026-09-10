import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as achillesModule from 'ploinky-agent-lib';
import { createSkillRegistry, validateTaskRepository } from '../src/repositories.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { captureStream, writeAnthropicSkill, writeCodeSkill } from './helpers.mjs';

class FakeMainAgent {
  constructor(options) { this.calls = options.calls || []; }
  async buildSkills() { this.calls.push(['build']); }
  async executePrompt(prompt, options) { this.calls.push(['prompt', prompt, options]); return { result: 'general' }; }
  async executeSkill(name, prompt, options) { this.calls.push(['skill', name, prompt, options]); return { result: 'delegated' }; }
  cancelCurrentSession() {}
  shutdown() {}
}

function fakeAchilles(calls) {
  return {
    MainAgent: class extends FakeMainAgent {
      constructor(options) { super({ ...options, calls }); }
    },
    discoverSkills() { return []; }
  };
}

test('executes general requests without a task repository', async (context) => {
  const calls = [];
  const runtime = await createRuntime({
    achillesModule: fakeAchilles(calls),
    repositories: [],
    options: { tags: ['testing'] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());

  assert.deepEqual(runtime.skills, []);
  assert.equal((await runtime.execute('answer this')).result, 'general');
  assert.equal(calls[0][0], 'build');
  assert.deepEqual(calls[1].slice(0, 2), ['prompt', 'answer this']);
});

test('forwards only Achilles tool name and reason from supervisor progress', async (context) => {
  const events = [];
  let mainAgentOptions;
  const runtime = await createRuntime({
    achillesModule: {
      MainAgent: class extends FakeMainAgent {
        constructor(options) {
          super({ ...options, calls: [] });
          mainAgentOptions = options;
        }
      },
      discoverSkills() { return []; }
    },
    repositories: [],
    options: { tags: [] },
    diagnostics: captureStream(),
    eventSink: (event) => events.push(event)
  });
  context.after(() => runtime.close());

  await mainAgentOptions.supervisor.getOutputWriter().write({
    type: 'tool_reason', tool: 'coding-agent', reason: 'Needs a coding backend.', stepIndex: 4, secret: 'omit'
  });
  assert.deepEqual(events, [{
    type: 'agentlib-tool', tool: 'coding-agent', reason: 'Needs a coding backend.'
  }]);
});

test('initializes the actual Achilles runtime with an empty task catalog', async (context) => {
  const runtime = await createRuntime({
    achillesModule,
    repositories: [],
    options: { tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.deepEqual(runtime.skills, []);
});

test('discovers recursive Anthropic SKILL.md descriptors and delegates explicit execution', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-runtime-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, 'skills', 'writing');
  await writeAnthropicSkill(nested, 'blog-post', { description: 'Write a structured blog post.' });
  const validation = await validateTaskRepository(root);
  assert.equal(validation.descriptorCount, 1);
  assert.equal(validation.skills[0].name, 'blog-post');

  const calls = [];
  const runtime = await createRuntime({
    achillesModule: fakeAchilles(calls),
    repositories: [root],
    codingAgents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    options: { skill: 'blog-post', tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal(runtime.skills.length, 1);
  assert.equal((await runtime.execute('write about testing')).result, 'delegated');
  assert.equal(calls[1][1], 'coding-agent');
  assert.match(calls[1][2], /\.agents\/skills\/blog-post\/SKILL\.md/u);
  assert.match(calls[1][2], /write about testing/u);
});

test('rejects AchillesAgentLib descriptors when no Anthropic SKILL.md exists', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-achilles-only-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeCodeSkill(root, 'echo');
  await assert.rejects(() => validateTaskRepository(root), /no Anthropic SKILL\.md descriptors/u);
});

test('requires a coding agent for explicit Anthropic task-skill execution', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-no-agent-skill-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeAnthropicSkill(root, 'echo');
  const runtime = await createRuntime({
    achillesModule: fakeAchilles([]),
    repositories: [root],
    codingAgents: [],
    options: { skill: 'echo', tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  await assert.rejects(() => runtime.execute('hello'), /require an available coding agent/u);
});

test('rejects duplicate Anthropic skill names across repositories', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-duplicate-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await writeAnthropicSkill(first, 'echo');
  await writeAnthropicSkill(second, 'echo');
  await assert.rejects(() => createSkillRegistry([first, second]), /Duplicate task-skill/);
});

test('asks a coding agent to select from the Anthropic catalog by default', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-fake-routing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeAnthropicSkill(root, 'echo', { description: 'Echo supplied text.' });
  const calls = [];
  const runtime = await createRuntime({
    achillesModule: fakeAchilles(calls),
    repositories: [root],
    codingAgents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    options: { tags: ['testing'], model: 'fast' },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal((await runtime.execute('route me')).result, 'delegated');
  assert.deepEqual(calls[1].slice(0, 2), ['skill', 'coding-agent']);
  assert.match(calls[1][2], /Use the skills in \.agents\/skills/u);
  assert.doesNotMatch(calls[1][2], /Echo supplied text/);
  assert.match(calls[1][2], /User request:\nroute me/u);
  assert.deepEqual(calls[1][3].tags, ['testing']);
});

test('refreshes task repositories without recreating the interactive runtime', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-runtime-refresh-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await writeAnthropicSkill(first, 'first-skill', { description: 'Use the first method.' });
  await writeAnthropicSkill(second, 'second-skill', { description: 'Use the second method.' });
  const calls = [];
  const runtime = await createRuntime({
    achillesModule: fakeAchilles(calls),
    repositories: [first],
    codingAgents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    options: { tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());

  runtime.setSymbolicDetection(true);
  await runtime.refreshRepositories([second]);
  assert.deepEqual(runtime.skills.map((skill) => skill.name), ['second-skill']);
  assert.equal(runtime.getSymbolicDetection(), true);
  await runtime.execute('route after refresh');
  assert.match(calls.at(-1)[2], /Use the skills in \.agents\/skills/u);
  assert.doesNotMatch(calls.at(-1)[2], /Use the second method/);
  assert.doesNotMatch(calls.at(-1)[2], /first-skill/u);
});

test('resolved skill names remain an exact selection across repository refreshes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ala-skillset-members-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeAnthropicSkill(root, 'read-report');
  await writeAnthropicSkill(root, 'write-report');
  const runtime = await createRuntime({
    achillesModule: fakeAchilles([]), repositories: [root],
    options: { skillSets: 'read-report', tags: ['testing'] }, diagnostics: captureStream()
  });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.skills.map(skill => skill.name), ['read-report']);
  await runtime.refreshRepositories([root]);
  assert.deepEqual(runtime.skills.map(skill => skill.name), ['read-report']);
  await assert.rejects(runtime.refreshRepositories([]), /Task skills not found: read-report/);
  assert.deepEqual(runtime.skills.map(skill => skill.name), ['read-report']);
});


test('ALA alone wraps mounted skills and honors explicit skill selection with a backend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ala-skill-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeAnthropicSkill(root, 'review');
  for (const skill of [undefined, 'review', 'missing']) {
    const calls = [];
    const runtime = await createRuntime({
      achillesModule: fakeAchilles(calls), repositories: [root],
      codingAgents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
      options: { agent: 'codex', skill, tags: [] }, diagnostics: captureStream()
    });
    try {
      if (skill === 'missing') {
        await assert.rejects(runtime.execute('Inspect'), /Task skill not found/);
        continue;
      }
      await runtime.execute('Inspect');
      const prompt = calls.find(call => call[0] === 'skill')[2];
      assert.equal(prompt.split('User request:').length, 2);
      assert.match(prompt, /Inspect/);
      if (skill) {
        assert.match(prompt, /Execute the user request with the Anthropic-style skill "review"/);
        assert.doesNotMatch(prompt, /Available skills:/);
      } else {
        assert.match(prompt, /Use the skills in \.agents\/skills/);
        assert.doesNotMatch(prompt, /review test skill|Available skills:/);
      }
    } finally { await runtime.close(); }
  }
});
