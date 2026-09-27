import { runBackendMain } from '#src/coordinator/bootstrap.js';
import { claimCoordinatorLaunch } from '#src/infra/coordinator-admission.js';

declare const __PLUGIN_ROOT__: string;

void claimCoordinatorLaunch().then((admitted) => {
  if (!admitted) {
    process.exitCode = 1;
    return;
  }
  const fail = process.env.CORAL_FIXTURE_FAIL_INSTALLED_ROOTS?.split(':').includes(__PLUGIN_ROOT__);
  const failAfterMs = Number(process.env.CORAL_FIXTURE_FAIL_AFTER_MS);
  if (fail) {
    if (!Number.isSafeInteger(failAfterMs) || failAfterMs <= 0) {
      process.exitCode = 1;
      return;
    }
    process.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-challenge' &&
        'id' in message
      )
        process.send?.({ kind: 'coral-sentinel-answer', id: message.id });
    });
    setTimeout(() => process.exit(1), failAfterMs);
    return;
  }
  runBackendMain({
    afterReady: () => {
      process.on('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'kind' in message &&
          message.kind === 'freeze-coordinator'
        )
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    },
  });
});
