import { spawn } from 'node:child_process';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';

process.on('message', (message: unknown) => {
  if (message === 'exit') process.exit(0);
  if (message === 'spawn-descendant') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    descendant.unref();
    process.send?.({ kind: 'descendant', pid: descendant.pid });
  }
});
void claimCoordinatorLaunch().then((admitted) => {
  if (!admitted) return process.exit(1);
  process.send?.({ kind: 'ready' });
  setInterval(() => {}, 1000);
});
