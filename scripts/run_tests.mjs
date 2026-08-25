#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDirectory = path.join(projectRoot, 'tests');
const files = readdirSync(testsDirectory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort((left, right) => {
    if (left === 'sandbox.test.mjs') return -1;
    if (right === 'sandbox.test.mjs') return 1;
    return left.localeCompare(right);
  });

for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', path.join(testsDirectory, file)], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
