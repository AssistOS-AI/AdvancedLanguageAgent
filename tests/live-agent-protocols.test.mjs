import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexLive, runPiLive } from '../src/coding-agents/live-agents.mjs';
import { runCodex } from '../src/coding-agents/codex.mjs';
import { openJsonChannel } from '../src/coding-agents/json-channel.mjs';

function processFixture(handle, { version } = {}) {
  return (options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const emit = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) handle(JSON.parse(line), emit, options);
    });
    child.kill = () => { queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); }); };
    if (options.args.includes('--version')) {
      queueMicrotask(() => {
        child.stdout.write(`${version || 'missing explicit version fixture'}\n`);
        child.exitCode = 0;
        child.emit('close', 0);
      });
    }
    return child;
  };
}

test('isolated Codex checks the executing process before thread restoration and model turn', async () => {
  for (const [runner, lateAt] of [[runCodexLive, 1], [runCodexLive, 2], [runCodex, 1]]) {
    let processIndex = 0;
    const methods = [];
    const spawnImpl = (options) => {
      const index = ++processIndex;
      let actualReads = 0;
      return processFixture((request, emit) => {
        methods.push([index, request.method]);
        if (request.method === 'initialized') return;
        let result = {};
        if (request.method === 'skills/list') {
          const late = index % 3 === 0 && ++actualReads >= lateAt;
          result = { data: [{ cwd: '/workspace', errors: [], skills: late
            ? [{ path: '/home/ala/.codex/skills/late/SKILL.md', enabled: true }] : [] }] };
        }
        if (request.method === 'thread/resume') result = { thread: { id: 'same-thread' },
          approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } };
        emit({ id: request.id, result });
      })(options);
    };
    await assert.rejects(runner({ workspace: '/workspace', prompt: 'Continue',
      continuation: { threadId: 'same-thread' }, sandbox: { isolatedSkills: true, mounts: [] }, spawnImpl }),
    /execution skill registration differs/);
    assert.equal(processIndex, 9);
    assert.equal(methods.filter(([, method]) => method === 'thread/resume').length, lateAt === 2 ? 3 : 0);
    assert.ok(!methods.some(([, method]) => method === 'turn/start'));
  }
});

for (const resume of [false, true]) {
test(`late registration preserves existing conversations, discards provisional threads (resume=${resume})`, async () => {
  let processes = 0;
  const methods = [];
  const saved = [];
  const registrations = [];
  const late = '/home/ala/.codex/plugins/late/SKILL.md';
  const result = await runCodexLive({ workspace: '/workspace', prompt: 'Work',
    continuation: resume ? { threadId: 'same-new-thread' } : null,
    sandbox: { isolatedSkills: true, mounts: [] }, onSession: async (value) => saved.push(value.threadId),
    onSkillRegistration: (value) => registrations.push(value),
    spawnImpl: (options) => {
      const index = ++processes;
      let listed = 0;
      if (index >= 5) assert.ok(options.args.some((value) => value.includes(`${late}\",enabled=false`)));
      return processFixture((request, emit) => {
        methods.push(request.method);
        if (request.method === 'initialized') return;
        let result = {};
        if (request.method === 'skills/list') {
          const present = (index === 3 && ++listed > 1) || index >= 5;
          result = { data: [{ cwd: '/workspace', errors: [], skills: present
            ? [{ path: late, enabled: index === 3 }] : [] }] };
        }
        if (['thread/start', 'thread/resume'].includes(request.method)) {
          if (request.method === 'thread/resume') {
            assert.ok(resume, 'an unmaterialized new thread cannot be resumed');
            assert.equal(request.params.threadId, 'same-new-thread');
          }
          result = { thread: { id: 'same-new-thread' }, approvalPolicy: 'never',
            approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } };
        }
        if (request.method === 'turn/start') {
          assert.deepEqual(saved, resume ? ['same-new-thread', 'same-new-thread'] : [],
            'do not publish a new thread before its first accepted turn');
          result = { turn: { id: 'only-turn' } };
        }
        emit({ id: request.id, result });
        if (request.method === 'turn/start') {
          emit({ method: 'item/completed', params: { threadId: 'same-new-thread', item: { type: 'agentMessage', text: 'done' } } });
          emit({ method: 'turn/completed', params: { threadId: 'same-new-thread', turn: { status: 'completed' } } });
        }
      })(options);
    } });
  assert.equal(result.outputText, 'done');
  assert.deepEqual(saved, resume ? ['same-new-thread', 'same-new-thread'] : ['same-new-thread']);
  assert.equal(processes, 6);
  assert.equal(methods.filter((method) => method === 'thread/start').length, resume ? 0 : 2);
  assert.equal(methods.filter((method) => method === 'thread/resume').length, resume ? 2 : 0);
  assert.equal(methods.filter((method) => method === 'turn/start').length, 1);
  assert.equal(registrations[0].state, 'reconfigure');
  assert.deepEqual(registrations[1], { state: 'verified', reconfigurations: 1, threadId: 'same-new-thread' });
});
}

test('native requests stay separate from outgoing replies, including integer and string ID collisions', async (t) => {
  let emit;
  const sent = [];
  const requests = [];
  const channel = openJsonChannel({ workspace: '/workspace' }, [], processFixture((record, publish) => {
    sent.push(record); emit = publish;
  }));
  t.after(() => channel.close());
  channel.events.on('request', (request) => requests.push(request));
  let answered = false;
  const outgoing = channel.request({ method: 'turn/start' }).then((result) => {
    answered = true; return result;
  });
  const id = sent[0].id;
  assert.equal(id, '1');
  emit({ id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'touch scratch' } });
  emit({ id, method: 'item/fileChange/requestApproval', params: { path: 'scratch' } });
  emit({ id: 1, result: { wrong: 'numeric response cannot answer a string request' } });
  await Promise.resolve();
  assert.equal(answered, false);
  assert.deepEqual(requests.map((request) => request.id), [1, '1']);
  channel.respond(1, { decision: 'decline' });
  channel.respondError(id, { code: -32601, message: 'Unsupported native method' });
  assert.throws(() => channel.respond(1, { decision: 'accept' }), /already answered/);
  assert.throws(() => channel.respondError(id, { code: -32601, message: 'again' }), /already answered/);
  assert.deepEqual(sent.slice(1), [
    { id: 1, result: { decision: 'decline' } },
    { id: '1', error: { code: -32601, message: 'Unsupported native method' } }
  ]);
  emit({ id, result: { turn: { id: 'native-turn' } } });
  assert.deepEqual(await outgoing, { turn: { id: 'native-turn' } });
});

test('unhandled native requests fail explicitly without consuming outgoing commands', async (t) => {
  const replies = [];
  const channel = openJsonChannel({ workspace: '/workspace' }, [], processFixture((record, emit) => {
    if (record.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: record.id, method: 'dynamicTool/execute', params: {} });
      emit({ id: record.id, result: { initialized: true } });
    } else replies.push(record);
  }));
  t.after(() => channel.close());
  assert.deepEqual(await channel.request({ method: 'initialize' }), { initialized: true });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].jsonrpc, '2.0');
  assert.equal(replies[0].id, '1');
  assert.equal(replies[0].error.code, -32601);
  assert.match(replies[0].error.message, /dynamicTool\/execute/);
  assert.throws(() => channel.respond('1', {}), /already answered/);
});

test('native approval requests do not expire with the outgoing RPC command timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replies = [];
  const channel = openJsonChannel({ workspace: '/workspace' }, [], processFixture((record, emit) => {
    if (record.method === 'initialized') emit({ id: 42, method: 'item/permissions/requestApproval', params: {} });
    else replies.push(record);
  }));
  t.after(() => channel.close());
  channel.events.on('request', () => {});
  channel.send({ method: 'initialized' });
  t.mock.timers.tick(30001);
  channel.respond(42, { permissions: {}, scope: 'turn' });
  assert.deepEqual(replies, [{ id: 42, result: { permissions: {}, scope: 'turn' } }]);
});

test('closing a channel invalidates pending native replies before the child exits', async () => {
  let emit;
  const sent = [];
  const channel = openJsonChannel({ workspace: '/workspace' }, [], processFixture((record, publish) => {
    sent.push(record); emit = publish;
  }));
  channel.events.on('request', () => {});
  channel.send({ method: 'initialized' });
  emit({ id: 7, method: 'item/commandExecution/requestApproval' });
  const closing = channel.close();
  assert.throws(() => channel.respond(7, { decision: 'accept' }), /process closed/);
  await closing;
  assert.deepEqual(sent, [{ method: 'initialized' }]);
});

test('protocol failure invalidates pending native requests and rejects outstanding commands', async (t) => {
  let emit;
  const sent = [];
  const channel = openJsonChannel({ workspace: '/workspace' }, [], processFixture((record, publish) => {
    sent.push(record); emit = publish;
  }));
  t.after(() => channel.close());
  channel.events.on('request', () => {});
  const rejected = assert.rejects(channel.request({ method: 'turn/start' }), /Duplicate pending/);
  emit({ id: 5, method: 'item/commandExecution/requestApproval' });
  emit({ id: 5, method: 'item/fileChange/requestApproval' });
  await rejected;
  assert.throws(() => channel.respond(5, { decision: 'accept' }), /Duplicate pending/);
  assert.equal(sent.length, 1);
});

test('Codex resumes a thread, steers its active turn and returns the final response', async () => {
  let saved;
  let delivered;
  const methods = [];
  const result = await runCodexLive({ workspace: '/workspace', prompt: 'Continue.',
    continuation: { threadId: 'saved-thread' }, onSession: async (value) => { saved = value; },
    setMessageHandler: (handler) => { if (handler) delivered = handler('check tests'); },
    spawnImpl: processFixture((request, emit) => {
      methods.push(request.method);
      if (request.method === 'initialized') return;
      let result = {};
      if (request.method === 'thread/resume') {
        assert.equal(request.params.threadId, 'saved-thread');
        result = { thread: { id: 'saved-thread' }, approvalPolicy: 'never', approvalsReviewer: 'user',
          sandbox: { type: 'dangerFullAccess' } };
      }
      if (request.method === 'turn/start') {
        assert.equal(saved.threadId, 'saved-thread'); result = { turn: { id: 'turn-1' } };
      }
      emit({ id: request.id, result });
      if (request.method === 'turn/steer') {
        assert.equal(request.params.expectedTurnId, 'turn-1');
        emit({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } });
        emit({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { status: 'completed' } } });
      }
    }) });
  assert.deepEqual(await delivered, { delivery: 'delivered' });
  assert.equal(result.outputText, 'done');
  assert.ok(!methods.includes('thread/start'));
});

test('Codex progress contains whole intermediate messages, never final-answer tokens', async () => {
  for (const withPhase of [true, false]) {
    for (const withWork of [true, false]) {
      const visible = [];
      const result = await runCodexLive({ workspace: '/workspace', prompt: 'hi',
        onVisibleText: (text) => visible.push(text),
        spawnImpl: processFixture((request, emit) => {
          if (request.method === 'initialized') return;
          const result = request.method === 'thread/start'
            ? { thread: { id: 't' }, approvalPolicy: 'never', approvalsReviewer: 'user',
              sandbox: { type: 'dangerFullAccess' } }
            : request.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
          emit({ id: request.id, result });
          if (request.method !== 'turn/start') return;
          const publish = (method, item) => emit({ method, params: { threadId: 't', item } });
          if (withWork) {
            publish('item/completed', { type: 'agentMessage', text: 'Checking files.',
              ...(withPhase ? { phase: 'commentary' } : {}) });
            publish('item/started', { type: 'commandExecution' });
            emit({ method: 'item/commandExecution/outputDelta', params: { delta: 'REA' } });
            publish('item/completed', { type: 'commandExecution', aggregatedOutput: 'README.md\n' });
          }
          for (const delta of ['S', 'unt', ' aici', '.']) {
            emit({ method: 'item/agentMessage/delta', params: { delta } });
          }
          publish('item/completed', { type: 'agentMessage', text: 'Sunt aici.',
            ...(withPhase ? { phase: 'final_answer' } : {}) });
          emit({ method: 'turn/completed', params: { threadId: 't', turn: { status: 'completed' } } });
        }) });
      assert.equal(result.outputText, 'Sunt aici.');
      assert.deepEqual(visible, withWork ? ['Checking files.', 'README.md\n'] : []);
    }
  }
});

test('Codex Stop interrupts the native turn after saving its resumable identity', async () => {
  const controller = new AbortController();
  let saved;
  let interrupted = false;
  await assert.rejects(runCodexLive({ workspace: '/workspace', prompt: 'work', signal: controller.signal,
    onSession: async (value) => { saved = value; },
    setMessageHandler: (handler) => { if (handler) controller.abort(); },
    spawnImpl: processFixture((request, emit) => {
      if (request.method === 'initialized') return;
      let result = {};
      if (request.method === 'thread/start') result = {
        thread: { id: 'durable-thread' }, approvalPolicy: 'never', approvalsReviewer: 'user',
        sandbox: { type: 'dangerFullAccess' }
      };
      if (request.method === 'turn/start') result = { turn: { id: 'active-turn' } };
      emit({ id: request.id, result });
      if (request.method === 'turn/interrupt') {
        assert.equal(saved.threadId, 'durable-thread');
        assert.equal(request.params.turnId, 'active-turn');
        interrupted = true;
        emit({ method: 'turn/completed', params: { threadId: 'durable-thread', turn: { status: 'interrupted' } } });
      }
    }) }), /interrupted/);
  assert.equal(interrupted, true);
});

test('Pi records its session before prompting and waits for settled after low-level completion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-pi-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let saved;
  let delivered;
  const result = await runPiLive({ workspace: '/workspace', hostWorkspace: root, prompt: 'work',
    onSession: async (value) => { saved = value; },
    setMessageHandler: (handler) => { if (handler) delivered = handler('new instruction'); },
    spawnImpl: processFixture((request, emit) => {
      const data = request.type === 'get_state'
        ? { sessionId: 'pi-id', sessionFile: '/workspace/.ala-pi-sessions/pi.jsonl' } : {};
      if (request.type === 'prompt') assert.equal(saved.sessionId, 'pi-id');
      emit({ id: request.id, type: 'response', success: true, data });
      if (request.type === 'steer') {
        emit({ type: 'agent_end' });
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } });
        emit({ type: 'agent_settled' });
      }
    }, { version: '0.85.1' }) });
  assert.deepEqual(await delivered, { delivery: 'delivered' });
  assert.equal(result.outputText, 'final');
  assert.equal(result.continuation.sessionId, 'pi-id');
});

test('Pi rejects older or unidentified executables before creating a session or prompting', async () => {
  let work = false;
  await assert.rejects(runPiLive({ workspace: '/workspace', prompt: 'work',
    spawnImpl: processFixture(() => { work = true; }, { version: '0.79.4' }) }), /0\.85\.1.*PI_BIN/);
  assert.equal(work, false);
  await assert.rejects(runPiLive({ workspace: '/workspace', prompt: 'work',
    spawnImpl: processFixture(() => { work = true; }) }), /PI_BIN/);
  assert.equal(work, false);
});

test('Pi ask mode rejects before even probing the executable', async () => {
  let spawned = false;
  await assert.rejects(runPiLive({ permissionMode: 'ask-for-approval',
    spawnImpl: () => { spawned = true; } }), /Pi does not support ask-for-approval/);
  assert.equal(spawned, false);
});

test('Pi Stop clears queued work before abort and waits for native settlement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ala-pi-stop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const commands = [];
  await assert.rejects(runPiLive({ workspace: '/workspace', hostWorkspace: root, prompt: 'work',
    signal: controller.signal,
    setMessageHandler: (handler) => { if (handler) controller.abort(); },
    spawnImpl: processFixture((request, emit) => {
      commands.push(request.type);
      const data = request.type === 'get_state'
        ? { sessionId: 'pi-id', sessionFile: '/workspace/.ala-pi-sessions/pi.jsonl' } : {};
      emit({ id: request.id, type: 'response', success: true, data });
      if (request.type === 'abort') emit({ type: 'agent_settled' });
    }, { version: '0.85.1' }) }), /interrupted/);
  assert.deepEqual(commands.slice(-2), ['clear_queue', 'abort']);
});

for (const resume of [false, true]) {
  test(`Codex applies ask policy before ${resume ? 'resumed' : 'new'} thread work`, async () => {
    const calls = [];
    const result = await runCodexLive({ workspace: '/workspace', prompt: 'work',
      permissionMode: 'ask-for-approval', continuation: resume ? { threadId: 'thread' } : null,
      spawnImpl: processFixture((request, emit) => {
        calls.push(request);
        if (request.method === 'initialized') return;
        let result = {};
        if (request.method === 'thread/start' || request.method === 'thread/resume') {
          assert.equal(request.params.approvalPolicy, 'untrusted');
          assert.equal(request.params.approvalsReviewer, 'user');
          assert.equal(request.params.sandbox, 'danger-full-access');
          result = { thread: { id: 'thread' }, approvalPolicy: 'untrusted', approvalsReviewer: 'user',
            sandbox: { type: 'dangerFullAccess' } };
        }
        if (request.method === 'turn/start') result = { turn: { id: 'turn' } };
        emit({ id: request.id, result });
        if (request.method === 'turn/start') {
          emit({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } });
          emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
        }
      }) });
    assert.equal(result.outputText, 'done');
    assert.ok(calls.find((call) => call.method === (resume ? 'thread/resume' : 'thread/start')));
  });
}
