import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composePrompt, loadRequest } from '../src/input.mjs';
import { writeResult } from '../src/output.mjs';
import { captureStream, inputStream } from './helpers.mjs';

test('uses stdin as the instruction when no explicit request is supplied', async () => {
  const request = await loadRequest({ instructionParts: [], sources: [], stdin: inputStream('Summarize this') });
  assert.deepEqual(request, { instruction: 'Summarize this', sources: [] });
});

test('uses stdin as instruction while loading other explicit payload sources', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-stdin-instruction-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'payload.md'), 'payload');
  const request = await loadRequest({
    instructionParts: [],
    sources: [{ type: 'file', value: 'payload.md' }],
    stdin: inputStream('Analyze'),
    cwd: root
  });
  assert.equal(request.instruction, 'Analyze');
  assert.equal(request.sources[0].content, 'payload');
});

test('classifies an unreadable input file as an input error', async () => {
  await assert.rejects(
    () => loadRequest({
      instructionParts: ['Analyze'],
      sources: [{ type: 'file', value: 'missing.md' }],
      stdin: inputStream(),
      cwd: '/tmp'
    }),
    (error) => error.exitCode === 3 && /Could not read input file/.test(error.message)
  );
});

test('loads text, file, URL, and stdin payloads in argument order', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-input-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'input.md'), 'file body');
  const fetchImpl = async () => new Response('url body', { status: 200 });
  const request = await loadRequest({
    instructionParts: ['Transform'],
    sources: [
      { type: 'text', value: 'text body' },
      { type: 'file', value: 'input.md' },
      { type: 'url', value: 'https://example.test/data' },
      { type: 'stdin' }
    ],
    stdin: inputStream('stdin body'),
    cwd: root,
    fetchImpl
  });
  assert.deepEqual(
    request.sources.map((source) => source.content),
    ['text body', 'file body', 'url body', 'stdin body']
  );
  assert.match(composePrompt(request), /Instruction:\nTransform/);
  assert.match(composePrompt(request), /input 4 \(stdin\)/);
});

test('writes only the result to stdout and protects existing files', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-output-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = captureStream();
  await writeResult({ result: 'answer' }, { stdout });
  assert.equal(stdout.read(), 'answer\n');
  const outputPath = join(root, 'result.txt');
  await writeResult('first', { outputPath });
  await assert.rejects(() => writeResult('second', { outputPath }), /--force/);
  await writeResult('second', { outputPath, force: true });
  assert.equal(await readFile(outputPath, 'utf8'), 'second\n');
});
