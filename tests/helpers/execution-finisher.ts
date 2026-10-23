import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import type { JobStore } from '#src/jobs/store.js';
import type { Runtime } from '#src/runtime/ports.js';

export function createTestExecutionFinisher(
  store: JobStore | (() => JobStore),
  runtime: Pick<Runtime, 'time'>,
): ExecutionFinisher {
  const currentStore = typeof store === 'function' ? store : () => store;
  return new ExecutionFinisher({
    time: runtime.time,
    recovery: {
      db: () => currentStore().getDb(),
      readCtx: {
        get schemas() {
          return currentStore().schemas;
        },
        get streamKinds() {
          return currentStore().streamKinds;
        },
        get bodyCodec() {
          return currentStore().bodyCodec;
        },
      },
      time: runtime.time,
    },
    commit: (write) => currentStore().commit(write),
    read: (address) => readExecutionFinishingState(currentStore().getDb(), address, currentStore()),
    quiesce: async () => true,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
}
