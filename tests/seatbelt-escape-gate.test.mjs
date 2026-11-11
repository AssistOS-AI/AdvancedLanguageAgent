import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ACCEPTED, ATTEMPTS, CONTROLS, FLAG, NOTES, judgeGate } from '../scripts/seatbelt-escape-gate.mjs';

// Only the verdict and the opt-in refusal are tested here; the gate itself creates real launchd jobs and is run
// by hand. The recorded results are those of a gate run on macOS 27.2.1.
const script = fileURLToPath(new URL('../scripts/seatbelt-escape-gate.mjs', import.meta.url));
const recorded = () => ({
  controls: Object.fromEntries(CONTROLS.map((name) => [name, true])),
  positive: true,
  effects: { submit: false, bootstrap: false, load: false, setenv: false, kill: false, debug_program: false,
    kickstart: true, bootout: true, remove: true },
  leftovers: 0
});

test('the recorded result passes: exactly start and unload of existing jobs take effect', () => {
  assert.deepEqual(ACCEPTED, ['kickstart', 'bootout', 'remove']);
  assert.deepEqual(judgeGate(recorded()), { pass: true, reasons: [] });
  // launchd needs root for debug whether or not the request is confined, so it is no sandbox control.
  assert.deepEqual(NOTES, { debug_program: 'needs root; not a sandbox control' });
});

test('any other launchd request taking effect fails the gate', () => {
  for (const attempt of ATTEMPTS.filter((name) => !ACCEPTED.includes(name))) {
    const record = recorded();
    record.effects[attempt] = true;
    assert.deepEqual(judgeGate(record), { pass: false, reasons: [`took effect outside the sandbox: ${attempt}`] });
  }
});

test('an accepted residual that stops taking effect also fails, so the documentation is revisited', () => {
  const record = recorded();
  record.effects.kickstart = false;
  assert.deepEqual(judgeGate(record).reasons, ['accepted residual no longer takes effect: kickstart']);
});

test('a failed host control, a missing positive marker, a missing result or a leftover fails the gate', () => {
  for (const name of CONTROLS) {
    const control = recorded();
    control.controls[name] = false;
    assert.deepEqual(judgeGate(control).reasons, [`host control failed: ${name}`], name);
  }
  // A victim that never loaded would otherwise read as unloaded, which is the accepted result.
  for (const name of ['victims_loaded', 'sleeper_running', 'debug_loaded']) assert.ok(CONTROLS.includes(name), name);
  assert.deepEqual(judgeGate({ ...recorded(), positive: false }).reasons,
    ['the sandboxed attempts did not run (no positive marker)']);
  const missing = recorded();
  delete missing.effects.setenv;
  assert.deepEqual(judgeGate(missing).reasons, ['no result: setenv']);
  assert.deepEqual(judgeGate({ ...recorded(), leftovers: 1 }).reasons, ['launchd jobs or variables left behind: 1']);
  assert.equal(judgeGate().pass, false);
});

test('the gate refuses to run without its explicit flag', () => {
  for (const argv of [[], ['--run'], ['--help']]) {
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`Run it explicitly: node scripts/seatbelt-escape-gate\\.mjs ${FLAG}`, 'u'));
  }
});
