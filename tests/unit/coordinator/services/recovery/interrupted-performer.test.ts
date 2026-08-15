import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { describe, expect, it } from 'vitest';

import { reapProviderOperationCarrier } from '#src/coordinator/services/recovery/interrupted-performer.js';
import { RecoveryService } from '#src/coordinator/services/recovery/service.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { AppServerRuntime } from '#src/jobs/records.js';
import type { ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
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

    try {
      const reclamation = reapProviderOperationCarrier(record, {
        db,
        clock,
        platform: 'linux',
        signal: controller.signal,
        process: {
          isAlive: (pid) => live.has(pid),
          kill: (pid, signal) => {
            signals.push({ pid, signal });
            if (signal === 'SIGKILL') live.clear();
            return true;
          },
        },
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

  it('threads RecoveryService cancellation through TERM grace and leaves the saga', async () => {
    const fixture = providerOperationRecord('executing');
    if (fixture.phase !== 'executing') throw new Error('executing fixture did not retain its carrier');
    const baseRuntime = createRealRuntime('prod');
    const incarnation = baseRuntime.process.readProcessIncarnation(process.pid, 'linux');
    if (incarnation === null) throw new Error('test process identity was unavailable');
    const record = providerOperationRecordSchema.parse({
      ...fixture,
      locator: {
        ...fixture.locator,
        proxy: { ...fixture.locator.proxy, pid: process.pid, incarnation },
        containment: {
          ...fixture.locator.containment,
          pid: process.pid,
          processGroupId: process.pid,
          incarnation,
        },
      },
      providerRoot: { pid: process.pid, incarnation },
    });
    if (record.phase !== 'executing') throw new Error('service fixture did not retain its carrier');
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
    const runtime = {
      ...baseRuntime,
      process: {
        ...baseRuntime.process,
        isAlive: (pid: number) => live.has(pid),
        readProcessIncarnation: (pid: number) => live.get(pid) ?? null,
        kill: (pid: number, signal: NodeJS.Signals | 0) => {
          signals.push({ pid, signal });
          if (signal === 'SIGKILL') live.clear();
          return true;
        },
      },
    };
    const projectRoot = process.cwd();
    const status = {
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session', id: 'recovery-session' },
      sessionId: 'recovery-session',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'interrupted-carrier-test',
      jobKind: 'provider',
      phase: 'running',
      updatedAt: '2026-08-13T00:00:00.000Z',
    } as const;
    const authority = {
      launchRecord: {
        ...status,
        pool: 'default',
        enqueueSequence: 1,
        providerAction: 'exec',
        request: { prompt: '', cwd: projectRoot, bypassPermissions: false, coralEnv: {} },
        createdAt: status.updatedAt,
      },
      session: {
        sessionId: 'recovery-session',
        projectRoot,
        conversationRef: undefined,
        providerContinuity: { checkpoint: 'persisted' },
        artifactHandles: [],
        version: 1,
      },
      boundProvider: {
        name: 'codex',
        recovery: {
          finalizeInterrupted: () => ({ kind: 'clear_non_resumable' }),
          finalizeFromArtifacts: async () => ({}),
        },
        appServer: { supportsProbe: true },
      },
    } as unknown as ProviderRecoveryAuthority;
    const runtimeRecord: AppServerRuntime = {
      transport: 'app-server',
      startTime: status.updatedAt,
      providerMeta: { provider: 'codex', leaseState: 'acquired', hostRef: record.activationAck.hostRef },
    };
    const service = new RecoveryService({
      runtime,
      progressStore: {
        readStatus: () => status,
        getDb: () => db,
        jobDir: () => '/tmp/interrupted-carrier-test',
      } as never,
      sessionManager: {} as never,
      abortRegistry: {} as never,
      backendNamespace: 'interrupted-carrier-test',
      bundleHash: 'test-bundle',
      launchAdmission: {} as never,
      launchRecovery: {} as never,
      providerRegistry: {} as never,
      jobPools: new Map(),
      launchOrchestrator: {} as never,
      childPrincipalRegistry: {} as never,
      parentPrincipal: {} as never,
    });

    try {
      const finalization = service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
        reason: 'restart',
        signal: controller.signal,
        onCommitStart: () => undefined,
      });
      expect(signals).toEqual([
        { pid: -record.locator.containment.processGroupId, signal: 'SIGTERM' },
        { pid: record.providerRoot.pid, signal: 'SIGTERM' },
      ]);
      const observedFinalization = finalization.catch((error: unknown) => error);
      controller.abort(new Error('recovery service authority expired during TERM grace'));
      await expect(observedFinalization).resolves.toBeInstanceOf(Error);

      expect(signals.some(({ signal }) => signal === 'SIGKILL')).toBe(false);
      expect(readProviderOperation(db, record.operation)).toEqual(record);
    } finally {
      db.close();
    }
  });
});
