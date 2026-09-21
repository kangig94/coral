import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { ProviderOperationBindingPort } from '#src/jobs/contracts/provider-operation-lifecycle.js';
import {
  ProviderOperationReconciler,
  type ProviderOperationReconcilerFatalError,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, applyJournalPragmas } from '#src/store/db.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import {
  ProviderOperationAtomicTerminalizationError,
  type ProviderOperationTerminalizationPort,
} from '#src/jobs/provider-operation-terminalization.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

import { providerOperationRecord } from '../../unit/store/provider-operation-fixtures.js';

describe('provider operation release accounting under WAL contention', () => {
  it.each([
    ['disappearance', 'disappearance_consumer_unavailable'],
    ['abandonment', 'representation_abandonment_consumer_unavailable'],
  ] as const)('keeps a locked %s bookkeeping surface out of the fatal dispatcher', async (kind, code) => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-provider-operation-release-lock-'));
    const databasePath = join(directory, 'journal.sqlite');
    const db = newRawDatabase(databasePath);
    let locker: ReturnType<typeof newRawDatabase> | null = null;
    let lockHeld = false;

    try {
      applyJournalPragmas(db, { kind: 'writable', busyTimeoutMs: 0 });
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const recovered = providerOperationRecord('executing');
      insertProviderOperation(db, recovered);

      const innerFatalErrors: unknown[] = [];
      const outerFatalErrors: unknown[] = [];
      const sinkFatalErrors: unknown[] = [];
      const reconcilerFatalErrors: ProviderOperationReconcilerFatalError[] = [];
      const terminalization = {
        terminalize: (record, _directive) => {
          throw new ProviderOperationAtomicTerminalizationError(
            record.operation,
            Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
          );
        },
      } satisfies ProviderOperationTerminalizationPort;
      const innerDispatcher = createTestProviderProxyRecoveryDispatcher(
        {
          'disappearance-terminalization': ({ record, directive }) => terminalization.terminalize(record, directive),
        },
        (error) => innerFatalErrors.push(error),
      );
      const unused = (): never => {
        throw new Error('unexpected provider-operation release dependency');
      };
      const progressStore = {
        getDb: () => db,
        commit: unused,
        readStatus: unused,
        readLaunchProjection: unused,
      } as Pick<JobProgressStore, 'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'>;
      const binding = {
        prepareProviderOperationBinding: unused,
        cancelProviderOperationBinding: unused,
        commitProviderOperationBinding: unused,
        settleProviderOperationBinding: () => ({ kind: 'already-settled' }),
        retireProviderOperationBinding: () => ({ kind: 'nothing-to-retire' }),
      } satisfies ProviderOperationBindingPort;
      const reconciler = new ProviderOperationReconciler({
        getProgressStore: () => progressStore,
        authorityFor: () => null,
        startupSetRecovery: { recoverSetAtStartup: async () => unused() },
        registry: { activate: unused, attach: unused, settled: unused, stop: unused },
        binding,
        releaseStartupOwnership: () => ({ kind: 'not-owned' }),
        materializePrepare: unused,
        recoverLocalJob: async () => unused(),
        completeLocalRecovery: unused,
        terminalization,
        recoveryDispatcher: innerDispatcher,
        backendNamespace: 'provider-operation-release-accounting-integration',
        time: {
          now: () => 100,
          setTimeout: () => ({ unref: () => undefined }),
          clearTimeout: () => undefined,
        },
        onFatal: (error) => reconcilerFatalErrors.push(error),
      });
      const outerDispatcher = createTestProviderProxyRecoveryDispatcher(
        {
          'disappearance-consumer': ({ notice }) => reconciler.containmentDisappeared(notice),
          'representation-abandonment-consumer': ({ notice }) => reconciler.representationAbandoned(notice),
        },
        (error) => outerFatalErrors.push(error),
      );
      const setIdentity = providerProxySetIdentityFromRecord(recovered);

      locker = newRawDatabase(databasePath);
      applyJournalPragmas(locker, { kind: 'writable', busyTimeoutMs: 0 });
      locker.exec('BEGIN IMMEDIATE');
      lockHeld = true;

      const retryIncidents: unknown[] = [];
      const disposition = await new Promise<'retry' | 'fatal' | 'evidence'>((resolve) => {
        const sinks = {
          evidence: () => resolve('evidence' as const),
          retry: (retry: { incident: unknown }) => {
            retryIncidents.push(retry.incident);
            resolve('retry');
          },
          fatal: (error: unknown) => {
            sinkFatalErrors.push(error);
            resolve('fatal');
          },
        };
        if (kind === 'disappearance') {
          const turn = outerDispatcher.begin(
            'disappearance-delivery',
            { operation: recovered.operation, setIdentity },
            sinks,
          );
          turn.start({
            sourceId: 'delivery',
            producerId: 'disappearance-consumer',
            input: {
              notice: {
                operation: recovered.operation,
                setIdentity,
                disappearanceReceipt: 'locked-bookkeeping-receipt',
              },
            },
          });
        } else {
          const turn = outerDispatcher.begin(
            'representation-abandonment-delivery',
            { operation: recovered.operation, setIdentity },
            sinks,
          );
          turn.start({
            sourceId: 'delivery',
            producerId: 'representation-abandonment-consumer',
            input: { notice: { operation: recovered.operation, setIdentity } },
          });
        }
      });

      expect({
        disposition,
        innerFatalCount: innerFatalErrors.length,
        outerFatalCount: outerFatalErrors.length,
        sinkFatalCount: sinkFatalErrors.length,
        reconcilerFatalCount: reconcilerFatalErrors.length,
        retryIncidents,
        record: readProviderOperation(db, recovered.operation),
      }).toEqual({
        disposition: 'retry',
        innerFatalCount: 0,
        outerFatalCount: 0,
        sinkFatalCount: 0,
        reconcilerFatalCount: 0,
        retryIncidents: [expect.objectContaining({ code })],
        record: recovered,
      });
    } finally {
      if (lockHeld) locker?.exec('ROLLBACK');
      locker?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
