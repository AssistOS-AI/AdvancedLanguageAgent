import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getAgent } from '../src/coding-agents/registry.mjs';
import { sessionTitle } from '../src/coding-agents/native-sessions.mjs';

const CWD = '/work/project one';
const OTHER = '/work/other';
const lines = (...records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'ala-native-sessions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function write(file, text, modified) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  if (modified) await utimes(file, modified / 1000, modified / 1000);
}

async function catalog(name) {
  return getAgent(name).sessions();
}

test('session titles are one bounded display line', () => {
  assert.equal(sessionTitle('  fix\nthe\t\tbuild  '), 'fix the build');
  assert.equal(sessionTitle('x'.repeat(200)).length, 80);
});

test('claude lists interactive conversations of the folder, newest first, with their title', async (t) => {
  const home = await fixture(t);
  const sessions = await catalog('claude');
  const directory = path.join(home, '.claude', 'projects', '-work-project-one');
  const older = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  const headless = '33333333-3333-4333-8333-333333333333';
  const elsewhere = '44444444-4444-4444-8444-444444444444';
  await write(path.join(directory, `${older}.jsonl`), lines(
    { type: 'user', entrypoint: 'cli', cwd: CWD, timestamp: '2026-01-01T00:00:00Z', message: { content: 'first question' } }
  ), Date.parse('2026-01-02T00:00:00Z'));
  await write(path.join(directory, `${newer}.jsonl`), lines(
    { type: 'user', entrypoint: 'cli', cwd: CWD, timestamp: '2026-01-03T00:00:00Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'ai-title', aiTitle: 'Generated title' }
  ), Date.parse('2026-01-04T00:00:00Z'));
  await write(path.join(directory, `${headless}.jsonl`), lines(
    { type: 'user', entrypoint: 'sdk-cli', cwd: CWD, message: { content: 'robot task' } }
  ));
  await write(path.join(directory, `${elsewhere}.jsonl`), lines(
    { type: 'user', entrypoint: 'cli', cwd: OTHER, message: { content: 'another folder' } }
  ));
  const listed = await sessions.listInteractiveSessions({ home, cwd: CWD });
  assert.deepEqual(listed.map(({ id, title }) => [id, title]), [[newer, 'Generated title'], [older, 'first question']]);
  assert.equal(listed[1].createdAt, Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual(sessions.interactiveArguments({ resume: older }), ['--resume', older]);
  assert.deepEqual(sessions.interactiveArguments({ sessionId: newer }), ['--session-id', newer]);
  assert.deepEqual(sessions.interactiveArguments(), []);
  assert.throws(() => sessions.interactiveArguments({ sessionId: 'not-a-uuid' }), /UUID/u);
  assert.equal(sessions.presetSessionId, true);
});

test('codex lists interactive rollouts of the folder and prefers the conversation name', async (t) => {
  const home = await fixture(t);
  const sessions = await catalog('codex');
  const day = path.join(home, '.codex', 'sessions', '2026', '01', '05');
  const meta = (id, originator, cwd) => ({ type: 'session_meta', payload: { id, originator, cwd, timestamp: '2026-01-05T00:00:00Z', thread_source: 'user' } });
  const user = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  await write(path.join(day, 'rollout-a-named.jsonl'), lines(meta('named', 'codex-tui', CWD), user('<environment_context/>'), user('raw prompt')));
  await write(path.join(day, 'rollout-b-plain.jsonl'), lines(meta('plain', 'codex-tui', CWD), user('plain prompt')));
  await write(path.join(day, 'rollout-c-ala.jsonl'), lines(meta('ala', 'ala', CWD), user('robot prompt')));
  await write(path.join(day, 'rollout-d-other.jsonl'), lines(meta('other', 'codex-tui', OTHER), user('other prompt')));
  await write(path.join(home, '.codex', 'session_index.jsonl'), lines({ id: 'named', thread_name: 'Old name' }, { id: 'named', thread_name: 'New name' }));
  const listed = await sessions.listInteractiveSessions({ home, cwd: CWD });
  assert.deepEqual(listed.map(({ id, title }) => [id, title]).sort(), [['named', 'New name'], ['plain', 'plain prompt']]);
  assert.deepEqual(sessions.interactiveArguments({ resume: 'named' }), ['resume', 'named']);
  assert.deepEqual(sessions.interactiveArguments(), []);
});

test('opencode lists root conversations without an explicit permission set, from a read-only database', async (t) => {
  const home = await fixture(t);
  const sessions = await catalog('opencode');
  const rows = [
    { id: 'ses_user', title: 'User chat', time_created: 1000, time_updated: 3000 },
    { id: 'not_a_session', title: 'Bad row', time_created: 1000, time_updated: 2000 }
  ];
  const calls = [];
  const open = async (file) => ({
    prepare: (sql) => ({ get: () => undefined, all: (...args) => { calls.push({ file, sql, args }); return rows; } }),
    close: () => calls.push('closed')
  });
  const listed = await sessions.listInteractiveSessions({ home, cwd: CWD, limit: 3 }, { open });
  assert.deepEqual(listed, [{ id: 'ses_user', title: 'User chat', createdAt: 1000, updatedAt: 3000 }]);
  assert.equal(calls[0].file, path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  assert.match(calls[0].sql, /permission is null/u);
  assert.match(calls[0].sql, /parent_id is null/u);
  assert.deepEqual(calls[0].args, [CWD, 3]);
  assert.equal(calls.at(-1), 'closed');
  assert.deepEqual(await sessions.listInteractiveSessions({ home, cwd: CWD }), [], 'a missing database lists nothing');
  assert.deepEqual(sessions.interactiveArguments({ resume: 'ses_user' }), ['--session', 'ses_user']);
});

test('pi lists the conversations of the folder with their name or first prompt', async (t) => {
  const home = await fixture(t);
  const sessions = await catalog('pi');
  const directory = path.join(home, '.pi', 'agent', 'sessions', '--work-project one--');
  const header = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: '2026-01-06T00:00:00Z', cwd });
  const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
  await write(path.join(directory, '2026_a.jsonl'), lines(header('a', CWD), user('pi prompt')), Date.parse('2026-01-07T00:00:00Z'));
  await write(path.join(directory, '2026_b.jsonl'), lines(header('b', CWD), user('x'), { type: 'session_info', name: 'Named' }), Date.parse('2026-01-08T00:00:00Z'));
  await write(path.join(directory, '2026_c.jsonl'), lines(header('c', OTHER), user('moved')));
  await write(path.join(directory, '2026_d.jsonl'), lines(header('d', CWD)));
  const listed = await sessions.listInteractiveSessions({ home, cwd: CWD });
  assert.deepEqual(listed.map(({ id, title }) => [id, title]), [['b', 'Named'], ['a', 'pi prompt']]);
  assert.deepEqual(sessions.interactiveArguments({ resume: 'a' }), ['--session', 'a']);
});

test('omp reads the session header of every catalog folder and prefers the conversation title', async (t) => {
  const home = await fixture(t);
  const sessions = await catalog('omp');
  const root = path.join(home, '.omp', 'agent', 'sessions');
  const title = (text) => ({ type: 'title', v: 1, title: text, updatedAt: '2026-01-06T00:00:00Z', pad: '   ' });
  const header = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: '2026-01-06T00:00:00Z', cwd });
  const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
  await write(path.join(root, '-project-one', '2026_a.jsonl'), lines(title(''), header('a', CWD), user('omp prompt')), Date.parse('2026-01-07T00:00:00Z'));
  await write(path.join(root, '-work-project one', '2026_b.jsonl'), lines(title('Named'), header('b', CWD), user('x')), Date.parse('2026-01-08T00:00:00Z'));
  await write(path.join(root, '-other', '2026_c.jsonl'), lines(title(''), header('c', OTHER), user('moved')));
  await write(path.join(root, '-project-one', '2026_d.jsonl'), lines(title(''), header('d', CWD)));
  const listed = await sessions.listInteractiveSessions({ home, cwd: CWD });
  assert.deepEqual(listed.map(({ id, title: text }) => [id, text]), [['b', 'Named'], ['a', 'omp prompt']]);
  assert.deepEqual(sessions.interactiveArguments({ resume: 'a' }), ['--resume', 'a']);
  assert.deepEqual(sessions.interactiveArguments(), []);
  assert.deepEqual(await sessions.listInteractiveSessions({ home: path.join(home, 'none'), cwd: CWD }), []);
});

test('session catalogs refuse relative locations and unsafe identifiers', async () => {
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'omp']) {
    const sessions = await catalog(name);
    await assert.rejects(sessions.listInteractiveSessions({ home: 'relative', cwd: CWD }), /absolute home/u);
    await assert.rejects(sessions.listInteractiveSessions({ home: '/home', cwd: 'relative' }), /absolute folder/u);
    assert.throws(() => sessions.interactiveArguments({ resume: '../escape' }), /Invalid session/u);
  }
});

test('vibe identifies concurrent conversations by persisted launch binding, including an untitled session', async t => {
  const home = await fixture(t);
  const sessions = await catalog('vibe');
  assert.equal(sessions.sessionBindingSupported, true);
  const keys = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (let i = 0; i < keys.length; i++) {
    const directory = path.join(home, '.vibe/logs/session/unified', `conversation-${i}`);
    await write(path.join(directory, 'meta.json'), JSON.stringify({ session_id: `conversation-${i}`, origin_directory: CWD }));
    await write(path.join(directory, 'CURRENT'), JSON.stringify({ generation: '0000000000000001' }));
    await write(path.join(directory, 'generations/0000000000000001/runtime-state.json'), JSON.stringify({
      core_system_instructions: `Native instructions\nSession binding: ${keys[i]}\nMore native instructions`,
    }));
  }
  const listed = await sessions.listInteractiveSessions({ home, cwd: CWD });
  assert.equal(listed.length, 2);
  for (let i = 0; i < keys.length; i++) assert.equal(listed.find(row => row.id === `conversation-${i}`).sessionBinding, keys[i]);
  const directory = path.join(home, '.vibe/logs/session/unified/conversation-0');
  await write(path.join(directory, 'CURRENT'), JSON.stringify({ generation: '../../outside' }));
  assert.deepEqual((await sessions.listInteractiveSessions({ home, cwd: CWD })).map(row => row.id), ['conversation-1']);
});
