import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArguments } from '../src/arguments.mjs';

test('parses ordered payload sources and repeatable tag options', () => {
  const options = parseArguments([
    '--text', 'alpha', '--file', 'input.md', '--url', 'https://example.test/input',
    '--stdin', '--tag', 'documentation',
    'Rewrite', 'this'
  ]);
  assert.equal(options.command, 'execute');
  assert.deepEqual(options.instructionParts, ['Rewrite', 'this']);
  assert.deepEqual(options.sources.map((source) => source.type), ['text', 'file', 'url', 'stdin']);
  assert.deepEqual(options.tags, ['documentation']);
});

test('parses coding-agent discovery and explicit delegation options', () => {
  assert.deepEqual(parseArguments(['agent', 'list', '--json']), {
    command: 'agent', action: 'list', json: true, help: false
  });
  assert.throws(() => parseArguments(['agent', 'list', '--config', 'x.json']), /Unknown agent option: --config/);
  assert.equal(parseArguments(['--agent', 'codex', 'Plan', 'this']).agent, 'codex');
  assert.throws(() => parseArguments(['--agent', 'unknown', 'task']), /must be auto/);
  for (const flag of ['--agent', '--ca']) {
    assert.equal(parseArguments([flag, 'pi', 'run']).agent, 'pi');
  }
  assert.equal(parseArguments(['--ca', 'pi', '--model', 'fast', '--task', 'task']).model, 'fast');
  assert.throws(() => parseArguments(['--websearch', 'research']), /Unknown option: --websearch/);
  assert.throws(() => parseArguments(['--user-message-file', 'user.txt', 'task']), /Unknown option: --user-message-file/);
});

test('parses writable cwd, folders, aliases and explicit mounts', () => {
  const invocation = parseArguments([
    '--home', '/robot', '--cwd', '/work', 'as', 'project',
    '--folder', '/private/turn', 'as', 'runtime',
    '--folder', '/shared', 'write',
    '--taskFile', 'task.prompt', '--MCPServers', 'desktop=http://127.0.0.1:8100/mcp', '--ca', 'codex'
  ]);
  assert.equal(invocation.home, '/robot');
  assert.equal(invocation.cwd, '/work');
  assert.equal(invocation.cwdAlias, 'project');
  assert.deepEqual(invocation.folders, [
    { source: '/private/turn', alias: 'runtime' },
    { source: '/shared', writable: true }
  ]);
  assert.equal(invocation.taskFile, 'task.prompt');
  assert.equal(invocation.mcpServers, 'desktop=http://127.0.0.1:8100/mcp');
});

test('rejects unknown options and missing values', () => {
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
  assert.throws(() => parseArguments(['--task-repo', 'tasks']), /Unknown option/);
  assert.throws(() => parseArguments(['--skill']), /Unknown option/);
  assert.throws(() => parseArguments(['--cwd']), /requires a value/);
  assert.throws(() => parseArguments(['--ploinky-task', './books']), /Unknown option/);
  assert.throws(() => parseArguments(['--runtime-bridge']), /Unknown option/);
  assert.throws(() => parseArguments(['--runtime-bridge', '']), { exitCode: 2 });
});

test('explicit folder destinations and exports do not become prompt text', () => {
  const options = parseArguments(['--folder', '/private/skills', 'at', '/project/.agents/skills', 'expose',
    '--folder', '/other', 'as', 'source', 'expose', '--task', 'Inspect']);
  assert.deepEqual(options.folders, [
    { source: '/private/skills', target: '/project/.agents/skills', expose: true },
    { source: '/other', alias: 'source', expose: true }
  ]);
  assert.deepEqual(options.instructionParts, ['Inspect']);
  for (const modifiers of [['at'], ['as', 'alias', 'at', '/target'], ['at', '/target', 'as', 'alias'],
    ['write', 'at', '/target', 'expose'], ['expose'], ['at', '/target', 'expose', 'expose']]) {
    assert.throws(() => parseArguments(['--folder', '/source', ...modifiers]), { exitCode: 2 });
  }
});

test('rejects invalid native permission policies instead of silently granting full access', () => {
  assert.equal(parseArguments(['--permissions', 'ask-for-approval', 'task']).permissionMode, 'ask-for-approval');
  assert.throws(() => parseArguments(['--permissions', 'allow', 'task']), { exitCode: 2 });
  assert.throws(() => parseArguments(['--permissions', '', 'task']), { exitCode: 2 });
  assert.throws(() => parseArguments(['--permissions']), { exitCode: 2 });
});

test('explicit mount targets and expose are parsed without consuming the task', () => {
  const options = parseArguments(['--folder', '/private/session/skills', 'at', '/project/.agents/skills', 'expose', 'Run']);
  assert.deepEqual(options.folders, [{ source: '/private/session/skills', target: '/project/.agents/skills', expose: true }]);
  assert.deepEqual(options.instructionParts, ['Run']);
  assert.throws(() => parseArguments(['--folder', '/source', 'at']), /requires a value/);
});

test('effort selects coding-agent execution and validates native names and explicit reset', () => {
  assert.equal(parseArguments(['--effort', 'high']).agent, 'auto');
  assert.equal(parseArguments(['--ca', 'claude', '--model', 'opus', '--effort', 'max']).effort, 'max');
  assert.equal(parseArguments(['--effort', 'default']).effort, 'default');
  assert.throws(() => parseArguments(['--effort']), /requires a value/);
  for (const value of ['', 'high\ninvalid', 'high effort']) {
    assert.throws(() => parseArguments(['--effort', value]), /native effort name/);
  }
  assert.throws(() => parseArguments(['--effort', 'high', '--reasoning-effort', 'high']), /cannot be combined/);
});
