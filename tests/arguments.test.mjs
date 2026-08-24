import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArguments } from '../src/arguments.mjs';

test('parses ordered payload sources and repeatable tag options', () => {
  const options = parseArguments([
    '--text', 'alpha', '--file', 'input.md', '--url', 'https://example.test/input',
    '--stdin', '--tag', 'documentation',
    '--skill', 'writer', 'Rewrite', 'this'
  ]);
  assert.equal(options.command, 'execute');
  assert.deepEqual(options.instructionParts, ['Rewrite', 'this']);
  assert.deepEqual(options.sources.map((source) => source.type), ['text', 'file', 'url', 'stdin']);
  assert.deepEqual(options.tags, ['documentation']);
  assert.equal(options.skill, 'writer');
});

test('parses repository management commands', () => {
  assert.deepEqual(parseArguments(['repo', 'add', 'https://example.test/tasks.git', '--config', './ala.json']), {
    command: 'repo', action: 'add', target: 'https://example.test/tasks.git', configPath: './ala.json', json: false, help: false
  });
  assert.equal(parseArguments(['repo', 'list', '--json']).json, true);
  assert.equal(parseArguments(['repo', 'remove', 'tasks']).target, 'tasks');
});

test('parses coding-agent discovery and explicit delegation options', () => {
  assert.deepEqual(parseArguments(['agent', 'list', '--json']), {
    command: 'agent', action: 'list', configPath: null, json: true, help: false
  });
  assert.equal(parseArguments(['--agent', 'codex', 'Plan', 'this']).agent, 'codex');
  assert.throws(() => parseArguments(['--agent', 'unknown', 'task']), /must be auto/);
  assert.throws(() => parseArguments(['--agent', 'pi', '--skill', 'translate']), /cannot be used together/);
  assert.throws(() => parseArguments(['--agent', 'pi', '--model', 'fast', 'task']), /cannot be combined/);
});

test('rejects unknown options and missing values', () => {
  assert.throws(() => parseArguments(['--unknown']), /Unknown option/);
  assert.throws(() => parseArguments(['--task-repo', 'tasks']), /Unknown option/);
  assert.throws(() => parseArguments(['--skill']), /requires a value/);
  assert.throws(() => parseArguments(['repo', 'add']), /requires a Git URL/);
  assert.throws(() => parseArguments(['repo', 'add', './tasks']), /requires a Git URL/);
  assert.throws(() => parseArguments(['repo', 'remove']), /requires a repository name, path, or Git URL/);
});
