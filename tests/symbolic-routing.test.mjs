import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime } from '../src/runtime.mjs';
import { createSymbolicRouter, extractRepresentation } from '../src/routing/symbolic.mjs';
import { captureStream, writeAnthropicSkill } from './helpers.mjs';

test('extracts instruction-only symbolic evidence and supports safe abstention', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-symbolic-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const skillDir = await writeAnthropicSkill(root, 'translate', {
    body: '# Translate\n\n## Symbolic Routing\nactions: translate\nobjects: document, text\ntargets: romanian\nphrases: translate document\nconflicts: summarize'
  });
  const descriptor = join(skillDir, 'SKILL.md');
  const records = [{ name: 'translate', filePath: descriptor }];
  const router = await createSymbolicRouter(records);
  const representation = extractRepresentation('Translate this document to Romanian');
  assert.deepEqual(representation.targets, ['romanian']);
  assert.equal(router.route('Translate this document').state, 'DETERMINISTIC');
  assert.equal(router.route('Summarize this document').state, 'UNKNOWN');
});

test('symbolic detection selects a skill while unknown requests use coding-agent catalog selection', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-symbolic-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const skillDir = await writeAnthropicSkill(root, 'translate', {
    body: '# Translate\n\n## Symbolic Routing\nactions: translate\nphrases: translate document'
  });
  const calls = [];
  class FakeMainAgent {
    constructor() {}
    async buildSkills() {}
    async executeSkill(name, prompt) { calls.push(['skill', name, prompt]); return { result: 'skill' }; }
    async executePrompt(prompt) { calls.push(['main', prompt]); return { result: 'main' }; }
    getSkillRecord() { return null; }
    cancelCurrentSession() {}
    shutdown() {}
  }
  const runtime = await createRuntime({
    achillesModule: {
      MainAgent: FakeMainAgent,
      discoverSkills() { return []; }
    },
    repositories: [root],
    codingAgents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    options: { tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal((await runtime.execute('Translate this document', { instruction: 'Translate this document' })).result, 'skill');
  runtime.setSymbolicDetection(true);
  assert.equal((await runtime.execute('Translate this document', { instruction: 'Translate this document' })).result, 'skill');
  assert.equal((await runtime.execute('Summarize this document', { instruction: 'Summarize this document' })).result, 'skill');
  assert.deepEqual(calls.map((call) => call[0]), ['skill', 'skill', 'skill']);
  assert.equal(calls[1][1], 'coding-agent');
  assert.match(calls[1][2], /\.agents\/skills\/translate\/SKILL\.md/u);
});
