import assert from 'node:assert/strict';
import test from 'node:test';
import { createPermissionCommand } from '../src/interactive-permissions.mjs';

test('permission commands show the initial mode and update only the existing runtime', () => {
  const changes = [];
  const command = createPermissionCommand({ setPermissionMode: (mode) => changes.push(mode) });
  assert.equal(command(['/permissions']), 'Native permissions: full-access');
  assert.deepEqual(changes, []);
  assert.match(command(['/permissions', 'ask-for-approval']), /subsequent executions/);
  assert.equal(command(['/permissions']), 'Native permissions: ask-for-approval');
  command(['/permissions', 'full-access']);
  assert.deepEqual(changes, ['ask-for-approval', 'full-access']);
});

test('invalid input and backend rejection preserve the selected permission mode', () => {
  const command = createPermissionCommand({ setPermissionMode: () => { throw new Error('backend rejected'); } },
    'ask-for-approval');
  for (const parts of [['/permissions', 'unsafe'], ['/permissions', 'full-access', 'extra']]) {
    assert.throws(() => command(parts), /Usage: \/permissions/);
  }
  assert.throws(() => command(['/permissions', 'full-access']), /backend rejected/);
  assert.equal(command(['/permissions']), 'Native permissions: ask-for-approval');
});
