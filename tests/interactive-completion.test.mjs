import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractiveCompleter, repositoryCompletionNames } from '../src/interactive-completion.mjs';

test('completes registered repository names for interactive removal', () => {
  let paths = [
    '/data/ala/repositories/claude-skills-6c7b534962f7',
    '/data/ala/repositories/content-tools-0123456789ab'
  ];
  const completer = createInteractiveCompleter(() => paths);

  assert.deepEqual(repositoryCompletionNames(paths), ['claude-skills', 'content-tools']);
  assert.deepEqual(completer('/repo remove cla'), [['/repo remove claude-skills'], '/repo remove cla']);
  assert.deepEqual(completer('/repo remove '), [
    ['/repo remove claude-skills', '/repo remove content-tools'],
    '/repo remove '
  ]);
  assert.deepEqual(completer('/agent c'), [[], '/agent c']);

  paths = ['/data/ala/repositories/new-repository-fedcba987654'];
  assert.deepEqual(completer('/repo remove new'), [['/repo remove new-repository'], '/repo remove new']);
});
