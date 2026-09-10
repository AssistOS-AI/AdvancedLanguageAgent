import assert from 'node:assert/strict';
import test from 'node:test';
import { codexSkillPolicyOverrides, verifyCodexSkillPolicy } from '../src/coding-agents/codex-skill-policy.mjs';

const selected = '/workspace/.agents/skills/current/SKILL.md';
const outside = '/home/ala/.codex/skills/unselected/SKILL.md';
const input = { workspace: '/workspace', sandbox: { isolatedSkills: true,
  mounts: [{ purpose: 'task-skill', target: '/workspace/.agents/skills/current' }] } };

function channels(inventories, observed = []) {
  let index = 0;
  return (request, args) => {
    observed.push(args);
    const skills = inventories[index++];
    return { send() {}, close: async () => {}, request: async ({ method, params }) => {
      if (method === 'initialize') return {};
      assert.equal(method, 'skills/list');
      assert.deepEqual(params, { cwds: ['/workspace'], forceReload: true });
      return { data: [{ cwd: '/workspace', skills, errors: [] }] };
    } };
  };
}

test('native Codex registration filters only through transient per-process configuration', async () => {
  const observed = [];
  const overrides = await codexSkillPolicyOverrides(input, channels([
    [{ path: selected, enabled: true }, { path: outside, enabled: true }],
    [{ path: selected, enabled: true }, { path: outside, enabled: false }]
  ], observed));
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[1], [...overrides, 'app-server']);
  assert.match(overrides[1], /current\/SKILL.md",enabled=true/);
  assert.match(overrides[1], /unselected\/SKILL.md",enabled=false/);
});

test('an explicit empty native catalog disables every discovered skill', async () => {
  const overrides = await codexSkillPolicyOverrides({ ...input, sandbox: { isolatedSkills: true, mounts: [] } },
    channels([[{ path: outside, enabled: true }], [{ path: outside, enabled: false }]]));
  assert.match(overrides[1], /enabled=false/);
  assert.doesNotMatch(overrides[1], /enabled=true/);
});

test('missing required registration and ineffective native disable both fail visibly', async () => {
  await assert.rejects(() => codexSkillPolicyOverrides(input, channels([[]])), /absent from Codex native registration/);
  const unexpected = [{ path: selected, enabled: true }, { path: outside, enabled: true }];
  await assert.rejects(() => codexSkillPolicyOverrides(input, channels([unexpected, unexpected, unexpected])),
    /native skill registration changed/);
});

test('standalone unfiltered calls do not acquire a native catalog requirement', async () => {
  assert.deepEqual(await codexSkillPolicyOverrides({ workspace: '/workspace' }, () => {
    throw new Error('must not probe');
  }), []);
});

test('actual-process validation permits one transient inventory mismatch without starting work', async () => {
  let reads = 0;
  await verifyCodexSkillPolicy(input, { request: async () => ({ data: [{ cwd: '/workspace', errors: [],
    skills: ++reads === 1 ? [] : [{ path: selected, enabled: true }] }] }) });
  assert.equal(reads, 2);
});

test('malformed and incomplete native inventories cannot establish an empty selection', async () => {
  for (const entry of [
    { skills: [{ path: outside }], errors: [] },
    { skills: [{ path: outside, enabled: 'false' }], errors: [] },
    { skills: [{ path: 'relative/SKILL.md', enabled: false }], errors: [] },
    { skills: [{ path: '/home/../outside/SKILL.md', enabled: false }], errors: [] },
    { skills: [{ path: outside, enabled: false }, { path: outside, enabled: false }], errors: [] },
    { skills: [], errors: [{ message: 'Incomplete inventory' }] }
  ]) {
    await assert.rejects(verifyCodexSkillPolicy({ workspace: '/workspace', sandbox: { isolatedSkills: true, mounts: [] } },
      { request: async () => ({ data: [{ cwd: '/workspace', ...entry }] }) }), /native skill inventory/);
  }
});
