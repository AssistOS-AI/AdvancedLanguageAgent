import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runCli } from '../src/cli.mjs';
import {
  codingAgentLoginFiles, detectCodingAgentLogin, detectCodingAgentLogins, homeEnvironment
} from '../src/coding-agents/logins.mjs';
import { captureStream, inputStream } from './helpers.mjs';

async function tempRoot(context) {
  const root = await mkdtemp(join(tmpdir(), 'ala-logins-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, file, content) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
}

const loggedIn = (logins) => Object.fromEntries(Object.entries(logins).map(([name, login]) => [name, login.loggedIn]));
const NONE = { codex: false, opencode: false, pi: false, omp: false, claude: false };

test('an empty home holds no coding-agent login', async (context) => {
  const home = await tempRoot(context);
  assert.deepEqual(loggedIn(await detectCodingAgentLogins({ env: { HOME: home } })), NONE);
});

test('each agent counts as logged in only when its own credential store holds something', async (context) => {
  const home = await tempRoot(context);
  await write(home, '.codex/auth.json', { OPENAI_API_KEY: null, tokens: { access_token: 'a', refresh_token: 'r' } });
  await write(home, '.local/share/opencode/auth.json', { deepseek: { type: 'api', key: 'k' } });
  await write(home, '.pi/agent/auth.json', { anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } });
  await write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
  const logins = await detectCodingAgentLogins({ env: { HOME: home } });
  assert.deepEqual(loggedIn(logins), { codex: true, opencode: true, pi: true, omp: false, claude: true });
  assert.deepEqual(logins.codex, { loggedIn: true, file: true, env: [] });
});

test('bookkeeping without credentials is not a login', async (context) => {
  const home = await tempRoot(context);
  await write(home, '.codex/auth.json', { OPENAI_API_KEY: null, tokens: null, last_refresh: '2026-01-01' });
  await write(home, '.local/share/opencode/auth.json', {});
  await write(home, '.pi/agent/auth.json', { openai: { type: 'api_key' } });
  await write(home, '.claude/.claude.json', { oauthAccount: null, numStartups: 3 });
  await write(home, '.claude/.credentials.json', 'not json');
  assert.deepEqual(loggedIn(await detectCodingAgentLogins({ env: { HOME: home } })), NONE);
});

test('a Claude API key and an OpenCode Console account count as logins', async (context) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { context.skip('node:sqlite is unavailable'); return; }
  const home = await tempRoot(context);
  await write(home, '.claude/.claude.json', { primaryApiKey: 'sk-ant' });
  await mkdir(join(home, '.local/share/opencode'), { recursive: true });
  const database = new DatabaseSync(join(home, '.local/share/opencode/opencode.db'));
  database.exec('CREATE TABLE account_state (id INTEGER, active_account_id TEXT, active_org_id TEXT);');
  database.prepare('INSERT INTO account_state VALUES (1, ?, NULL)').run('acc_1');
  database.close();
  assert.deepEqual(loggedIn(await detectCodingAgentLogins({ env: { HOME: home } })), { ...NONE, opencode: true, claude: true });
});

test('a FIFO or oversized file at a credential path is never read', async (context) => {
  const home = await tempRoot(context);
  await mkdir(join(home, '.codex'), { recursive: true });
  execFileSync('mkfifo', [join(home, '.codex/auth.json')]);
  await write(home, '.pi/agent/auth.json', 'x'.repeat(5 * 1024 * 1024));
  assert.deepEqual(loggedIn(await detectCodingAgentLogins({ env: { HOME: home } })), NONE);
});

test('state directories follow the agent variables, and an explicit home replaces them', async (context) => {
  const root = await tempRoot(context);
  const env = {
    HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), XDG_DATA_HOME: join(root, 'data'),
    PI_CODING_AGENT_DIR: join(root, 'pi'), CLAUDE_CONFIG_DIR: join(root, 'claude')
  };
  await write(root, 'codex/auth.json', { OPENAI_API_KEY: 'k' });
  await write(root, 'data/opencode/auth.json', { openai: { type: 'oauth' } });
  await write(root, 'pi/auth.json', { openai: { type: 'api_key', env: 'OPENAI_API_KEY' } });
  await write(root, 'claude/.credentials.json', { claudeAiOauth: { refreshToken: 'r' } });
  assert.deepEqual(loggedIn(await detectCodingAgentLogins({ env })), { codex: true, opencode: true, pi: true, omp: false, claude: true });
  assert.deepEqual(codingAgentLoginFiles('claude', { env }),
    [join(root, 'claude/.credentials.json'), join(root, 'claude/.claude.json')]);
  const robot = join(root, 'robot');
  await write(robot, '.claude/.claude.json', { primaryApiKey: 'sk-ant' });
  assert.deepEqual(loggedIn(await detectCodingAgentLogins({ env: homeEnvironment(env, robot) })), { ...NONE, claude: true });
  assert.deepEqual(codingAgentLoginFiles('codex', { env: homeEnvironment(env, robot) }), [join(robot, '.codex/auth.json')]);
});

test('credential variables are reported by name only, per agent', async (context) => {
  const home = await tempRoot(context);
  const env = { HOME: home, OPENAI_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://example.test', DEEPSEEK_API_KEY: ' ' };
  assert.deepEqual(await detectCodingAgentLogin('codex', { env }), { loggedIn: true, file: false, env: ['OPENAI_API_KEY'] });
  assert.deepEqual(await detectCodingAgentLogin('claude', { env }), { loggedIn: false, file: false, env: [] });
  assert.deepEqual(await detectCodingAgentLogin('pi', { env: { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 't' } }),
    { loggedIn: false, file: false, env: [] });
  assert.deepEqual(await detectCodingAgentLogin('claude', { env: { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 't' } }),
    { loggedIn: true, file: false, env: ['CLAUDE_CODE_OAUTH_TOKEN'] });
  await assert.rejects(detectCodingAgentLogin('gemini', { env }), /Unknown coding agent: gemini/);
});

test('ala status reports installation, logins and the default agent without printing credentials', async (context) => {
  const root = await tempRoot(context);
  const home = join(root, 'home');
  for (const name of ['codex', 'claude']) {
    await writeFile(join(root, name), '#!/bin/sh\nexit 0\n');
    await chmod(join(root, name), 0o700);
  }
  await write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'secret-token' } });
  await write(home, '.ala/config.json', { codingAgent: 'claude' });
  const env = { HOME: home, PATH: root, OPENAI_API_KEY: 'sk-secret' };
  const run = async (argv) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({ argv, env, stdin: inputStream(), stdout, stderr, cwd: root });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const json = await run(['status', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.doesNotMatch(json.stdout, /secret/);
  const status = JSON.parse(json.stdout);
  assert.equal(status.codingAgent, 'claude');
  assert.equal(status.configuredAgent, 'claude');
  assert.deepEqual(status.agents.map(({ name, available, loggedIn: login, login: sources }) => [name, available, login, sources]), [
    ['codex', true, true, { file: false, env: ['OPENAI_API_KEY'] }],
    ['opencode', false, true, { file: false, env: ['OPENAI_API_KEY'] }],
    ['pi', false, true, { file: false, env: ['OPENAI_API_KEY'] }],
    ['omp', false, true, { file: false, env: ['OPENAI_API_KEY'] }],
    ['claude', true, true, { file: true, env: [] }]
  ]);
  const text = await run(['status']);
  assert.equal(text.code, 0);
  assert.equal(text.stdout, [
    'codex     available      logged in (OPENAI_API_KEY)',
    'opencode  not installed  logged in (OPENAI_API_KEY)',
    'pi        not installed  logged in (OPENAI_API_KEY)',
    'omp       not installed  logged in (OPENAI_API_KEY)',
    'claude    available      logged in (credentials file)  default',
    ''
  ].join('\n'));
  const robot = join(root, 'robot');
  await write(robot, '.codex/auth.json', { tokens: { access_token: 'a' } });
  const explicit = JSON.parse((await run(['status', '--json', '--home', robot])).stdout);
  assert.equal(explicit.configuredAgent, null);
  assert.deepEqual(explicit.agents.map((agent) => agent.login.file), [true, false, false, false, false]);
  const invalid = await run(['status', '--model', 'x']);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Unknown status option: --model/);
});

test('OMP counts as logged in only for an enabled credential row in its agent database', async (context) => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = await tempRoot(context);
  const file = join(home, '.omp', 'agent', 'agent.db');
  await mkdir(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT DEFAULT NULL)');
  database.prepare("INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('p', 'oauth', 'secret', 'revoked')").run();
  database.close();
  const login = async (env) => (await detectCodingAgentLogin('omp', { env })).file;
  assert.equal(await login({ HOME: home }), false);
  const writable = new DatabaseSync(file);
  writable.prepare("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('q', 'api_key', 'secret')").run();
  writable.close();
  assert.equal(await login({ HOME: home }), true);
  assert.equal(await login({ HOME: join(home, 'elsewhere') }), false);
  assert.equal(await login({ HOME: join(home, 'elsewhere'), OMP_DIR: join(home, '.omp') }), true);
  assert.deepEqual(codingAgentLoginFiles('omp', { env: { HOME: home } }), [
    join(home, '.omp', 'agent', 'agent.db'), join(home, '.omp', 'agent', 'agent.db-wal')
  ]);
});
