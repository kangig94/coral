import { writeFileSync } from 'node:fs';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';

process.on('SIGTERM', () => {});
void claimCoordinatorLaunch().then((admitted) => {
  if (!admitted) return process.exit(1);
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('kind' in message)) return;
    if (message.kind === 'coral-sentinel-armed')
      writeFileSync(process.env.CORAL_FIXTURE_CHILD_READY_PATH!, String(process.pid));
  });
  process.send?.({ kind: 'coral-sentinel-hello', id: process.env.CORAL_SENTINEL_ID });
  setInterval(() => {}, 60_000);
});
