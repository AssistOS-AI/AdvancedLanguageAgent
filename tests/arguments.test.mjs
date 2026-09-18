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
    command: 'agent', action: 'list', configPath: null, json: true, help: false
  });
  assert.equal(parseArguments(['--agent', 'codex', 'Plan', 'this']).agent, 'codex');
  assert.throws(() => parseArguments(['--agent', 'unknown', 'task']), /must be auto/);
  for (const flag of ['--agent', '--ca']) {
    assert.equal(parseArguments([flag, 'pi', 'run']).agent, 'pi');
  }
  assert.equal(parseArguments(['--ca', 'pi', '--model', 'fast', '--task', 'task']).model, 'fast');
  assert.equal(parseArguments(['--websearch', 'on', 'research']).websearch, true);
  assert.equal(parseArguments(['--websearch', 'off', 'offline']).websearch, false);
  assert.equal(parseArguments(['--websearch', 'research']).websearch, true);
  assert.deepEqual(parseArguments(['--websearch', 'research']).instructionParts, ['research']);
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

test('rejects invalid native permission policies instead of silently granting full access', () => {
  assert.equal(parseArguments(['--permissions', 'ask-for-approval', 'task']).permissionMode, 'ask-for-approval');
  assert.throws(() => parseArguments(['--permissions', 'allow', 'task']), { exitCode: 2 });
  assert.throws(() => parseArguments(['--permissions', '', 'task']), { exitCode: 2 });
  assert.throws(() => parseArguments(['--permissions']), { exitCode: 2 });
});
