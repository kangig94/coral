import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let frozen = false;
const ready = {
  kind: 'ready',
  pid: process.pid,
  attemptId: process.env.CORAL_STARTUP_ATTEMPT_ID,
  waiterLaunch: process.env.CORAL_WAITER_LAUNCHED,
  spawnNonce: process.env.CORAL_WAITER_SPAWN_NONCE,
};

process.on('message', (message) => {
  if (message?.kind === 'freeze') {
    frozen = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
});

process.on('disconnect', () => {
  if (!frozen) process.exit(0);
});

if (process.env.CORAL_SENTINEL_RUN_DIR !== undefined)
  writeFileSync(join(process.env.CORAL_SENTINEL_RUN_DIR, `waiter-child-${process.pid}.json`), JSON.stringify(ready));

process.send?.(ready);
