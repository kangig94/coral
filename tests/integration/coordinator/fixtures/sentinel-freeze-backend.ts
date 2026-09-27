import { runBackendMain } from '#src/coordinator/bootstrap.js';

runBackendMain({
  afterReady: () => {
    process.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'freeze-coordinator'
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    });
  },
});
