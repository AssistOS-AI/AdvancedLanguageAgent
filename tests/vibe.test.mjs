import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildVibeArguments, createVibeStreamParser, listVibeModels, parseVibeModels, runVibe, vibeEnvironment, vibeFailure
} from '../src/coding-agents/agents/vibe/runner.mjs';
import { interactiveArguments, listInteractiveSessions } from '../src/coding-agents/agents/vibe/sessions.mjs';
import { detectCodingAgentLogin } from '../src/coding-agents/logins.mjs';
import { collectAgentRuntimeMounts } from '../src/coding-agents/sandbox.mjs';
import { getAgent } from '../src/coding-agents/registry.mjs';
import { agentFreeEnvironment, liveSandboxSkip } from './helpers.mjs';

const liveSkip = await liveSandboxSkip();

async function temporary(context, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const entry = (fields) => JSON.stringify({ sessionId: 'sess-1', turnId: 't', generationStatus: 'completed', ...fields });

test('Vibe arguments read the prompt from stdin and pin model and thinking only for a new session', () => {
  assert.deepEqual(buildVibeArguments(), ['-p', '--output', 'streaming', '--auto-approve', '--trust']);
  assert.deepEqual(buildVibeArguments({ model: 'mistral-large-4-0', effort: 'high' }),
    ['-p', '--output', 'streaming', '--auto-approve', '--trust', '--model', 'mistral-large-4-0', '--thinking', 'high']);
  // Vibe refuses --model and --thinking with --resume: the session keeps its own.
  assert.deepEqual(buildVibeArguments({ resume: 'sess-1', model: 'm', effort: 'high' }),
    ['-p', '--output', 'streaming', '--auto-approve', '--trust', '--resume', 'sess-1']);
});

test('Vibe receives exactly the task MCP servers and keeps ALA sessions in the workspace folder', () => {
  const inherited = { PATH: '/bin', VIBE_MCP_SERVERS: '[{"name":"leak"}]' };
  assert.deepEqual(vibeEnvironment(inherited, { sessionDir: '/w/.ala-vibe-sessions' }),
    { PATH: '/bin', VIBE_SESSION_LOGGING__SAVE_DIR: '/w/.ala-vibe-sessions' });
  const env = vibeEnvironment(inherited, { sessionDir: '/s', mcpServers: [{ name: 'desktop', url: 'http://127.0.0.1:8100/mcp' }] });
  assert.deepEqual(JSON.parse(env.VIBE_MCP_SERVERS), [{ name: 'desktop', transport: 'streamable-http', url: 'http://127.0.0.1:8100/mcp' }]);
  assert.equal(inherited.VIBE_MCP_SERVERS, '[{"name":"leak"}]', 'the caller environment is not changed');
});

test('the Vibe stream parser reports the session, tool effects and the final assistant message', () => {
  const texts = [];
  const sessions = [];
  const parser = createVibeStreamParser({ onText: (text, metadata = {}) => texts.push([text, metadata]), onSession: (id) => sessions.push(id) });
  const stream = [
    entry({ id: 'u1', type: 'message', role: 'user', content: [{ type: 'text', text: 'do it' }] }),
    entry({ id: 'e1', type: 'effect', title: 'file_system.bash', detail: { display: { summary: 'bash: ls' } }, state: { outputText: 'a.txt' } }),
    entry({ id: 'a1', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'first' }] }),
    'not json',
    entry({ id: 'a2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'final answer' }] })
  ].join('\n');
  parser.push(Buffer.from(stream.slice(0, 50)));
  parser.push(Buffer.from(`${stream.slice(50)}\n`));
  parser.finish();
  assert.deepEqual(sessions, ['sess-1']);
  assert.equal(parser.sessionId(), 'sess-1');
  assert.equal(parser.finalText(), 'final answer');
  assert.deepEqual(texts, [
    ['bash: ls\na.txt\n', {}],
    ['first', { outputKind: 'assistant', outputComplete: true, outputId: 'a1' }],
    ['not json\n', {}],
    ['final answer', { outputKind: 'assistant', outputComplete: true, outputId: 'a2' }]
  ]);
});

test('a Vibe failure reports its error line without the keyring notice', () => {
  const failure = vibeFailure({ code: 1, stdout: '', stderr: 'Reading API keys from the system keyring (set them as environment variables to skip this)\nError: Missing MISTRAL_API_KEY environment variable for mistral provider\n' });
  assert.equal(failure.message, 'Mistral Vibe execution failed: Missing MISTRAL_API_KEY environment variable for mistral provider');
  assert.equal(vibeFailure({ code: 3, stdout: '', stderr: '' }).message, 'Mistral Vibe execution failed: exit code 3');
});

test('Vibe models come from its effective configuration with their thinking levels', () => {
  const output = ['warning line', `@@ALA_VIBE_MODELS@@${JSON.stringify([
    { alias: 'mistral-large-4-0', label: 'Mistral Large 4', thinking: 'high', levels: ['low', 'medium', 'high'] },
    { alias: 'local', label: null, thinking: 'off', levels: ['off', 'bad level'] },
    { alias: '', levels: [] }
  ])}`].join('\n');
  assert.deepEqual(parseVibeModels(output), [
    { id: 'mistral-large-4-0', label: 'Mistral Large 4', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
    { id: 'local', label: 'local', efforts: ['off'], defaultEffort: 'off' }
  ]);
  // The listing names where the models came from; the account catalog adds models the built-in list lacks.
  assert.deepEqual(parseVibeModels(`@@ALA_VIBE_MODELS@@${JSON.stringify({ source: 'account', models: [
    { alias: 'deepseek-v4', label: 'DeepSeek V4', thinking: 'high', levels: ['off', 'high'] }] })}`),
  [{ id: 'deepseek-v4', label: 'DeepSeek V4', efforts: ['off', 'high'], defaultEffort: 'high' }]);
  assert.throws(() => parseVibeModels('no marker'), /invalid model list/u);
  assert.throws(() => parseVibeModels('@@ALA_VIBE_MODELS@@{"source":"local"}'), /invalid model list/u);
});

test('a Vibe login is the MISTRAL_API_KEY Vibe stores in VIBE_HOME/.env', async (context) => {
  const home = await temporary(context, 'ala-vibe-login-');
  const login = async (env) => (await detectCodingAgentLogin('vibe', { env })).file;
  assert.equal(await login({ HOME: home }), false);
  await mkdir(join(home, '.vibe'));
  for (const [content, expected] of [
    ['MISTRAL_API_KEY=\n', false], ['OTHER=1\n', false], ['MISTRAL_API_KEY=abc\n', true],
    ["export MISTRAL_API_KEY='abc'\n", true], ['MISTRAL_API_KEY="abc"\nMISTRAL_API_KEY=\n', false]
  ]) {
    await writeFile(join(home, '.vibe', '.env'), content);
    assert.equal(await login({ HOME: home }), expected, content);
  }
  await mkdir(join(home, 'custom'));
  await writeFile(join(home, 'custom', '.env'), 'MISTRAL_API_KEY=abc\n');
  assert.equal(await login({ HOME: join(home, 'elsewhere'), VIBE_HOME: join(home, 'custom') }), true);
  // A link is not followed.
  await rm(join(home, '.vibe', '.env'));
  await symlink(join(home, 'custom', '.env'), join(home, '.vibe', '.env'));
  assert.equal(await login({ HOME: home }), false);
  const vibe = getAgent('vibe');
  assert.deepEqual(vibe.homeEnvironment('/robot'), { VIBE_HOME: '/robot/.vibe' });
  // The null backend would accept a key and drop it; the failing one makes Vibe write VIBE_HOME/.env.
  assert.equal(vibe.sandbox.envSet.PYTHON_KEYRING_BACKEND, 'keyring.backends.fail.Keyring');
  assert.equal(vibe.sandbox.envSet.VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG, 'true');
});

test('the Vibe catalog lists the folder\'s interactive conversations with their title or first prompt', async (context) => {
  const home = await temporary(context, 'ala-vibe-sessions-');
  const root = join(home, '.vibe', 'logs', 'session', 'unified');
  const session = async (id, meta, chunks = [], mtime = '2026-01-01T00:00:00Z') => {
    const directory = join(root, id);
    await mkdir(join(directory, 'chunks'), { recursive: true });
    await writeFile(join(directory, 'meta.json'), JSON.stringify({ session_id: id, parent_session_id: null, archived_at: null,
      start_time: '2026-01-01T00:00:00Z', environment: { working_directory: '/project' }, title: null, ...meta }));
    for (const [index, chunk] of chunks.entries()) await writeFile(join(directory, 'chunks', `${index}.json`), JSON.stringify(chunk));
    await utimes(join(directory, 'meta.json'), new Date(mtime), new Date(mtime));
  };
  const user = (text, createdAt) => ({ type: 'message', role: 'user', createdAt, content: [{ type: 'text', text }] });
  await session('named', { title: 'Named session', bumped_at: '2026-01-05T00:00:00Z' });
  await session('plain', {}, [[user('later prompt', 20)], [user('first prompt', 10), { type: 'effect' }]], '2026-01-04T00:00:00Z');
  await session('other', { environment: { working_directory: '/elsewhere' }, title: 'Other' });
  await session('child', { parent_session_id: 'named', title: 'Child' });
  await session('archived', { archived_at: '2026-01-02T00:00:00Z', title: 'Archived' });
  await session('empty', {});
  await mkdir(join(root, 'no-meta'), { recursive: true });
  const listed = await listInteractiveSessions({ home, cwd: '/project' });
  assert.deepEqual(listed.map(({ id, title }) => [id, title]), [['named', 'Named session'], ['plain', 'first prompt']]);
  assert.equal(listed[0].updatedAt, Date.parse('2026-01-05T00:00:00Z'));
  assert.deepEqual(interactiveArguments({ resume: 'named' }), ['--resume', 'named']);
  assert.deepEqual(interactiveArguments(), []);
  assert.throws(() => interactiveArguments({ resume: '../x' }), /Invalid session/u);
  assert.deepEqual(await listInteractiveSessions({ home: join(home, 'missing'), cwd: '/project' }), []);
});

// A Python virtual environment as uv creates it: the program in <venv>/bin and pyvenv.cfg naming the interpreter.
async function fakeVirtualEnvironment(root, { vibe, python }) {
  const interpreter = join(root, 'interpreter');
  const venv = join(root, 'tools', 'mistral-vibe');
  await mkdir(join(interpreter, 'bin'), { recursive: true });
  await mkdir(join(venv, 'bin'), { recursive: true });
  await writeFile(join(interpreter, 'marker'), 'interpreter visible\n');
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${join(interpreter, 'bin')}\nversion_info = 3.12.12\n`);
  await writeFile(join(interpreter, 'bin', 'python3.12'), python, { mode: 0o755 });
  await symlink(join(interpreter, 'bin', 'python3.12'), join(venv, 'bin', 'python'));
  await writeFile(join(venv, 'bin', 'vibe'), vibe, { mode: 0o755 });
  await mkdir(join(root, 'bin'));
  await symlink(join(venv, 'bin', 'vibe'), join(root, 'bin', 'vibe'));
  return { binary: join(root, 'bin', 'vibe'), venv, interpreter };
}

test('a program in a Python virtual environment mounts the environment and its interpreter', async (context) => {
  const root = await temporary(context, 'ala-vibe-venv-');
  const { binary, venv, interpreter } = await fakeVirtualEnvironment(root, { vibe: '#!/bin/sh\n', python: '#!/bin/sh\n' });
  assert.deepEqual(collectAgentRuntimeMounts(binary), [venv, interpreter]);
  assert.deepEqual(collectAgentRuntimeMounts(join(venv, 'bin', 'python')), [join(interpreter, 'bin')],
    'the interpreter link alone resolves outside the environment, which is why model listing names the launcher');
  await writeFile(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
  assert.deepEqual(collectAgentRuntimeMounts(binary), [venv], 'a system interpreter is already mounted');
});

const FAKE_VIBE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "vibe 3.1.3"; exit 0; fi
prompt=$(cat)
printf '%s\\n' "$*" >> "$PWD/args.txt"
printf '%s|%s|%s|%s\\n' "$VIBE_HOME" "$VIBE_SESSION_LOGGING__SAVE_DIR" "$VIBE_MCP_SERVERS" "$PYTHON_KEYRING_BACKEND" >> "$PWD/env.txt"
cat "$(dirname "$(dirname "$0")")/../../interpreter/marker" >> "$PWD/env.txt" 2>/dev/null || echo "no interpreter" >> "$PWD/env.txt"
case "$prompt" in fail*) echo "Error: provider refused" >&2; exit 1;; esac
id=sess-new
case "$*" in *--resume*) id=$(echo "$*" | sed 's/.*--resume \\([^ ]*\\).*/\\1/');; esac
printf '{"sessionId":"%s","type":"message","role":"user","content":[{"type":"text","text":"%s"}]}\\n' "$id" "$prompt"
printf '{"sessionId":"%s","type":"effect","title":"file_system.bash","detail":{"display":{"summary":"bash: true"}}}\\n' "$id"
printf '{"id":"a","sessionId":"%s","type":"message","role":"assistant","content":[{"type":"text","text":"answer to %s"}]}\\n' "$id" "$prompt"
`;

const FAKE_PYTHON = `#!/bin/sh
printf '@@ALA_VIBE_MODELS@@[{"alias":"mistral-large-4-0","label":"Mistral Large 4","thinking":"high","levels":["low","high"]}]\\n'
`;

test('Vibe runs a turn in the sandbox, resumes its session and lists models through its environment', { skip: liveSkip }, async (context) => {
  const root = await temporary(context, 'ala-vibe-live-');
  const { binary } = await fakeVirtualEnvironment(root, { vibe: FAKE_VIBE, python: FAKE_PYTHON });
  const workspace = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(join(home, '.vibe'), { recursive: true });
  const env = await agentFreeEnvironment(home, { VIBE_HOME: join(home, '.vibe') });
  const sandbox = { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'vibe', home, folders: [], ignoredPaths: [] };
  const base = { binary, workspace, hostWorkspace: workspace, env, sandbox, signal: null };
  const texts = [];
  const sessions = [];
  const first = await runVibe({ ...base, prompt: 'build', model: 'mistral-large-4-0', effort: 'high',
    mcpServers: [{ name: 'desktop', url: 'http://127.0.0.1:8100/mcp' }],
    onVisibleText: (text) => texts.push(text), onSession: (value) => sessions.push(value) });
  assert.deepEqual(first, { outputText: 'answer to build', continuation: { sessionId: 'sess-new' } });
  assert.deepEqual(sessions, [{ sessionId: 'sess-new' }]);
  assert.deepEqual(texts, ['bash: true\n', 'answer to build']);
  const second = await runVibe({ ...base, prompt: 'more', model: 'mistral-large-4-0', effort: 'high', continuation: first.continuation });
  assert.deepEqual(second, { outputText: 'answer to more', continuation: { sessionId: 'sess-new' } });
  const args = (await readFile(join(workspace, 'args.txt'), 'utf8')).trim().split('\n');
  assert.deepEqual(args, [
    '-p --output streaming --auto-approve --trust --model mistral-large-4-0 --thinking high',
    '-p --output streaming --auto-approve --trust --resume sess-new'
  ]);
  const [firstEnv, firstMarker, secondEnv] = (await readFile(join(workspace, 'env.txt'), 'utf8')).trim().split('\n');
  const [vibeHome, saveDir, mcp, keyring] = firstEnv.split('|');
  assert.match(vibeHome, /^\/home\/[^/]+\/\.vibe$/u);
  assert.equal(saveDir, join(workspace, '.ala-vibe-sessions'));
  assert.deepEqual(JSON.parse(mcp), [{ name: 'desktop', transport: 'streamable-http', url: 'http://127.0.0.1:8100/mcp' }]);
  assert.equal(keyring, 'keyring.backends.fail.Keyring');
  assert.equal(firstMarker, 'interpreter visible', 'the interpreter installation is mounted');
  assert.equal(secondEnv.split('|')[2], '', 'a turn without MCP servers passes none');
  await assert.rejects(runVibe({ ...base, prompt: 'fail now', continuation: first.continuation }),
    (error) => /provider refused/u.test(error.message) && error.continuation?.sessionId === 'sess-new');
  await assert.rejects(runVibe({ ...base, prompt: 'x', continuation: { sessionId: '../etc' } }), /Invalid Mistral Vibe session/u);
  assert.deepEqual(await listVibeModels({ binary, cwd: workspace, env, sandbox, signal: null }),
    [{ id: 'mistral-large-4-0', label: 'Mistral Large 4', efforts: ['low', 'high'], defaultEffort: 'high' }]);
});
