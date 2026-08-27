import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveFolderRequests } from '../src/coding-agents/folders.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';

test('canonicalizes, deduplicates, and updates session-scoped folder mounts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-folders-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const books = join(root, 'My Books');
  const drafts = join(root, 'drafts');
  await Promise.all([mkdir(books), mkdir(drafts)]);
  const initial = await resolveFolderRequests([
    { path: books, writable: false },
    { path: books, writable: true }
  ], root);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].access, 'read-write');
  assert.equal(initial[0].alias, 'my-books');
  assert.equal(initial[0].workspacePath, '/workspace/folders/my-books');

  const calls = [];
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/fake/codex' }],
    folders: initial,
    cwd: root,
    runners: {
      codex: async (input) => {
        calls.push(input);
        return { outputText: 'done', continuation: { threadId: 'thread' } };
      }
    }
  });
  context.after(() => service.close());
  await service.execute('inspect');
  assert.match(calls[0].prompt, /You have access to these mounted folders/u);
  assert.match(calls[0].prompt, /\/workspace\/folders\/my-books — read-write/u);
  assert.doesNotMatch(calls[0].prompt, /folders\.json/u);
  assert.equal(calls[0].sandbox.mounts.find((mount) => mount.purpose === 'folder').writable, true);

  const added = await service.addFolder(drafts, false, 'research-drafts');
  assert.equal(added.workspacePath, '/workspace/folders/research-drafts');
  assert.equal(service.listFolders().length, 2);
  await service.execute('continue');
  assert.deepEqual(calls[1].continuation, { threadId: 'thread' });
  assert.equal(calls[1].sandbox.mounts.filter((mount) => mount.purpose === 'folder').length, 2);
  await service.removeFolder(added.alias);
  assert.deepEqual(service.listFolders().map((folder) => folder.sourcePath), [books]);
});

test('rejects invalid and colliding folder aliases', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-folder-aliases-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first', 'books');
  const second = join(root, 'second', 'books');
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  await assert.rejects(() => resolveFolderRequests([
    { path: first, writable: false },
    { path: second, writable: false }
  ]), /alias is already used/u);
  await assert.rejects(() => resolveFolderRequests([
    { path: first, writable: false, alias: '../books' }
  ]), /Folder alias must use/u);
  const records = await resolveFolderRequests([
    { path: first, writable: false, alias: 'primary-books' },
    { path: second, writable: false, alias: 'archive-books' }
  ]);
  assert.deepEqual(records.map((record) => record.alias), ['primary-books', 'archive-books']);
});

test('rejects session folder addition when no coding agent is available', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ala-folders-no-agent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'folder');
  await mkdir(folder);
  const service = createCodingAgentService({ agents: [], cwd: root });
  await assert.rejects(() => service.addFolder(folder), /require an available coding agent/);
  await service.close();
});
