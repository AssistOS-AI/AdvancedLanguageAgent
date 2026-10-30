import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_NAMES } from '../src/coding-agents/registry.mjs';
import { collectAgentStateMounts, sandboxEnvironment } from '../src/coding-agents/sandbox.mjs';

// Pins what each backend receives inside its sandbox. Any change to this fixture is a change to the
// sandbox boundary and must be deliberate. PATH and SHELL depend on the host and are left out.
const expected = JSON.parse(await readFile(new URL('./fixtures/sandbox-profiles.json', import.meta.url), 'utf8'));
const OFFERED = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION',
  'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'COHERE_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'HTTP_PROXY', 'LANG', 'MISTRAL_API_KEY', 'NODE_EXTRA_CA_CERTS', 'OMP_DIR', 'OPENAI_API_KEY',
  'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_ENABLE_EXA',
  'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENROUTER_API_KEY', 'PI_OFFLINE', 'TOGETHER_API_KEY',
  'UNRELATED_SECRET', 'XAI_API_KEY'
];
const STATE_DIRECTORIES = ['.codex', '.claude', '.omp', '.pi/agent', '.config/opencode', '.local/share/opencode',
  '.cache/opencode', '.local/state/opencode'];

for (const backend of AGENT_NAMES) {
  test(`${backend} sandbox profile stays pinned`, async (context) => {
    const home = await mkdtemp(join(tmpdir(), 'ala-profile-'));
    context.after(() => rm(home, { recursive: true, force: true }));
    await Promise.all(STATE_DIRECTORIES.map((directory) => mkdir(join(home, directory), { recursive: true })));
    const canonical = await realpath(home);
    const offered = Object.fromEntries(OFFERED.map((name) => [name, 'offered']));
    const { CODEX_HOME, OMP_DIR, ...env } = offered;
    const { PATH, SHELL, ...values } = sandboxEnvironment(backend, [], { ...env, HOME: home });
    const mounts = collectAgentStateMounts(backend, { HOME: home })
      .map((mount) => ({ ...mount, source: mount.source.replace(canonical, '<home>') }));
    assert.deepEqual({
      environment: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))), mounts
    }, expected[backend]);
  });
}

test('only OpenCode receives the OpenCode server credentials', () => {
  const env = { OPENCODE_SERVER_USERNAME: 'user', OPENCODE_SERVER_PASSWORD: 'secret' };
  for (const backend of ['codex', 'pi', 'omp', 'claude']) {
    const values = sandboxEnvironment(backend, [], env);
    assert.equal(values.OPENCODE_SERVER_USERNAME, undefined, backend);
    assert.equal(values.OPENCODE_SERVER_PASSWORD, undefined, backend);
  }
  assert.equal(sandboxEnvironment('opencode', [], env).OPENCODE_SERVER_PASSWORD, 'secret');
});
