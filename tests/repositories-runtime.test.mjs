import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as achillesModule from 'ploinky-agent-lib';
import { createSkillRegistry, validateTaskRepository } from '../src/repositories.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { captureStream, writeCodeSkill } from './helpers.mjs';

test('executes general requests without a task repository', async (context) => {
  const calls = [];
  class FakeMainAgent {
    constructor(options) { calls.push(['construct', options.startDir]); }
    async buildSkills() { calls.push(['build']); }
    async executePrompt(prompt, options) { calls.push(['prompt', prompt, options]); return { result: 'general' }; }
    getSkillRecord() { return null; }
    cancelCurrentSession() {}
    shutdown() {}
  }
  const runtime = await createRuntime({
    achillesModule: { MainAgent: FakeMainAgent, discoverSkills() { return []; } },
    repositories: [],
    options: { tags: ['testing'] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());

  assert.deepEqual(runtime.skills, []);
  assert.equal((await runtime.execute('answer this')).result, 'general');
  assert.equal(calls[1][0], 'build');
  assert.deepEqual(calls[2].slice(0, 2), ['prompt', 'answer this']);
});

test('initializes the actual Achilles runtime with an empty skill catalog', async (context) => {
  const runtime = await createRuntime({
    achillesModule,
    repositories: [],
    options: { tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.deepEqual(runtime.skills, []);
});

test('aggregates independent task repositories for an actual Achilles MainAgent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-runtime-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await writeCodeSkill(first, 'echo', 'return `echo:${args.promptText}`;');
  await writeCodeSkill(second, 'upper', 'return args.promptText.toUpperCase();');
  assert.equal((await validateTaskRepository(first)).descriptorCount, 1);

  const runtime = await createRuntime({
    achillesModule,
    repositories: [first, second],
    options: { skill: 'upper', tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal(runtime.skills.length, 2);
  const result = await runtime.execute('hello');
  assert.equal(result.result, 'HELLO');
});

test('rejects duplicate canonical task-skill names across repositories', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-duplicate-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await writeCodeSkill(first, 'echo');
  await writeCodeSkill(second, 'echo');
  await assert.rejects(() => createSkillRegistry([first, second], achillesModule), /Duplicate task-skill/);
});

test('uses MainAgent prompt routing when no explicit skill is selected', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-fake-routing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeCodeSkill(root, 'echo');
  const calls = [];
  class FakeMainAgent {
    constructor(options) { calls.push(['construct', options.startDir]); }
    async buildSkills() { calls.push(['build']); }
    async executePrompt(prompt, options) { calls.push(['prompt', prompt, options]); return { result: 'routed' }; }
    getSkillRecord() { return null; }
    cancelCurrentSession() {}
    shutdown() {}
  }
  const fakeModule = {
    MainAgent: FakeMainAgent,
    discoverSkills() { return [{ name: 'echo-cskill', shortName: 'echo' }]; }
  };
  const runtime = await createRuntime({
    achillesModule: fakeModule,
    repositories: [root],
    options: { tags: ['testing'], model: 'fast' },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal((await runtime.execute('route me')).result, 'routed');
  assert.equal(calls[1][0], 'build');
  assert.deepEqual(calls[2].slice(0, 2), ['prompt', 'route me']);
  assert.deepEqual(calls[2][2].tags, ['testing']);
});
