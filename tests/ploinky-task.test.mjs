import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addPloinkyTaskMounts } from '../src/coding-agents/ploinky-task.mjs';
import { runProcess } from '../src/coding-agents/process.mjs';
import { canStartBubblewrap } from '../src/coding-agents/sandbox.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ala-ploinky-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = path.join(root, 'context');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(context);
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(context, 'events'));
  await fs.writeFile(path.join(context, 'context.json'), JSON.stringify({ version: 1, env: {}, workingDir: workspace }));
  return { root, context, workspace };
}

test('Ploinky task mounts are explicit, bounded and reject an events symlink', async (t) => {
  const { root, context } = await fixture(t);
  const args = [];
  addPloinkyTaskMounts(args, null);
  assert.deepEqual(args, []);
  addPloinkyTaskMounts(args, context);
  assert.equal(args.includes('/run/ploinky-task'), true);
  assert.equal(args.includes('/Agent'), false);
  assert.equal(args.includes(root), false);
  await fs.rmdir(path.join(context, 'events'));
  await fs.symlink(root, path.join(context, 'events'));
  assert.throws(() => addPloinkyTaskMounts([], context), /events directory/);
});

test('native sandbox reads context and writes receipts without socket or unrelated parent access', {
  skip: !canStartBubblewrap(),
}, async (t) => {
  const { root, context, workspace } = await fixture(t);
  const result = await runProcess({ binary: process.execPath, args: ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const file='/run/ploinky-task/context.json';
    let readonly=false;try{fs.writeFileSync(file,'bad')}catch{readonly=true}
    fs.writeFileSync('/run/ploinky-task/events/test.json','receipt');
    console.log(JSON.stringify({readonly, context:JSON.parse(fs.readFileSync(file)), outside:fs.existsSync(${JSON.stringify(root)})}));
  `], cwd: '/workspace', sandbox: { backend: 'pi', hostWorkspace: workspace, ploinkyTask: context } });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.readonly, true);
  assert.equal(output.outside, false);
  assert.equal(output.context.workingDir, workspace);
  assert.equal(await fs.readFile(path.join(context, 'events/test.json'), 'utf8'), 'receipt');
});
