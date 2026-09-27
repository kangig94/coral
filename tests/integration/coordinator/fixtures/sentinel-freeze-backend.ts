import { runBackendMain } from '#src/coordinator/bootstrap.js';

declare const __PLUGIN_ROOT__: string;

if (process.env.CORAL_FIXTURE_FAIL_INSTALLED_ROOTS?.split(':').includes(__PLUGIN_ROOT__)) process.exit(1);

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
