import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCli } from '../src/cli.mjs';
import { readSkillCatalog } from '../src/skill-catalog.mjs';
import { parseArguments } from '../src/arguments.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';
import { captureStream, inputStream, writeAnthropicSkill } from './helpers.mjs';

test('parses an exclusive skill catalog', () => {
  assert.equal(parseArguments(['--skill-catalog', '/catalog', '--task', 'test']).skillCatalog, '/catalog');
  assert.throws(() => parseArguments(['--skill-catalog']), /requires a value/);
});

test('explicit catalogs replace home/environment sources and hide unselected cwd skills without host edits', {
  skip: !canStartBubblewrap()
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-selected-catalog-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const empty = join(root, 'empty');
  const catalog = join(root, 'catalog');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(empty, '[]');
  await writeAnthropicSkill(join(workspace, '.agents'), 'unselected');
  const skills = join(root, 'skills');
  await writeAnthropicSkill(skills, 'selected');
  await writeFile(catalog, JSON.stringify([join(skills, 'skills', 'selected')]));
  const directory = join(root, 'directory');
  const caller = join(root, 'caller-runtime');
  await mkdir(caller);
  await writeFile(join(caller, 'config.json'), 'opaque caller configuration, not ALA JSON');
  await mkdir(directory);
  const copied = await writeAnthropicSkill(directory, 'selected');
  await rename(copied, join(directory, 'selected'));
  await rm(join(directory, 'skills'), { recursive: true });
  const emptyDirectory = join(root, 'empty-directory');
  await mkdir(emptyDirectory);
  for (const [target, names] of [[directory, ['selected']], [emptyDirectory, []]]) {
    await writeFile(join(target, '.catalog.json'), JSON.stringify({ version: 1,
      revision: names.length ? 'selected-revision' : 'empty-revision', policyVersion: 1,
      entries: names.map(name => ({ name, identity: `workspace:${name}` })), diagnostics: [] }));
  }
  const binary = join(root, 'codex');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const names = fs.readdirSync('/workspace/.agents/skills');
if (fs.existsSync('/workspace/runtime/config.json')) {
  fs.writeFileSync(process.env.CODEX_HOME+'/caller-folder', fs.readFileSync('/workspace/runtime/config.json'));
  try { fs.writeFileSync('/workspace/runtime/config.json', 'changed'); process.exit(92); }
  catch (error) { if (!['EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
}
for (const name of names) {
  const selected = '/workspace/.agents/skills/' + name;
  if (!fs.existsSync(selected + '/SKILL.md')) process.exit(91);
  try { fs.writeFileSync(selected + '/forbidden', 'changed'); process.exit(90); }
  catch (error) { if (!['EROFS', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
}
if (process.argv.includes('app-server')) {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (!message.id) return;
    const result = message.method === 'skills/list' ? {data:[{cwd:'/workspace',errors:[],
      skills:names.map(name=>({name,path:'/workspace/.agents/skills/'+name+'/SKILL.md',enabled:true}))}]}
      : message.method === 'thread/start' ? {thread:{id:'catalog-test'},approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}}
      : message.method === 'turn/start' ? {turn:{id:'turn-test'}} : {};
    console.log(JSON.stringify({id:message.id,result}));
    if (message.method === 'turn/start') {
      fs.writeFileSync(process.env.CODEX_HOME+'/visible-skills', names.join('\\n'));
      fs.writeFileSync(process.env.CODEX_HOME+'/arguments', message.params.input[0].text);
      console.log(JSON.stringify({method:'item/completed',params:{threadId:'catalog-test',item:{type:'agentMessage',text:'done',phase:'final_answer'}}}));
      console.log(JSON.stringify({method:'turn/completed',params:{threadId:'catalog-test',turn:{status:'completed'}}}));
    }
  });
} else {
  fs.writeFileSync(process.env.CODEX_HOME+'/visible-skills', names.join('\\n'));
  fs.writeFileSync(process.env.CODEX_HOME+'/arguments', process.argv.join('\\n'));
  console.log(JSON.stringify({type:'thread.started',thread_id:'catalog-test'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
}
`);
  await chmod(binary, 0o700);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, taskRepositories: [{ path: '/missing-config-source' }] }));
  for (const [catalogPath, names] of [[catalog, ['selected']], [empty, []],
    [directory, ['selected']], [emptyDirectory, []]]) {
    const stderr = captureStream();
    const code = await runCli({
      argv: ['--ca', 'codex', '--home', home, '--cwd', workspace, '--config', config,
        '--skill-catalog', catalogPath.slice(root.length + 1), '--task', 'Review'],
      env: { HOME: home, CODEX_BIN: binary, PATH: '/usr/bin', ALA_TASK_REPOSITORIES: '/missing-env-source' },
      stdin: inputStream(), stdout: captureStream(), stderr, cwd: root
    });
    assert.equal(code, 0, stderr.read());
    assert.deepEqual((await readFile(join(home, '.codex/visible-skills'), 'utf8')).trim().split('\n').filter(Boolean), names);
    const prompt = await readFile(join(home, '.codex/arguments'), 'utf8');
    assert.match(prompt, /Use the skills in \.agents\/skills/);
    assert.match(prompt, /supersedes earlier catalog messages/);
    assert.doesNotMatch(prompt, /selected test skill|selected-revision|empty-revision/);
    assert.deepEqual(await readdir(join(workspace, '.agents/skills')), ['unselected']);
    assert.deepEqual(await readdir(join(skills, 'skills', 'selected')), ['SKILL.md']);
    assert.deepEqual(await readdir(join(directory, 'selected')), ['SKILL.md']);
    if (names.length) {
      const explicitErrors = captureStream();
      const sessionId = randomUUID();
      assert.equal(await runCli({
        argv: ['--ca', 'codex', '--skill', 'selected', '--session-id', sessionId,
          '--home', home, '--cwd', workspace, '--config', config,
          '--folder', caller, 'as', 'runtime', '--skill-catalog', catalogPath,
          '--task', 'Use the selected method'],
        env: { HOME: home, CODEX_BIN: binary, PATH: '/usr/bin' },
        stdin: inputStream(), stdout: captureStream(), stderr: explicitErrors, cwd: root
      }), 0, explicitErrors.read());
      const selectedPrompt = await readFile(join(home, '.codex/arguments'), 'utf8');
      assert.match(selectedPrompt, /skill "selected"/);
      assert.match(selectedPrompt, /Read \.agents\/skills\/selected\/SKILL.md again/);
      assert.equal(selectedPrompt.split('User request:').length, 2);
      assert.doesNotMatch(selectedPrompt, /selected test skill|Available skills:/);
      assert.equal(await readFile(join(home, '.codex/caller-folder'), 'utf8'),
        'opaque caller configuration, not ALA JSON');
      const savedSession = JSON.parse(await readFile(join(home, '.ala/sessions', `${sessionId}.json`), 'utf8'));
      assert.equal(savedSession.agent, 'codex');
      assert.equal(await readFile(join(caller, 'config.json'), 'utf8'), 'opaque caller configuration, not ALA JSON');
      assert.deepEqual(await readdir(join(workspace, '.agents/skills')), ['unselected']);
    }
  }
});


test('manifest validation rejects malformed, missing, nested and duplicate-name skills', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ala-manifest-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'skill-catalog.json');
  for (const value of ['{broken', '{}', '[1]', '["relative"]', '["/missing-ala-skill"]']) {
    await writeFile(file, value);
    await assert.rejects(readSkillCatalog(file), /Invalid --skill-catalog manifest/);
  }
  await writeAnthropicSkill(root, 'one');
  const one = join(root, 'skills', 'one');
  const alias = join(root, 'alias');
  await symlink(one, alias);
  await writeFile(file, JSON.stringify([one, one, alias]));
  assert.deepEqual(await readSkillCatalog(file), [one]);
  await writeAnthropicSkill(join(root, 'other'), 'one');
  await writeFile(file, JSON.stringify([one, join(root, 'other', 'skills', 'one')]));
  await assert.rejects(readSkillCatalog(file), /Duplicate task-skill name/);
  await writeAnthropicSkill(one, 'nested');
  await writeFile(file, JSON.stringify([one]));
  await assert.rejects(readSkillCatalog(file), /nested skill/);
  await writeAnthropicSkill(root, 'coding-agent');
  await writeFile(file, JSON.stringify([join(root, 'skills', 'coding-agent')]));
  await assert.rejects(readSkillCatalog(file), /reserved/);
  await writeFile(file, '[]');
  assert.deepEqual(await readSkillCatalog(file), []);
});
