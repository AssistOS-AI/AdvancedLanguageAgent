import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime } from '../src/runtime.mjs';
import { createSymbolicRouter, extractRepresentation } from '../src/routing/symbolic.mjs';
import { captureStream, writeCodeSkill } from './helpers.mjs';

test('extracts instruction-only symbolic evidence and supports safe abstention', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-symbolic-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const skillDir = await writeCodeSkill(root, 'translate');
  const descriptor = join(skillDir, 'cskill.md');
  await appendFile(descriptor, '\n## Symbolic Routing\nactions: translate\nobjects: document, text\ntargets: romanian\nphrases: translate document\nconflicts: summarize\n');
  const records = [{ name: 'translate-cskill', filePath: descriptor }];
  const router = await createSymbolicRouter(records);
  const representation = extractRepresentation('Translate this document to Romanian');
  assert.deepEqual(representation.targets, ['romanian']);
  assert.equal(router.route('Translate this document').state, 'DETERMINISTIC');
  assert.equal(router.route('Summarize this document').state, 'UNKNOWN');
});

test('symbolic detection routes confident matches and falls back to MainAgent', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-symbolic-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const skillDir = await writeCodeSkill(root, 'translate');
  const descriptor = join(skillDir, 'cskill.md');
  await appendFile(descriptor, '\n## Symbolic Routing\nactions: translate\nphrases: translate document\n');
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
      discoverSkills() { return [{ name: 'translate-cskill', filePath: descriptor }]; }
    },
    repositories: [root],
    options: { tags: [] },
    diagnostics: captureStream()
  });
  context.after(() => runtime.close());
  assert.equal((await runtime.execute('Translate this document', { instruction: 'Translate this document' })).result, 'main');
  runtime.setSymbolicDetection(true);
  assert.equal((await runtime.execute('Translate this document', { instruction: 'Translate this document' })).result, 'skill');
  assert.equal((await runtime.execute('Summarize this document', { instruction: 'Summarize this document' })).result, 'main');
  assert.deepEqual(calls.map((call) => call[0]), ['main', 'skill', 'main']);
});
