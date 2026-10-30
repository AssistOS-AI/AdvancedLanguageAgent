import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_NAMES, AGENTS } from '../src/coding-agents/registry.mjs';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const agentsRoot = join(src, 'coding-agents', 'agents');
const moduleFiles = async (directory) => (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => join(entry.parentPath, entry.name));
const relativeImports = (source) => [...source.matchAll(/(?:from\s+|import\(\s*)'(\.[^']+)'/gu)].map((match) => match[1]);

test('generic modules name no coding agent', async () => {
  const identifiers = AGENTS.flatMap((agent) => [agent.name, agent.label]);
  const pattern = new RegExp(`\\b(${identifiers.join('|')})\\b`, 'iu');
  const generic = (await moduleFiles(src)).filter((file) => !file.startsWith(`${agentsRoot}/`)
    && relative(src, file) !== join('coding-agents', 'registry.mjs'));
  assert.ok(generic.length > 0);
  for (const file of generic) {
    const offending = (await readFile(file, 'utf8')).split('\n').filter((line) => pattern.test(line));
    assert.deepEqual(offending, [], relative(src, file));
  }
});

test('an agent imports only shared infrastructure and its own folder', async () => {
  // OMP speaks the Pi protocol; this is the one declared dependency between agents.
  const allowedAgentImports = { omp: ['pi'] };
  for (const name of AGENT_NAMES) {
    for (const file of await moduleFiles(join(agentsRoot, name))) {
      for (const specifier of relativeImports(await readFile(file, 'utf8'))) {
        const target = relative(agentsRoot, resolve(dirname(file), specifier));
        if (target.startsWith('..') || !target.includes('/')) continue;
        const owner = target.split('/')[0];
        assert.ok(owner === name || allowedAgentImports[name]?.includes(owner), `${file} imports ${specifier}`);
      }
    }
  }
});

test('a descriptor imports no process or adapter code', async () => {
  const pure = ['define-agent.mjs', 'login-helpers.mjs', 'paths.mjs', 'provider-environment.mjs'];
  for (const name of AGENT_NAMES) {
    const source = await readFile(join(agentsRoot, name, 'index.mjs'), 'utf8');
    const statics = [...source.matchAll(/from\s+'(\.[^']+)'/gu)].map((match) => match[1].split('/').at(-1));
    assert.deepEqual(statics.filter((file) => !pure.includes(file)), [], name);
  }
});
