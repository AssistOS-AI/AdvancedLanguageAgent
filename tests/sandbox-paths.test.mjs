import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../src/coding-agents/process.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { agentFreeEnvironment, liveSandboxSkip, withTemporaryRoot } from './helpers.mjs';

// A caller may name the workspace, or ALA's temporary root, through a link: macOS keeps its temporary folder
// behind /var -> /private/var, and a user may link a project folder. Both backends must resolve such a path
// before granting it. Backend-neutral; the test runner deliberately leaves TMPDIR as the caller has it.
const liveSkip = await liveSandboxSkip();

async function linkedFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-linked-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'real', 'ws'), { recursive: true });
  await symlink(join(root, 'real'), join(root, 'link'));
  return { root, real: join(root, 'real', 'ws'), linked: join(root, 'link', 'ws'),
    env: await agentFreeEnvironment(join(root, 'home')) };
}

const write = { binary: '/bin/sh', args: ['-c', ': > made && echo made'] };

test('a hand-built sandbox reaches a workspace named through a link', { skip: liveSkip }, async (context) => {
  const f = await linkedFixture(context);
  const result = await runProcess({ ...write, cwd: f.linked, env: f.env,
    sandbox: { hostWorkspace: f.linked, workspaceTarget: f.linked, backend: 'codex' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'made\n');
  assert.equal(await readFile(join(f.real, 'made'), 'utf8'), '');
});

test('a service reaches an explicit workspace and an auto-created one named through links', { skip: liveSkip },
  async (context) => {
    const f = await linkedFixture(context);
    const runners = { codex: async (input) => {
      const result = await runProcess({ ...write, cwd: input.workspace, env: input.env, sandbox: input.sandbox });
      return { outputText: JSON.stringify({ ...result, workspace: input.workspace }), continuation: null };
    } };
    const agents = [{ name: 'codex', available: true, binary: '/bin/sh' }];
    const explicit = createCodingAgentService({ agents, workspace: f.linked, cwd: f.linked, env: f.env, runners });
    context.after(() => explicit.close());
    const first = JSON.parse(await explicit.execute('x'));
    assert.equal(first.code, 0, first.stderr);
    assert.equal(await readFile(join(f.real, 'made'), 'utf8'), '');
    // Without a workspace ALA creates one in its temporary root, here named through the link.
    const automatic = createCodingAgentService({ agents, env: f.env, runners });
    context.after(() => automatic.close());
    const second = JSON.parse(await withTemporaryRoot(join(f.root, 'link'), () => automatic.execute('x')));
    assert.equal(second.code, 0, second.stderr);
    assert.ok(second.workspace.startsWith(join(f.root, 'link', 'ala-agent-')), second.workspace);
    const created = join(f.root, 'real', second.workspace.slice(join(f.root, 'link').length + 1));
    assert.equal(await readFile(join(created, 'made'), 'utf8'), '');
  });
