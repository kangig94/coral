declare const __IS_CORAL_BACKEND_MAIN__: boolean | undefined;

import { BackendAlreadyRunningError } from '../execution/backend-lock.js';
import { StartupInterruptedError } from '../execution/lifecycle.js';
import { handleSmokeOpenStore } from '../execution/smoke-open-store.js';
import { createCoordinatorServer } from './coordinator.js';
import { coordinatorLog } from './log.js';

export async function main(): Promise<number> {
  if (process.argv.includes('--smoke-open-store')) {
    return handleSmokeOpenStore(process.argv);
  }

  const coordinator = createCoordinatorServer({
    onStopped: () => {
      process.exit(0);
    },
    onFatalShutdownError: (error) => {
      coordinatorLog.error('Fatal shutdown error', error);
      process.exit(1);
    },
  });

  process.on('SIGTERM', () => {
    void coordinator.shutdown('sigterm').catch(() => {});
  });
  process.on('SIGINT', () => {
    void coordinator.shutdown('sigint').catch(() => {});
  });

  try {
    const info = await coordinator.start();
    coordinatorLog.info(`Running on ${info.host}:${info.port}`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof BackendAlreadyRunningError) {
      coordinatorLog.info(error.message);
      return 0;
    }
    if (error instanceof StartupInterruptedError) {
      return 0;
    }

    coordinatorLog.error('Fatal startup error', error);
    return 1;
  }
}

if (typeof __IS_CORAL_BACKEND_MAIN__ !== 'undefined' && __IS_CORAL_BACKEND_MAIN__) {
  void main()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((error: unknown) => {
      coordinatorLog.error('Fatal startup error', error);
      process.exit(1);
    });
}
