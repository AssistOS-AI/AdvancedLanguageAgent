import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guarantees of the execution-provider contract: process creation exists only inside provider
// implementations, and the embedded (protocol) path cannot reach the Bubblewrap code.
const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

async function sources(directory = sourceRoot) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (entry.name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

const importsOf = (text) => [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]);

test('child_process is imported only by the Bubblewrap provider and the Bubblewrap capability probe', async () => {
  const importers = [];
  for (const file of await sources()) {
    const text = await readFile(file, 'utf8');
    const specifiers = importsOf(text);
    if (specifiers.some((value) => /^(node:)?(child_process|cluster|worker_threads)$/u.test(value))) {
      importers.push(relative(sourceRoot, file));
    }
    assert.equal(/\b(?:Bun|Deno)\.(?:spawn|run|Command)\b|process\.binding\s*\(/u.test(text), false, `${file} starts a process`);
  }
  assert.deepEqual(importers.sort(), ['coding-agents/provider-bubblewrap.mjs', 'coding-agents/sandbox.mjs']);
});

test('the protocol path does not import the Bubblewrap launcher, its probes or any process-start helper', async () => {
  const protocolFiles = ['coding-agents/provider-client.mjs', 'coding-agents/provider-process.mjs',
    'coding-agents/provider-request.mjs', 'coding-agents/provider.mjs', 'coding-agents/virtual-paths.mjs', 'embedded-mode.mjs'];
  for (const file of protocolFiles) {
    const specifiers = importsOf(await readFile(join(sourceRoot, file), 'utf8'));
    assert.deepEqual(specifiers.filter((value) => /sandbox|bubblewrap|process\.mjs$|folders|ignored-paths/u.test(value)
      && !/provider-process\.mjs$/u.test(value)), [], `${file} reaches Bubblewrap or direct process code`);
  }
});

test('the direct-start branch is gone: process.mjs only delegates to the provider', async () => {
  const text = await readFile(join(sourceRoot, 'coding-agents/process.mjs'), 'utf8');
  assert.equal(importsOf(text).some((value) => /child_process|sandbox\.mjs/u.test(value)), false);
  assert.match(text, /provider\.start\(/u);
});

test('an injected spawn function is read only by selectSpawn, its adapters and the provider test seam', async () => {
  const readers = [];
  for (const file of await sources()) {
    const text = await readFile(file, 'utf8');
    if (/\bspawnImpl\b/u.test(text)) readers.push(relative(sourceRoot, file));
    if (!file.endsWith('coding-agents/process.mjs') && /input\.spawnImpl\s*\|\|/u.test(text)) assert.fail(`${file} reads spawnImpl without selectSpawn`);
  }
  assert.deepEqual(readers.sort(), ['coding-agents/claude.mjs', 'coding-agents/json-channel.mjs',
    'coding-agents/provider-bubblewrap.mjs', 'coding-agents/process.mjs'].sort());
});
