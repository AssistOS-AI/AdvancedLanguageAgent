import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArguments } from '../src/coding-agents/codex.mjs';
import { buildPiArguments, piModelDetails } from '../src/coding-agents/pi.mjs';
import { openCodeModelDetails } from '../src/coding-agents/opencode.mjs';
import { createCodingAgentService } from '../src/coding-agents/service.mjs';
import { loadConfig, saveConfig } from '../src/config.mjs';

test('effort uses native command options, including continued executions', () => {
    const codex = buildCodexArguments({ prompt: 'next', model: 'native', effort: 'high', continuation: { threadId: 'same' } });
    assert.ok(codex.includes('model_reasoning_effort="high"'));
    assert.ok(codex.includes('resume'));
    const pi = buildPiArguments({ prompt: 'next', sessionId: 'same', sessionDir: '/workspace', effort: 'low' });
    assert.equal(pi[pi.indexOf('--thinking') + 1], 'low');
    assert.ok(!buildCodexArguments({ prompt: 'default' }).some((arg) => arg.includes('reasoning_effort')));
    assert.ok(!buildPiArguments({ prompt: 'default' }).includes('--thinking'));
});

test('native model capabilities determine available efforts without model-name guesses', () => {
    assert.deepEqual(piModelDetails({ provider: 'p', id: 'm', reasoning: false }).efforts, []);
    assert.deepEqual(piModelDetails({ provider: 'p', id: 'm', reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: null } }).efforts,
    ['off', 'low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(openCodeModelDetails({ connected: ['p'], all: [
        { id: 'p', models: { m: { id: 'm', variants: { high: {}, custom: {} } } } },
        { id: 'unavailable', models: { m: { id: 'm' } } },
    ] }), [{ id: 'p/m', label: 'm', efforts: ['high', 'custom'] }]);
});

test('configuration roundtrips effort next to models and rejects orphaned or invalid values', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ala-effort-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, '.ala/config.json');
    const initial = await loadConfig(file);
    assert.deepEqual(initial.codingAgents.efforts, {});
    initial.codingAgents.models = { codex: 'native' };
    initial.codingAgents.efforts = { codex: 'high' };
    await saveConfig(file, initial);
    assert.deepEqual(await loadConfig(file), initial);
    initial.codingAgents.efforts.pi = 'high';
    await assert.rejects(saveConfig(file, initial), /efforts/);
    delete initial.codingAgents.efforts.pi;
    initial.codingAgents.efforts.codex = 'high\ninvalid';
    await assert.rejects(saveConfig(file, initial), /efforts/);
});

for (const backend of ['codex', 'pi', 'opencode']) {
    test(`${backend} forwards supported effort, rejects unsupported values, and clears it on model reset`, async () => {
        const calls = [];
        const service = createCodingAgentService({
            agents: [{ name: backend, available: true, binary: '/unused' }],
            models: { [backend]: 'native' }, efforts: { [backend]: 'high' },
            modelListers: { [backend]: async () => [{ id: 'native', efforts: ['high'] }] },
            runners: { [backend]: async (input) => { calls.push(input); return { outputText: 'ok' }; } },
        });
        try {
            await service.execute('first');
            assert.equal(calls[0].effort, 'high');
            service.setModel(backend, 'native', 'invalid');
            await assert.rejects(service.execute('bad'), /does not advertise/);
            assert.equal(calls.length, 1);
            service.setModel(backend, null);
            await service.execute('default');
            assert.equal(calls[1].effort, null);
        } finally { await service.close(); }
    });
}

test('OpenCode sends effort as a native prompt variant on a resumed session', async () => {
    const { executeOpenCodeTurn, openCodePermissionRules } = await import('../src/coding-agents/opencode-turn.mjs');
    let submitted;
    const server = {
        signal: new AbortController().signal,
        failure: new Promise(() => {}),
        async request(route, options = {}) {
            if (route === '/event') {
                return new Response(new ReadableStream({ start(controller) {
                    options.signal.addEventListener('abort', () => controller.close(), { once: true });
                } }), { headers: { 'content-type': 'text/event-stream' } });
            }
            if (route.endsWith('/prompt_async')) {
                submitted = options.body;
                throw new Error('fixture stopped after submission');
            }
            return { id: 'ses_existing', permission: openCodePermissionRules('full-access', false) };
        },
    };
    await assert.rejects(executeOpenCodeTurn(server, {
        continuation: { sessionId: 'ses_existing' }, prompt: 'Continue', model: 'provider/model', effort: 'high',
    }), /fixture stopped/);
    assert.equal(submitted.variant, 'high');
    assert.deepEqual(submitted.model, { providerID: 'provider', modelID: 'model' });
});
