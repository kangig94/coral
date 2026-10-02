import type { ProcessIncarnation } from '#src/infra/node-process.js';
import type { ProcessLiveness } from '#src/infra/node-process.js';
import { describe, expect, it } from 'vitest';
import { reapProviderOperationCarrier } from '#src/coordinator/services/recovery/interrupted-performer.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createDeferred } from '#tools/testing/deferred.js';

describe('interrupted provider-operation carrier reclamation', () => {
  it('preserves the saga and sends no KILL when recovery authority aborts after TERM', async () => {
    const record = providerOperationRecord('executing');
    if (record.phase !== 'executing') throw new Error('executing fixture did not retain its carrier');
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    insertProviderOperation(db, record);
    const controller = new AbortController();
    const live = new Map<number, ProcessIncarnation>([
      [-record.locator.containment.processGroupId, record.locator.containment.incarnation],
      [record.locator.containment.pid, record.locator.containment.incarnation],
      [record.providerRoot.pid, record.providerRoot.incarnation],
    ]);
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    let nowMs = 0n;
    const graceStarted = createDeferred<void>();
    const releaseGrace = createDeferred<void>();
    let sleepCount = 0;
    const clock = createMonotonicClock(Symbol('interrupted-carrier-cancellation'), {
      readMilliseconds: () => nowMs,
      sleep: async (milliseconds) => {
        sleepCount += 1;
        if (sleepCount === 1) {
          graceStarted.resolve();
          await releaseGrace.promise;
        }
        nowMs += BigInt(milliseconds);
      },
    });
    const observedProcess = {
      observeLiveness: (pid: number) => (live.has(pid) ? 'alive' : 'absent') as ProcessLiveness,
      observeRecordedProcessAsync: async (identity: { pid: number; incarnation: ProcessIncarnation }) => {
        const observed = live.get(identity.pid);
        return observed === undefined ? 'absent' : observed === identity.incarnation ? 'alive' : 'absent';
      },
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        signals.push({ pid, signal });
        if (signal === 'SIGKILL') live.clear();
        return true;
      },
    };

    try {
      const reclamation = reapProviderOperationCarrier(record, {
        db,
        clock,
        platform: 'linux',
        signal: controller.signal,
        process: observedProcess,
        readProcessIncarnation: (pid) => live.get(pid) ?? null,
      });
      await graceStarted.promise;
      expect(signals).toEqual([
        { pid: -record.locator.containment.processGroupId, signal: 'SIGTERM' },
        { pid: record.providerRoot.pid, signal: 'SIGTERM' },
      ]);
      const observedReclamation = reclamation.catch((error: unknown) => error);
      controller.abort(new Error('recovery authority expired during TERM grace'));
      releaseGrace.resolve();
      await expect(observedReclamation).resolves.toBeInstanceOf(Error);

      expect(signals).toEqual([
        { pid: -record.locator.containment.processGroupId, signal: 'SIGTERM' },
        { pid: record.providerRoot.pid, signal: 'SIGTERM' },
      ]);
      expect(signals.some(({ signal }) => signal === 'SIGKILL')).toBe(false);
      expect(readProviderOperation(db, record.operation)).toEqual(record);
    } finally {
      db.close();
    }
  });
});
