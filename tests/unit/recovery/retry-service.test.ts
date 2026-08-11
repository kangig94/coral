import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineRecoverySource, type RecoveryDisposition, type RecoverySubject } from '#src/recovery/containment.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { coordinatorJobRecoverySource } from '#src/coordinator/services/recovery/coordinator-job-source.js';
import { crashedJobTerminalizationSource } from '#src/jobs/crashed-job-terminalization-recovery-source.js';
import { staleJobCleanupSource } from '#src/jobs/stale-job-cleanup-recovery-source.js';
import { discussionCandidateRecoverySource } from '#src/discuss/shell/discussion-candidate-recovery-source.js';
import { discussionSourceRecoverySource } from '#src/discuss/shell/discussion-source-recovery-source.js';
import { retentionReleasePairComponentSource } from '#src/sessions/retention-release-pair-recovery-source.js';
import { retentionWorkItemRecoverySource } from '#src/sessions/retention-work-item-recovery-source.js';
import { sessionContinuationLeaseRecoverySource } from '#src/sessions/continuation-lease-recovery-source.js';
import { sessionProjectionRecoverySource } from '#src/sessions/projection-recovery-source.js';
import { terminalRetentionOutcomeRecoverySource } from '#src/sessions/terminal-retention-outcome-recovery-source.js';
import { workflowRecoverySource } from '#src/workflow/recovery-source.js';
import {
  assertRecoverySourceRegistryComplete,
  createRecoveryQuarantineRetryService,
  createRecoverySourceRegistry,
  repeatableRecoveryBoundaryIds,
  type RecoveryQuarantineRetryService,
  type RecoveryRetryQuarantinePort,
  type RecoveryRetryPolicy,
  type RecoverySourceRegistry,
} from '#src/recovery/source-registry.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import type { RecoveryQuarantineRequestPort } from '#src/transport/rpc/ports.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

type Envelope = {
  readonly subject: RecoverySubject;
  readonly value: string;
};

type RetryBehavior = {
  readonly readEnvelope: () => Envelope | null;
  readonly settle: (item: string) => RecoveryDisposition | Promise<RecoveryDisposition>;
  readonly hydrate?: RecoveryRetryPolicy<Envelope, string>['hydrate'];
  readonly onFault?: RecoveryRetryPolicy<Envelope, string>['onFault'];
};

const boundary = 'stale-job-cleanup' as const;
const TEST_TIME = { now: () => Date.parse('2026-08-03T00:00:00.000Z') };

function subject(revision = 'revision-1'): RecoverySubject {
  return {
    key: 'subject-1',
    revision: { kind: 'fingerprint', value: revision },
  };
}

function advanced(detail = 'settled by retry'): RecoveryDisposition {
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts: [],
    detail,
  };
}

function passThroughPolicy<Raw>(): RecoveryRetryPolicy<Raw, Raw> {
  return {
    processLocalCleanup: { kind: 'not-required' },
    hydrate: (raw) => raw,
    requiredObligations: () => [],
    settle: () => advanced(),
    onFault: (fault) => ({ kind: 'quarantine', detail: `retry ${fault.stage} failed` }),
  };
}

function activeWrite(retrySubject: RecoverySubject = subject()) {
  return {
    boundary,
    subject: retrySubject,
    state: 'active' as const,
    stage: 'settle' as const,
    errorMessage: 'retained failure',
    detail: 'operator retry required',
  };
}

function createRegistry(behavior: RetryBehavior): RecoverySourceRegistry {
  const registry = createRecoverySourceRegistry();
  registry.register<Envelope, string>(boundary, (retrySubject) => ({
    source: defineRecoverySource({
      boundary,
      scanSubject: retrySubject,
      scan: () => {
        const envelope = behavior.readEnvelope();
        return envelope === null || envelope.subject.key !== retrySubject.key ? [] : [envelope];
      },
      subject: (envelope) => envelope.subject,
    }),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: behavior.hydrate ?? ((envelope) => envelope.value),
      requiredObligations: () => [],
      settle: behavior.settle,
      onFault:
        behavior.onFault ??
        ((fault) => ({
          kind: 'quarantine',
          detail: `retry ${fault.stage} failed`,
        })),
    },
  }));
  return registry;
}

function createIds(...tokens: string[]): { readonly uuid: ReturnType<typeof vi.fn<() => string>> } {
  let next = 0;
  return {
    uuid: vi.fn(() => tokens[next++] ?? `token-${next}`),
  };
}

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('recovery quarantine retry service', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;
  let envelope: Envelope | null;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    quarantine = new RecoveryQuarantineStore(db, TEST_TIME);
    envelope = { subject: subject(), value: 'decoded' };
    expect(quarantine.upsert(activeWrite())).toBe(true);
  });

  afterEach(() => {
    db.close();
  });

  function service(
    instanceId: string,
    registry: RecoverySourceRegistry,
    ids = createIds('retry-token'),
  ): RecoveryQuarantineRetryService {
    return createRecoveryQuarantineRetryService({
      instanceId,
      ids,
      quarantine,
      sources: registry,
    });
  }

  const request = {
    boundary,
    key: 'subject-1',
    revision: 'revision-1',
  } as const;

  it('should keep the runtime registry equal to every manifest boundary', () => {
    expect(repeatableRecoveryBoundaryIds).toEqual([
      'coordinator-job-recovery',
      'discussion-source',
      'discussion-candidate',
      'session-projection',
      'session-continuation-lease',
      'terminal-retention-outcome',
      'retention-release-pair',
      'session-retention-work',
      'workflow-recovery',
      'stale-job-cleanup',
      'crashed-job-terminalization',
    ]);
    const registeredSourceBoundaries = [
      coordinatorJobRecoverySource(db).boundary,
      discussionSourceRecoverySource(db).boundary,
      discussionCandidateRecoverySource(db).boundary,
      sessionProjectionRecoverySource(db).boundary,
      sessionContinuationLeaseRecoverySource(db).boundary,
      terminalRetentionOutcomeRecoverySource(db).boundary,
      retentionReleasePairComponentSource(db).boundary,
      retentionWorkItemRecoverySource([]).boundary,
      workflowRecoverySource(db).boundary,
      staleJobCleanupSource(db).boundary,
      crashedJobTerminalizationSource(db).boundary,
    ];

    expect(new Set(registeredSourceBoundaries)).toEqual(new Set(repeatableRecoveryBoundaryIds));
    expect(registeredSourceBoundaries).toHaveLength(repeatableRecoveryBoundaryIds.length);

    const runtimeRegistry = createRecoverySourceRegistry();
    runtimeRegistry.register('coordinator-job-recovery', (retrySubject) => ({
      source: coordinatorJobRecoverySource(db, { subject: retrySubject }),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('discussion-source', (retrySubject) => ({
      source: discussionSourceRecoverySource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('discussion-candidate', (retrySubject) => ({
      source: discussionCandidateRecoverySource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('session-projection', (retrySubject) => ({
      source: sessionProjectionRecoverySource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('session-continuation-lease', (retrySubject) => ({
      source: sessionContinuationLeaseRecoverySource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('terminal-retention-outcome', (retrySubject) => ({
      source: terminalRetentionOutcomeRecoverySource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('retention-release-pair', (retrySubject) => ({
      source: retentionReleasePairComponentSource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('session-retention-work', (retrySubject) => ({
      source: retentionWorkItemRecoverySource([], retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('workflow-recovery', (retrySubject) => ({
      source: workflowRecoverySource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('stale-job-cleanup', (retrySubject) => ({
      source: staleJobCleanupSource(db, retrySubject),
      policy: passThroughPolicy(),
    }));
    runtimeRegistry.register('crashed-job-terminalization', (retrySubject) => ({
      source: crashedJobTerminalizationSource(db, retrySubject),
      policy: passThroughPolicy(),
    }));

    expect(() => assertRecoverySourceRegistryComplete(runtimeRegistry)).not.toThrow();
    expect(runtimeRegistry.boundaries()).toEqual(repeatableRecoveryBoundaryIds);
  });

  it('should delete the retained row after successful settlement', async () => {
    const ids = createIds('fresh-token');
    const settle = vi.fn(() => {
      expect(quarantine.read(boundary, request.key)).toMatchObject({
        state: 'retrying',
        retry: { owner: 'coordinator-1', token: 'fresh-token' },
      });
      return advanced();
    });
    const control: RecoveryQuarantineRequestPort = service(
      'coordinator-1',
      createRegistry({ readEnvelope: () => envelope, settle }),
      ids,
    );
    const result = await control.clear(request);

    expect(result).toEqual({ ...request, disposition: 'advanced' });
    expect(ids.uuid).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(quarantine.read(boundary, request.key)).toBeNull();
  });

  it('should retain retry ownership when deletion crashes after settlement', async () => {
    const crash = new Error('process stopped before retry deletion');
    const crashBeforeDelete: RecoveryRetryQuarantinePort = {
      read: quarantine.read.bind(quarantine),
      upsert: quarantine.upsert.bind(quarantine),
      delete: () => {
        throw crash;
      },
      claimRetry: quarantine.claimRetry.bind(quarantine),
      reclaimRetry: quarantine.reclaimRetry.bind(quarantine),
    };
    const retry = createRecoveryQuarantineRetryService({
      instanceId: 'coordinator-1',
      ids: createIds('settled-token'),
      quarantine: crashBeforeDelete,
      sources: createRegistry({ readEnvelope: () => envelope, settle: () => advanced() }),
    });

    await expect(retry.clear(request)).rejects.toBe(crash);
    expect(quarantine.read(boundary, request.key)).toEqual({
      boundary,
      subject: subject(),
      state: 'retrying',
      retry: { owner: 'coordinator-1', token: 'settled-token' },
    });
  });

  it('should return a failed settlement to active through the owner-token CAS', async () => {
    const failure = new Error('settlement failed');
    const result = await service(
      'coordinator-1',
      createRegistry({
        readEnvelope: () => envelope,
        settle: () => {
          throw failure;
        },
      }),
    ).clear(request);

    expect(result.disposition).toBe('quarantined');
    expect(quarantine.read(boundary, request.key)).toEqual({
      boundary,
      subject: subject(),
      state: 'active',
    });
    expect(quarantine.list()[0]).toMatchObject({
      state: 'active',
      retry: null,
      errorMessage: failure.message,
    });
  });

  it('should leave a partial settlement as a durable continuation', async () => {
    const result = await service(
      'coordinator-1',
      createRegistry({
        readEnvelope: () => envelope,
        settle: () => ({
          kind: 'deferred',
          continuation: { kind: 'settlement.v1', key: 'continuation-1' },
          detail: 'settlement remains partial',
        }),
      }),
    ).clear(request);

    expect(result.disposition).toBe('continuation');
    expect(quarantine.list()[0]).toMatchObject({
      state: 'continuation',
      retry: null,
      continuation: { kind: 'settlement.v1', key: 'continuation-1' },
    });
  });

  it('should leave the claimed row visible when retry execution crashes', async () => {
    const crash = new Error('coordinator crashed');
    const ids = createIds('crash-token');
    const retry = service(
      'coordinator-1',
      createRegistry({
        readEnvelope: () => envelope,
        settle: () => {
          throw crash;
        },
        onFault: () => ({ kind: 'fatal', error: crash }),
      }),
      ids,
    );

    await expect(retry.clear(request)).rejects.toBe(crash);
    expect(quarantine.read(boundary, request.key)).toEqual({
      boundary,
      subject: subject(),
      state: 'retrying',
      retry: { owner: 'coordinator-1', token: 'crash-token' },
    });
  });

  it('should allow exactly one concurrent clear to own the row', async () => {
    const settlement = deferred();
    const settle = vi.fn(async () => {
      await settlement.promise;
      return advanced();
    });
    const retry = service(
      'coordinator-1',
      createRegistry({ readEnvelope: () => envelope, settle }),
      createIds('winning-token', 'losing-token'),
    );

    const winner = retry.clear(request);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    await expect(retry.clear(request)).rejects.toMatchObject({ code: 'retry-in-progress' });
    expect(settle).toHaveBeenCalledOnce();

    settlement.release();
    await expect(winner).resolves.toMatchObject({ disposition: 'advanced' });
  });

  it('should let a new canonical coordinator reclaim the exact abandoned owner and token', async () => {
    expect(
      quarantine.claimRetry({
        boundary,
        subject: subject(),
        retry: { owner: 'coordinator-1', token: 'old-token' },
      }),
    ).toBe(true);
    const settlement = deferred();
    const settle = vi.fn(async () => {
      await settlement.promise;
      return advanced();
    });
    const restarted = service(
      'coordinator-2',
      createRegistry({ readEnvelope: () => envelope, settle }),
      createIds('new-token'),
    );

    const result = restarted.clear(request);
    await vi.waitFor(() =>
      expect(quarantine.read(boundary, request.key)).toMatchObject({
        state: 'retrying',
        retry: { owner: 'coordinator-2', token: 'new-token' },
      }),
    );

    settlement.release();
    await expect(result).resolves.toMatchObject({ disposition: 'advanced' });
  });

  it('should prevent a stale completion from deleting the new owner row', async () => {
    const oldSettlement = deferred();
    const oldSettle = vi.fn(async () => {
      await oldSettlement.promise;
      return advanced('old owner completed late');
    });
    const oldRetry = service(
      'coordinator-1',
      createRegistry({
        readEnvelope: () => envelope,
        settle: oldSettle,
      }),
      createIds('old-token'),
    );
    const oldResult = oldRetry.clear(request);
    await vi.waitFor(() => expect(oldSettle).toHaveBeenCalledOnce());

    const newSettlement = deferred();
    const newSettle = vi.fn(async () => {
      await newSettlement.promise;
      return advanced('new owner completed');
    });
    const newResult = service(
      'coordinator-2',
      createRegistry({ readEnvelope: () => envelope, settle: newSettle }),
      createIds('new-token'),
    ).clear(request);
    await vi.waitFor(() => expect(newSettle).toHaveBeenCalledOnce());

    oldSettlement.release();
    await expect(oldResult).rejects.toThrow('Recovery retry completion lost authority');
    expect(quarantine.read(boundary, request.key)).toMatchObject({
      state: 'retrying',
      retry: { owner: 'coordinator-2', token: 'new-token' },
    });

    newSettlement.release();
    await expect(newResult).resolves.toMatchObject({ disposition: 'advanced' });
  });

  it('should prevent a stale failure from re-quarantining the new owner row', async () => {
    const oldSettlement = deferred();
    const staleFailure = new Error('old owner failed late');
    const oldSettle = vi.fn(async () => {
      await oldSettlement.promise;
      throw staleFailure;
    });
    const oldResult = service(
      'coordinator-1',
      createRegistry({
        readEnvelope: () => envelope,
        settle: oldSettle,
      }),
      createIds('old-token'),
    ).clear(request);
    await vi.waitFor(() => expect(oldSettle).toHaveBeenCalledOnce());

    const newSettlement = deferred();
    const newSettle = vi.fn(async () => {
      await newSettlement.promise;
      return advanced();
    });
    const newResult = service(
      'coordinator-2',
      createRegistry({ readEnvelope: () => envelope, settle: newSettle }),
      createIds('new-token'),
    ).clear(request);
    await vi.waitFor(() => expect(newSettle).toHaveBeenCalledOnce());

    oldSettlement.release();
    await expect(oldResult).rejects.toThrow('Recovery quarantine write lost authority');
    expect(quarantine.read(boundary, request.key)).toMatchObject({
      state: 'retrying',
      retry: { owner: 'coordinator-2', token: 'new-token' },
    });

    newSettlement.release();
    await expect(newResult).resolves.toMatchObject({ disposition: 'advanced' });
  });

  it('should remove an absent subject through the typed one-shot boundary path', async () => {
    envelope = null;
    const hydrate = vi.fn<(raw: Envelope) => string>();
    const settle = vi.fn(() => advanced());
    const result = await service(
      'coordinator-1',
      createRegistry({ readEnvelope: () => envelope, hydrate, settle }),
    ).clear(request);

    expect(result.disposition).toBe('advanced');
    expect(hydrate).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(quarantine.read(boundary, request.key)).toBeNull();
  });
});
