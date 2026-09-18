import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractiveCompleter } from '../src/interactive-completion.mjs';

test('completes known interactive commands and leaves other input untouched', () => {
  const completer = createInteractiveCompleter();
  assert.deepEqual(completer('/'), [['/help', '/agent', '/permissions', '/websearch', '/quit', '/exit'], '/']);
  assert.deepEqual(completer('/ag'), [['/agent'], '/ag']);
  assert.deepEqual(completer('/agent'), [[], '/agent']);
  assert.deepEqual(completer('plain text'), [[], 'plain text']);
});
