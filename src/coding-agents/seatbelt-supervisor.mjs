// Runs inside the Seatbelt sandbox as the leader of the agent's process group:
//   node seatbelt-supervisor.mjs <watch-fd> <command> [args...]
// It starts the command with the inherited standard streams and exits with the command's code, or re-raises
// the command's signal. When ALA dies, even through SIGKILL, the watch descriptor reaches end-of-file and the
// supervisor kills its whole process group at once, as Bubblewrap's --die-with-parent does. It writes nothing,
// except one line when the command cannot be started at all.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { constants } from 'node:os';

const FORWARDED = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const [watchArgument, command, ...args] = process.argv.slice(2);
const watchFd = Number(watchArgument);
if (!Number.isInteger(watchFd) || watchFd < 3 || !command) process.exit(64);

let parentGone = false;
const killGroup = () => {
  if (parentGone) return;
  parentGone = true;
  try { process.kill(0, 'SIGKILL'); } catch {}
};

// A group signal from ALA reaches the command directly; the supervisor stays to report how the command ended.
for (const signal of FORWARDED) process.on(signal, () => {});

const watch = new net.Socket({ fd: watchFd, readable: true, writable: false });
watch.on('end', killGroup);
watch.on('close', killGroup);
watch.on('error', killGroup);
watch.resume();
watch.unref();

const cannotStart = (error) => {
  process.stderr.write(`ALA Seatbelt supervisor could not start ${command}: ${error.code || error.message}\n`);
  process.exit(error.code === 'ENOENT' ? 127 : 126);
};

// The shell convention for a command ended by a signal, used when Node cannot re-raise it: Node ignores SIGPIPE
// and SIGXFSZ, and SIGUSR1 would start its inspector, so re-raising them would exit 0 or open a debug port.
const NOT_RERAISED = new Set(['SIGPIPE', 'SIGXFSZ', 'SIGUSR1']);
const signalStatus = (signal) => 128 + (constants.signals[signal] || 0);

let child;
// Some spawn failures (ENOEXEC, EPERM) are thrown at once instead of being emitted as 'error'.
try { child = spawn(command, args, { stdio: 'inherit' }); } catch (error) { cannotStart(error); }
child.on('error', cannotStart);
child.on('exit', (code, signal) => {
  if (signal && NOT_RERAISED.has(signal)) process.exit(signalStatus(signal));
  if (signal) {
    for (const name of FORWARDED) process.removeAllListeners(name);
    process.kill(process.pid, signal);
    // Still alive: the signal was ignored or handled by Node itself.
    setTimeout(() => process.exit(signalStatus(signal)), 100);
    return;
  }
  process.exit(code ?? 1);
});
