import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agyFailure, agyMcpConfig, agyPromptRecord, buildAgyArguments, createAgyStreamParser, listAgyModels, parseAgyModels, runAgy
} from '../src/coding-agents/agents/agy/runner.mjs';
import { interactiveArguments, listInteractiveSessions } from '../src/coding-agents/agents/agy/sessions.mjs';
import { detectCodingAgentLogin } from '../src/coding-agents/logins.mjs';
import { getAgent } from '../src/coding-agents/registry.mjs';
import { agentFreeEnvironment, liveSandboxSkip } from './helpers.mjs';

const liveSkip = await liveSandboxSkip();
const ID = '78abfde9-6e99-4a50-b97e-996fa1b6a3bd';

async function temporary(context, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const event = (name, payload) => JSON.stringify({ event: name, [name]: payload });

test('agy reads its prompt as one stream-json record and runs every tool without asking', () => {
  assert.deepEqual(buildAgyArguments(),
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions']);
  assert.deepEqual(buildAgyArguments({ resume: ID, model: 'gemini-3.8-flash-low', effort: 'high' }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions',
      '--model', 'gemini-3.8-flash-low', '--effort', 'high', '--conversation', ID]);
  assert.deepEqual(JSON.parse(agyPromptRecord('do "it"')), { event: 'user', message: { content: 'do "it"' } });
  assert.deepEqual(agyMcpConfig([{ name: 'desktop', url: 'http://127.0.0.1:8100/mcp' }]),
    { mcpServers: { desktop: { serverUrl: 'http://127.0.0.1:8100/mcp' } } });
});

test('the agy stream parser reports the conversation, streamed answer text and finished tools', () => {
  const texts = [];
  const sessions = [];
  const parser = createAgyStreamParser({ onText: (text, metadata = {}) => texts.push([text, metadata]), onSession: (id) => sessions.push(id) });
  const stream = [
    event('init', { cwd: '/w', permission_mode: 'always-proceed' }),
    event('step_update', { conversation_id: ID, step_index: 0, state: 'DONE', step_type: 'user_input' }),
    event('step_update', { conversation_id: ID, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } }),
    event('step_update', { conversation_id: ID, step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a.txt' } }),
    event('step_update', { conversation_id: ID, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'DO' }),
    event('step_update', { conversation_id: ID, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'NE' }),
    'not json',
    event('result', { conversation_id: ID, status: 'SUCCESS', response: 'DONE\n' })
  ].join('\n');
  parser.push(Buffer.from(stream.slice(0, 70)));
  parser.push(Buffer.from(`${stream.slice(70)}\n`));
  parser.finish();
  assert.deepEqual(sessions, [ID]);
  assert.equal(parser.conversationId(), ID);
  assert.deepEqual(parser.result(), { conversation_id: ID, status: 'SUCCESS', response: 'DONE\n' });
  assert.deepEqual(texts, [
    ['run_command: ls\n', {}],
    ['DO', { outputKind: 'assistant', outputId: 'agy-3' }],
    ['NE', { outputKind: 'assistant', outputId: 'agy-3', outputComplete: true }],
    ['not json\n', {}]
  ]);
});

test('an agy failure reports the result error, else its stderr', () => {
  assert.equal(agyFailure({ status: 'ERROR', error: 'invalid model selection' }, { code: 1, stderr: '' }).message,
    'Antigravity CLI execution failed: invalid model selection');
  assert.equal(agyFailure(null, { code: 2, stderr: 'Error: bad flag\n' }).message, 'Antigravity CLI execution failed: Error: bad flag');
});

test('agy models are the identifiers its model list prints, without separate efforts', () => {
  const output = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\n';
  assert.deepEqual(parseAgyModels(output), [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', efforts: [] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', efforts: [] }
  ]);
  assert.deepEqual(parseAgyModels('Error: Please sign in to view available models.'), []);
});

test('an agy login is the OAuth token agy stores in .gemini/antigravity-cli', async (context) => {
  const home = await temporary(context, 'ala-agy-login-');
  const login = async () => (await detectCodingAgentLogin('agy', { env: { HOME: home } })).file;
  assert.equal(await login(), false);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  const token = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  for (const [content, expected] of [
    [{ token: {} }, false], [{ token: { refresh_token: '' } }, false],
    [{ token: { refresh_token: 'r', access_token: 'a' }, auth_method: 'consumer' }, true], ['not json', false]
  ]) {
    await writeFile(token, typeof content === 'string' ? content : JSON.stringify(content));
    assert.equal(await login(), expected, JSON.stringify(content));
  }
  const agy = getAgent('agy');
  assert.deepEqual(agy.state({}, '/h').map(({ source }) => source), ['/h/.gemini/antigravity-cli', '/h/.gemini/config'],
    'Gemini CLI\'s own files in ~/.gemini stay unmounted');
  assert.equal(agy.sandbox.envSet.SSH_TTY, 'ala-agy-file-auth');
  assert.equal(agy.sandbox.envSet.AGY_CLI_DISABLE_AUTO_UPDATE, '1');
});

async function catalog(home, rows, history) {
  const root = join(home, '.gemini', 'antigravity-cli');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'history.jsonl'), history.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(root, 'conversation_summaries.db'));
  database.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '',
    preview text NOT NULL DEFAULT '', workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '',
    killed numeric NOT NULL DEFAULT false, last_modified_time datetime NOT NULL)`);
  const insert = database.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.title || '', row.preview || '', JSON.stringify((row.folders || []).map((folder) => `file://${folder}`)),
      row.parent || '', row.killed ? 1 : 0, row.time);
  }
  database.close();
}

test('the agy catalog lists every interactive conversation of the folder, killed ones included', async (context) => {
  const home = await temporary(context, 'ala-agy-sessions-');
  const id = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const [first, second, killed, single, robot, child, elsewhere, untitled] = ['1', '2', '3', '4', '5', '6', '7', '8'].map(id);
  await catalog(home, [
    { id: first, title: 'General Greeting', folders: ['/project'], time: '2026-11-23 10:15:38.581277326+00:00' },
    { id: second, title: 'Casual Greeting', folders: ['/project'], time: '2026-11-23 10:17:10.289343687+00:00' },
    { id: killed, title: 'Killed from the terminal', folders: ['/project'], killed: true, time: '2026-11-23 10:18:00+00:00' },
    // One typed prompt leaves no conversation id in the history, but the conversation has a generated title.
    { id: single, title: 'Single prompt', folders: ['/project'], time: '2026-11-23 10:19:00+00:00' },
    // A print-mode run, as ALA drives agy: no title and no history entry.
    { id: robot, preview: 'robot prompt', folders: ['/project'], time: '2026-11-23 10:20:00+00:00' },
    { id: child, title: 'Subagent', folders: ['/project'], parent: first, time: '2026-11-23 10:21:00+00:00' },
    { id: elsewhere, title: 'Other folder', folders: ['/other'], time: '2026-11-23 10:22:00+00:00' },
    // The history alone can place a conversation the catalog records without a folder.
    { id: untitled, preview: 'typed twice', time: '2026-11-23 10:23:00+00:00' }
  ], [
    { display: 'hello', workspace: '/project' },
    { display: 'more', workspace: '/project', conversationId: first },
    { display: 'again', workspace: '/project', conversationId: second },
    { display: 'once', workspace: '/project' },
    { display: 'twice', workspace: '/project', conversationId: untitled },
    { display: 'bad', workspace: '/project', conversationId: '../x' }
  ]);
  const listed = await listInteractiveSessions({ home, cwd: '/project' });
  assert.deepEqual(listed.map(({ id: key, title }) => [key, title]), [
    [untitled, 'typed twice'], [single, 'Single prompt'], [killed, 'Killed from the terminal'],
    [second, 'Casual Greeting'], [first, 'General Greeting']
  ]);
  assert.equal(listed.at(-1).updatedAt, Date.parse('2026-11-23T10:15:38.581+00:00'));
  assert.deepEqual((await listInteractiveSessions({ home, cwd: '/other' })).map(({ id: key }) => key), [elsewhere]);
  assert.deepEqual(await listInteractiveSessions({ home, cwd: '/elsewhere' }), []);
  assert.deepEqual(await listInteractiveSessions({ home: join(home, 'missing'), cwd: '/project' }), []);
  assert.deepEqual(interactiveArguments({ resume: first }), ['--conversation', first]);
  assert.deepEqual(interactiveArguments(), []);
});

const FAKE_AGY = `#!/bin/sh
if [ "$1" = "models" ]; then printf 'Fetching available models...\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n'; exit 0; fi
record=$(cat)
printf '%s\\n' "$*" >> "$PWD/args.txt"
printf '%s|%s|%s\\n' "$SSH_TTY" "$AGY_CLI_DISABLE_AUTO_UPDATE" "$(cat "$HOME/.gemini/config/mcp_config.json" 2>/dev/null)" >> "$PWD/env.txt"
case "$record" in *fail*) printf '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"quota exhausted"}}\\n'; exit 1;; esac
id=78abfde9-6e99-4a50-b97e-996fa1b6a3bd
printf '{"event":"step_update","step_update":{"conversation_id":"%s","step_index":0,"state":"DONE","step_type":"user_input"}}\\n' "$id"
printf '{"event":"step_update","step_update":{"conversation_id":"%s","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"answer"}}\\n' "$id"
printf '{"event":"result","result":{"conversation_id":"%s","status":"SUCCESS","response":"answer\\\\n"}}\\n' "$id"
`;

test('agy runs a turn in the sandbox with a per-run MCP file, resumes it, and refuses a home without a login', { skip: liveSkip }, async (context) => {
  const root = await temporary(context, 'ala-agy-live-');
  const binary = join(root, 'bin', 'agy');
  const workspace = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(join(root, 'bin'));
  await writeFile(binary, FAKE_AGY, { mode: 0o755 });
  await mkdir(workspace);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  await mkdir(join(home, '.gemini', 'config'), { recursive: true });
  await writeFile(join(home, '.gemini', 'config', 'mcp_config.json'), '{"mcpServers":{"own":{"serverUrl":"http://own"}}}');
  const env = await agentFreeEnvironment(home);
  const sandbox = { hostWorkspace: workspace, workspaceTarget: workspace, backend: 'agy', home, folders: [], ignoredPaths: [] };
  const base = { binary, workspace, hostWorkspace: workspace, env, sandbox, signal: null };
  await assert.rejects(runAgy({ ...base, prompt: 'hi' }), /Antigravity CLI is not logged in/u);
  await writeFile(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { refresh_token: 'r' } }));
  const sessions = [];
  const first = await runAgy({ ...base, prompt: 'build', model: 'gemini-3.8-flash-low',
    mcpServers: [{ name: 'desktop', url: 'http://127.0.0.1:8100/mcp' }], onSession: (value) => sessions.push(value) });
  assert.deepEqual(first, { outputText: 'answer', continuation: { conversationId: ID } });
  assert.deepEqual(sessions, [{ conversationId: ID }]);
  const second = await runAgy({ ...base, prompt: 'more', continuation: first.continuation });
  assert.equal(second.outputText, 'answer');
  const args = (await readFile(join(workspace, 'args.txt'), 'utf8')).trim().split('\n');
  assert.deepEqual(args, [
    '--input-format stream-json --output-format stream-json --dangerously-skip-permissions --model gemini-3.8-flash-low',
    `--input-format stream-json --output-format stream-json --dangerously-skip-permissions --conversation ${ID}`
  ]);
  const [firstEnv, secondEnv] = (await readFile(join(workspace, 'env.txt'), 'utf8')).trim().split('\n');
  assert.deepEqual(firstEnv.split('|').slice(0, 2), ['ala-agy-file-auth', '1']);
  assert.deepEqual(JSON.parse(firstEnv.split('|').slice(2).join('|')), { mcpServers: { desktop: { serverUrl: 'http://127.0.0.1:8100/mcp' } } });
  assert.match(secondEnv, /"own"/u, 'without MCP servers the home\'s own configuration is used');
  assert.equal(await readFile(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'), '{"mcpServers":{"own":{"serverUrl":"http://own"}}}',
    'the per-run file never replaces the home\'s configuration');
  await assert.rejects(runAgy({ ...base, prompt: 'fail please', continuation: first.continuation }),
    (error) => /quota exhausted/u.test(error.message) && error.continuation?.conversationId === ID);
  await assert.rejects(runAgy({ ...base, prompt: 'x', continuation: { conversationId: '../etc' } }), /Invalid Antigravity CLI conversation/u);
  assert.deepEqual(await listAgyModels({ binary, cwd: workspace, env, sandbox, signal: null }),
    [{ id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', efforts: [] }]);
});
