import { spawn } from 'node:child_process';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { createSharedFileLockSync, attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';

if (process.argv[2] === 'parent') {
  let releaseNamespace: (() => void) | undefined;
  const child = spawn(process.execPath, [process.argv[1]], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.on('message', (value: unknown) => process.send?.({ ...(value as object), childPid: child.pid }));
  process.on('message', (value: unknown) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      value.kind === 'coral-launch-admit' &&
      'runDir' in value &&
      typeof value.runDir === 'string'
    ) {
      const path = supervisorLockPath(value.runDir);
      createSharedFileLockSync(path)();
      const acquired = attemptExclusiveFileLockSync(path);
      if (acquired.kind !== 'acquired') throw new Error('Missing supervisor lease');
      releaseNamespace = acquired.lease;
      child.send({ ...value, parent: { pid: process.pid, incarnation: probeProcessIncarnation(process.pid) } });
    } else child.send(value as Parameters<typeof child.send>[0]);
  });
  child.once('exit', () => {
    releaseNamespace?.();
    process.exit(0);
  });
} else {
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
}
