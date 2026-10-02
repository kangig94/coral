import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderOperationEventIdentity } from '#src/jobs/provider-event.js';
import { LocalOperationRegistry, type OperationStopControl } from '#src/coordinator/services/operation-registry.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

type ExecutingRecord = Extract<ProviderOperationRecord, { phase: 'executing' }>;

function meta(
  overrides: Readonly<{ jobId?: string; operationId?: string; proxyInstanceId?: string }> = {},
): ExecutingRecord {
  return providerOperationRecord('executing', {
    operation: {
      jobId: overrides.jobId ?? randomUUID(),
      operationId: overrides.operationId ?? randomUUID(),
      buildSetId: randomUUID(),
      proxyInstanceId: overrides.proxyInstanceId ?? randomUUID(),
    },
  }) as ExecutingRecord;
}

function identityFor(m: ExecutingRecord): ProviderOperationEventIdentity {
  return m.operation;
}

function cleanupFor(m: ExecutingRecord) {
  return { kind: 'job-local' as const, jobId: m.operation.jobId, pool: 'default' as const };
}

function proxyCleanupFor(m: ExecutingRecord) {
  return {
    kind: 'proxy-binding' as const,
    jobId: m.operation.jobId,
    operationId: m.operation.operationId,
    pool: 'default' as const,
  };
}

function registryWithCleanup(release = vi.fn()) {
  const registry = new LocalOperationRegistry();
  registry.connectCleanup({ release });
  registry.connectBinding({ settleProviderOperationBinding: () => ({ kind: 'settled-unbound' }) } as never);
  return { registry, release };
}

function fakeControl(): { control: OperationStopControl; stopCalls: string[] } {
  const stopCalls: string[] = [];
  return {
    control: {
      stop: async (cause) => {
        stopCalls.push(cause);
      },
    },
    stopCalls,
  };
}

describe('LocalOperationRegistry', () => {
  it('attach() releases reconstructed local state exactly once on settlement, like activate()', () => {
    const { registry, release } = registryWithCleanup();
    const m = meta();
    const { control } = fakeControl();
    registry.attach(m, control, cleanupFor(m));
    registry.settled(identityFor(m));

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(proxyCleanupFor(m));
    expect(registry.stateForJob(m.operation.jobId)).toBeNull();
  });

  it('settled() releases identity-addressed local state exactly once and forgets the entry', () => {
    const { registry, release } = registryWithCleanup();
    const m = meta();
    const { control } = fakeControl();
    registry.activate(m, control, cleanupFor(m));
    registry.settled(identityFor(m));

    expect(release).toHaveBeenCalledTimes(1);
    expect(registry.stateForJob(m.operation.jobId)).toBeNull();

    // Idempotent: a second settlement of the same identity (a replayed terminal) does not run release again
    // or throw.
    registry.settled(identityFor(m));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains identity-addressed local state when binding settlement is refused', () => {
    const registry = new LocalOperationRegistry();
    registry.connectCleanup({ release: vi.fn() });
    registry.connectBinding({
      settleProviderOperationBinding: () => ({ kind: 'refused', reason: 'mailbox full' }),
    } as never);
    const m = meta();
    registry.activate(m, fakeControl().control, cleanupFor(m));

    registry.settled(identityFor(m));

    expect(registry.stateForJob(m.operation.jobId)).toBe('activated');
    expect(registry.operationsFor(m.operation.proxyInstanceId)).toEqual([identityFor(m)]);
  });

  it('does not release a reused job id when an older operation settles late', () => {
    const released: unknown[] = [];
    const { registry } = registryWithCleanup(
      vi.fn((identity: unknown) => {
        released.push(identity);
      }),
    );
    const jobId = randomUUID();
    const older = meta({ jobId, operationId: randomUUID() });
    const current = meta({ jobId, operationId: randomUUID() });
    registry.activate(older, fakeControl().control, cleanupFor(older));
    registry.activate(current, fakeControl().control, cleanupFor(current));

    registry.settled(identityFor(older));

    expect(released).toEqual([]);
    expect(registry.stateForJob(jobId)).toBe('activated');

    registry.settled(identityFor(current));
    expect(released).toEqual([proxyCleanupFor(current)]);
    expect(registry.stateForJob(jobId)).toBeNull();
  });

  it('stop() only sends the first recorded cause — a second abort of an already-stopping operation changes nothing', async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control, stopCalls } = fakeControl();
    registry.activate(m, control, cleanupFor(m));

    registry.stop(m.operation.jobId, 'signal_abort');
    registry.stop(m.operation.jobId, 'user_abort');
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toEqual(['signal_abort']);
    expect(registry.recordedStopCauseFor(identityFor(m))).toBe('signal_abort');
  });
});
