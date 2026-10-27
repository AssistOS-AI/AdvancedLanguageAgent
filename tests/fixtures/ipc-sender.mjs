import { writeFileSync } from 'node:fs';

import { createProtocolProvider } from '../../src/coding-agents/provider-client.mjs';

// A stand-in for ALA that talks to its supervisor over the inherited IPC channel and keeps sending until the
// supervisor dies. It records its exit code in the file named by argv[2]: an unhandled channel error would end it
// with 1, while a handled provider failure ends it with 5, the execution exit code. With argv[3] === 'idle' it only
// announces itself and waits, which isolates the watchdog below.
const result = process.argv[2];
const idle = process.argv[3] === 'idle';
process.on('exit', (code) => { try { writeFileSync(result, String(code)); } catch { /* the test reads nothing */ } });

// Watchdog: this process must never outlive its test. It exits with 98 as soon as its parent is gone (a detached
// child is re-parented), and with 97 after a fixed bound. It signals only itself.
const WATCHDOG_BOUND_MS = 30_000;
const parent = process.ppid;
setTimeout(() => process.exit(97), WATCHDOG_BOUND_MS).unref();
setInterval(() => { if (process.ppid !== parent) process.exit(98); }, 200).unref();

if (idle) {
  process.send({ type: 'idle-ready' });
  setInterval(() => {}, 1000);
} else {
  const provider = createProtocolProvider({ requestTimeoutMs: 60_000, baseEnv: {} });
  // Large messages keep writes in flight, so the supervisor's death lands while a write is pending.
  const padding = 'x'.repeat(48 * 1024);
  const flood = setInterval(() => {
    for (let burst = 0; burst < 400; burst += 1) {
      try { process.send({ type: 'inventory', id: 0, padding }); } catch { /* closed */ }
    }
    provider.inventory().catch(() => {
      clearInterval(flood);
      process.exitCode = 5;
      void provider.close();
    });
  }, 1);
}
