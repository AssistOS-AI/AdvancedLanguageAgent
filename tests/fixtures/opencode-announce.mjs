#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

// Stands in for `opencode serve`: it only announces the loopback origin that the test's own HTTP server owns,
// so the test controls every socket and a restart reuses the same origin.
if (process.argv.includes('--version')) {
  process.stdout.write('1.15.13\n');
  process.exit(0);
}
writeFileSync('announce-password', process.env.OPENCODE_SERVER_PASSWORD ?? '');
process.stdout.write(`opencode server listening on http://127.0.0.1:${process.env.OPENCODE_FIXTURE_PORT}\n`);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 60_000);
