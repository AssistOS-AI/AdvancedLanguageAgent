import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A stand-in supervisor for the IPC kill test. It forks the sender with an IPC channel, answers the handshake, counts
// the requests it receives, and reports `armed` on standard output once the sender is mid-stream; the test then kills
// this process, so the sender's next write fails the way a write to a dead provider does.
//
// Cleanup is bounded and exact. The sender's PID is printed first (`pid <n>`), and on every exit path this process
// controls (normal exit, an error, SIGTERM, SIGINT, its own time bound, or the sender ending) it signals exactly that
// PID and nothing else: never a group, a name or a pattern. SIGKILL cannot be handled, so the sender carries its own
// watchdog for that case.
const sender = fileURLToPath(new URL('./ipc-sender.mjs', import.meta.url));
const child = fork(sender, [process.argv[2], ...process.argv.slice(3)],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true });
child.unref();
process.stdout.write(`pid ${child.pid}\n`);

const killSender = () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
};
process.on('exit', killSender);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(143));
process.on('uncaughtException', () => process.exit(1));
child.on('exit', () => process.exit(0));
setTimeout(() => process.exit(2), 60_000).unref();

let received = 0;
child.on('message', (message) => {
  if (message.type === 'hello') child.send({ type: 'hello', protocol: 'ala-execution-provider', version: 1 });
  else if (message.type === 'idle-ready' || ++received === 20) process.stdout.write('armed\n');
});
setInterval(() => {}, 1000);
