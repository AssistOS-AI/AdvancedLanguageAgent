import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAchillesAgentLib } from '../src/achilles-loader.mjs';

test('resolves AchillesAgentLib through a supported installed strategy', async () => {
  const resolved = await loadAchillesAgentLib({ env: {}, cwd: process.cwd() });
  assert.ok(['parent-directory', 'package'].includes(resolved.strategy));
  assert.equal(typeof resolved.module.MainAgent, 'function');
  assert.equal(typeof resolved.module.discoverSkills, 'function');
});

test('reports an invalid explicit AchillesAgentLib path without falling back', async () => {
  await assert.rejects(
    () => loadAchillesAgentLib({ overridePath: './missing-achilles', env: {}, cwd: process.cwd() }),
    /Could not resolve AchillesAgentLib/
  );
});
