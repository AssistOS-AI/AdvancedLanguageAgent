#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canStartSandbox, sandboxLabel } from '../src/coding-agents/sandbox-backend.mjs';
import { agentVariableNames } from '../tests/helpers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(projectRoot, 'tests');
const files = readdirSync(testsDirectory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort((left, right) => {
    if (left === 'sandbox.test.mjs') return -1;
    if (right === 'sandbox.test.mjs') return 1;
    return left.localeCompare(right);
  });

// Test children never see the caller's agent binaries, agent state, credentials or ALA configuration, so no test
// can reach an installed agent or link a real state folder into a sandbox. The tests also set these themselves.
const stripped = new Set(await agentVariableNames());
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !stripped.has(name)));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', path.join(testsDirectory, file)], {
    cwd: projectRoot,
    env: testEnv,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// Where ALA has a sandbox, a run in which none could start skipped every live sandbox test and proves little.
// ALA_TESTS_WITHOUT_SANDBOX=1 accepts such a run explicitly, for example inside a container without Bubblewrap.
if (['linux', 'darwin'].includes(process.platform) && process.env.ALA_TESTS_WITHOUT_SANDBOX !== '1'
    && !canStartSandbox(testEnv)) {
  process.stderr.write(`\nFAIL: ${sandboxLabel()} cannot start in this process, so every live sandbox test was `
    + 'skipped. Run the tests where a sandbox can start, or set ALA_TESTS_WITHOUT_SANDBOX=1 to accept this run.\n');
  process.exit(1);
}
