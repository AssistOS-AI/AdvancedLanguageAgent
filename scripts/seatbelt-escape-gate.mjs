#!/usr/bin/env node
// Opt-in escape gate for the macOS Seatbelt sandbox; DS006 defines the launchd residual it checks.
//
//   node scripts/seatbelt-escape-gate.mjs --run-launchd-attempts
//
// It asks launchd, from inside the profile ALA really builds, to create, load, start, signal, reprogram and unload
// throwaway jobs, and to set a launchd variable. Every job, variable and marker carries a label unique to this run;
// host-side controls first prove that each refused request works when it is not confined, and cleanup always runs.
// Exit 0 only when exactly the three accepted requests take effect (kickstart of an existing job, and unloading
// one through bootout or remove) and every other attempt is refused. Run it after an allowlist change and on a
// new macOS version; it is not part of npm test, because it creates and removes real jobs in the login session.
// debug_program has no host control: launchd requires root for it whether or not the request is confined, so its
// refusal is reported but says nothing about the sandbox. Cleanup also runs on SIGINT and SIGTERM.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FLAG = '--run-launchd-attempts';
export const ACCEPTED = Object.freeze(['kickstart', 'bootout', 'remove']);
export const ATTEMPTS = Object.freeze(['submit', 'bootstrap', 'load', 'setenv', 'kill', 'debug_program',
  ...ACCEPTED]);
// Host controls: each refused request works unconfined, and each target job is in place before the attempts,
// so a job that never loaded cannot read as "unloaded" and a sleeper that never ran cannot read as "not killed".
export const CONTROLS = Object.freeze(['bootstrap', 'load', 'submit', 'setenv', 'kill', 'victims_loaded',
  'sleeper_running', 'debug_loaded']);
const LAUNCHCTL = '/bin/launchctl';
export const NOTES = Object.freeze({ debug_program: 'needs root; not a sandbox control' });
let pendingCleanup = null;

// The verdict on one recorded run: { controls: {name: worked}, positive, effects: {attempt: tookEffect}, leftovers }.
export function judgeGate({ controls = {}, positive = false, effects = {}, leftovers = 0 } = {}) {
  const reasons = [];
  for (const name of CONTROLS) if (controls[name] !== true) reasons.push(`host control failed: ${name}`);
  if (positive !== true) reasons.push('the sandboxed attempts did not run (no positive marker)');
  for (const attempt of ATTEMPTS) {
    const expected = ACCEPTED.includes(attempt);
    if (typeof effects[attempt] !== 'boolean') reasons.push(`no result: ${attempt}`);
    else if (effects[attempt] && !expected) reasons.push(`took effect outside the sandbox: ${attempt}`);
    else if (!effects[attempt] && expected) reasons.push(`accepted residual no longer takes effect: ${attempt}`);
  }
  if (leftovers !== 0) reasons.push(`launchd jobs or variables left behind: ${leftovers}`);
  return { pass: reasons.length === 0, reasons };
}

const launchctl = (...args) => spawnSync(LAUNCHCTL, args, { encoding: 'utf8', timeout: 15000 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (check()) return true;
  return check();
}

function plist(file, label, program, runAtLoad) {
  const strings = program.map((value) => `<string>${value}</string>`).join('');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key>`
    + `<string>${label}</string><key>ProgramArguments</key><array>${strings}</array><key>RunAtLoad</key>`
    + `<${runAtLoad}/></dict></plist>\n`);
}

function jobPid(domain, label) {
  const printed = launchctl('print', `${domain}/${label}`);
  return printed.status === 0 ? (/\bpid = (\d+)/u.exec(printed.stdout)?.[1] || 'loaded') : null;
}

async function runInside(work, home, script) {
  const { createCodingAgentService } = await import('../src/coding-agents/service.mjs');
  const { runProcess } = await import('../src/coding-agents/process.mjs');
  const service = createCodingAgentService({
    agents: [{ name: 'codex', available: true, binary: '/bin/sh' }], workspace: work, cwd: work,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C' },
    runners: { codex: async (input) => ({ continuation: null, outputText: JSON.stringify(await runProcess({
      binary: '/bin/sh', args: [script], cwd: input.workspace, env: input.env, sandbox: input.sandbox })) }) }
  });
  try { return JSON.parse(await service.execute('gate')); } finally { await service.close(); }
}

async function gate() {
  const id = `${Date.now()}-${process.pid}`;
  const domain = `gui/${process.getuid()}`;
  const prefix = `com.ala.seatbelt-gate.${id}`;
  const variable = `ALA_SEATBELT_GATE_${id.replace(/\W/gu, '_')}`;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ala-escape-gate-'));
  const [work, out, host, home] = ['run', 'outside', 'host', 'home'].map((name) => path.join(root, name));
  for (const folder of [work, out, host, home]) fs.mkdirSync(folder);
  const marker = (name) => path.join(out, `marker-${name}`);
  const labels = ['submit', 'bootstrap', 'load', 'kick', 'debug', 'sleeper', 'victim-bootout', 'victim-remove',
    'ctl-load', 'ctl-submit', 'ctl-kill'].map((name) => `${prefix}.${name}`);
  const record = { controls: {}, positive: false, effects: {}, leftovers: 0, attempts: '' };
  let cleaned = false;
  // Idempotent: runs from finally, and from a SIGINT or SIGTERM that arrives while the attempts are running.
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const label of labels) {
      launchctl('bootout', `${domain}/${label}`);
      launchctl('remove', label);
    }
    for (const name of [variable, `${variable}_CTL`]) launchctl('unsetenv', name);
    const listed = launchctl('list').stdout.split('\n').filter((line) => line.includes(prefix)).length;
    const variables = [variable, `${variable}_CTL`].filter((name) => launchctl('getenv', name).stdout.trim()).length;
    record.leftovers = listed + variables;
    fs.rmSync(root, { recursive: true, force: true });
    pendingCleanup = null;
  };
  pendingCleanup = cleanup;
  try {
    plist(path.join(work, 'bootstrap.plist'), `${prefix}.bootstrap`, ['/usr/bin/touch', marker('bootstrap')], true);
    plist(path.join(work, 'load.plist'), `${prefix}.load`, ['/usr/bin/touch', marker('load')], true);
    plist(path.join(host, 'kick.plist'), `${prefix}.kick`, ['/usr/bin/touch', marker('kickstart')], false);
    plist(path.join(host, 'debug.plist'), `${prefix}.debug`, ['/usr/bin/true'], false);
    plist(path.join(host, 'sleeper.plist'), `${prefix}.sleeper`, ['/bin/sleep', '600'], true);
    plist(path.join(host, 'victim-bootout.plist'), `${prefix}.victim-bootout`, ['/usr/bin/true'], false);
    plist(path.join(host, 'victim-remove.plist'), `${prefix}.victim-remove`, ['/usr/bin/true'], false);
    plist(path.join(host, 'ctl-load.plist'), `${prefix}.ctl-load`, ['/usr/bin/true'], false);
    plist(path.join(host, 'ctl-kill.plist'), `${prefix}.ctl-kill`, ['/bin/sleep', '600'], true);
    fs.writeFileSync(path.join(work, 'evil.sh'), `#!/bin/sh\n/usr/bin/touch '${marker('debug')}'\n`, { mode: 0o755 });

    // Host controls: the same requests work when they are not confined.
    for (const name of ['kick', 'debug', 'sleeper', 'victim-bootout', 'victim-remove']) {
      launchctl('bootstrap', domain, path.join(host, `${name}.plist`));
    }
    record.controls.bootstrap = jobPid(domain, `${prefix}.kick`) !== null;
    launchctl('load', path.join(host, 'ctl-load.plist'));
    record.controls.load = jobPid(domain, `${prefix}.ctl-load`) !== null;
    launchctl('submit', '-l', `${prefix}.ctl-submit`, '--', '/usr/bin/touch', marker('control-submit'));
    record.controls.submit = await until(() => fs.existsSync(marker('control-submit')), 6000);
    launchctl('setenv', `${variable}_CTL`, '1');
    record.controls.setenv = launchctl('getenv', `${variable}_CTL`).stdout.trim() === '1';
    launchctl('bootstrap', domain, path.join(host, 'ctl-kill.plist'));
    await until(() => /^\d+$/u.test(jobPid(domain, `${prefix}.ctl-kill`) || ''), 4000);
    const controlPid = jobPid(domain, `${prefix}.ctl-kill`);
    launchctl('kill', 'SIGKILL', `${domain}/${prefix}.ctl-kill`);
    record.controls.kill = /^\d+$/u.test(controlPid || '')
      && await until(() => jobPid(domain, `${prefix}.ctl-kill`) !== controlPid, 4000);
    record.controls.sleeper_running = await until(() => /^\d+$/u.test(jobPid(domain, `${prefix}.sleeper`) || ''), 4000);
    const sleeperPid = jobPid(domain, `${prefix}.sleeper`);
    record.controls.victims_loaded = ['victim-bootout', 'victim-remove']
      .every((name) => jobPid(domain, `${prefix}.${name}`) !== null);
    record.controls.debug_loaded = jobPid(domain, `${prefix}.debug`) !== null;

    const script = path.join(work, 'inside.sh');
    fs.writeFileSync(script, `: > '${work}/ran'
attempt() { name="$1"; shift; "$@" >/dev/null 2>"${work}/err"; printf '%s\\trc=%s\\t%s\\n' "$name" "$?" \\
  "$(head -c 120 "${work}/err" | tr '\\n\\t' '  ')"; }
attempt submit ${LAUNCHCTL} submit -l ${prefix}.submit -- /usr/bin/touch '${marker('submit')}'
attempt bootstrap ${LAUNCHCTL} bootstrap ${domain} '${work}/bootstrap.plist'
attempt load ${LAUNCHCTL} load '${work}/load.plist'
attempt setenv ${LAUNCHCTL} setenv ${variable} 1
attempt kill ${LAUNCHCTL} kill SIGTERM ${domain}/${prefix}.sleeper
attempt debug_program ${LAUNCHCTL} debug ${domain}/${prefix}.debug --program '${work}/evil.sh'
attempt debug_kickstart ${LAUNCHCTL} kickstart ${domain}/${prefix}.debug
attempt kickstart ${LAUNCHCTL} kickstart ${domain}/${prefix}.kick
attempt bootout ${LAUNCHCTL} bootout ${domain}/${prefix}.victim-bootout
attempt remove ${LAUNCHCTL} remove ${prefix}.victim-remove
`);
    const inside = await runInside(work, home, script);
    record.attempts = inside.stdout;
    record.positive = fs.existsSync(path.join(work, 'ran'));
    await pause(4000);
    const exists = (name) => jobPid(domain, `${prefix}.${name}`) !== null;
    Object.assign(record.effects, {
      submit: fs.existsSync(marker('submit')) || exists('submit'),
      bootstrap: fs.existsSync(marker('bootstrap')) || exists('bootstrap'),
      load: fs.existsSync(marker('load')) || exists('load'),
      setenv: launchctl('getenv', variable).stdout.trim() !== '',
      kill: jobPid(domain, `${prefix}.sleeper`) !== sleeperPid,
      debug_program: fs.existsSync(marker('debug')),
      kickstart: fs.existsSync(marker('kickstart')),
      bootout: !exists('victim-bootout'),
      remove: !exists('victim-remove')
    });
  } finally {
    cleanup();
  }
  return record;
}

async function main(argv) {
  if (!argv.includes(FLAG)) {
    process.stderr.write(`This gate creates and removes throwaway launchd jobs in your login session.\n`
      + `Run it explicitly: node scripts/seatbelt-escape-gate.mjs ${FLAG}\n`);
    return 2;
  }
  if (process.platform !== 'darwin') {
    process.stderr.write('The Seatbelt escape gate runs only on macOS.\n');
    return 2;
  }
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      pendingCleanup?.();
      process.stderr.write(`Interrupted by ${signal}; launchd jobs and variables of this run were removed.\n`);
      process.exit(status);
    });
  }
  const record = await gate();
  process.stdout.write(`Sandboxed attempts (exit status and first error bytes):\n${record.attempts}\n`);
  for (const [name, worked] of Object.entries(record.controls)) process.stdout.write(`control ${name}: ${worked}\n`);
  for (const attempt of ATTEMPTS) {
    const expected = ACCEPTED.includes(attempt) ? 'accepted residual'
      : `must be refused${NOTES[attempt] ? `; ${NOTES[attempt]}` : ''}`;
    process.stdout.write(`${attempt}: ${record.effects[attempt] ? 'TOOK EFFECT' : 'no effect'} (${expected})\n`);
  }
  process.stdout.write(`positive marker: ${record.positive}; left behind: ${record.leftovers}\n`);
  const verdict = judgeGate(record);
  process.stdout.write(verdict.pass ? 'PASS: exactly the accepted launchd residual, nothing else.\n'
    : `FAIL:\n${verdict.reasons.map((reason) => `  ${reason}`).join('\n')}\n`);
  return verdict.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
