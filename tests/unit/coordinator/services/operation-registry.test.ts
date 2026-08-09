import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderOperationEventIdentity } from '#src/jobs/provider-event.js';
import { LocalOperationRegistry, type OperationStopControl } from '#src/coordinator/services/operation-registry.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

type ExecutingRecord = Extract<ProviderOperationRecord, { phase: 'executing' }>;

function meta(overrides: Readonly<{ proxyInstanceId?: string }> = {}): ExecutingRecord {
  return providerOperationRecord('executing', {
    operation: {
      jobId: randomUUID(),
      operationId: randomUUID(),
      buildSetId: randomUUID(),
      proxyInstanceId: overrides.proxyInstanceId ?? randomUUID(),
    },
  }) as ExecutingRecord;
}

function identityFor(m: ExecutingRecord): ProviderOperationEventIdentity {
  return m.operation;
}

function cleanupFor(m: ExecutingRecord) {
  return { jobId: m.operation.jobId, pool: 'default' as const };
}

function registryWithCleanup(release = vi.fn()) {
  const registry = new LocalOperationRegistry();
  registry.connectCleanup({ release });
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
  it('activate() makes the entry visible as activated, keyed by job id', () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control } = fakeControl();

    registry.activate(m, control, cleanupFor(m));

    expect(registry.stateForJob(m.operation.jobId)).toBe('activated');
  });

  it('stateForJob() answers null for a job with no live entry', () => {
    const registry = new LocalOperationRegistry();
    expect(registry.stateForJob('never-registered')).toBeNull();
  });

  it('adopt() makes the entry visible as adopted, keyed by job id — W2.5’s second entry point onto the same builder', () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control } = fakeControl();

    registry.adopt(m, control, cleanupFor(m));

    expect(registry.stateForJob(m.operation.jobId)).toBe('adopted');
    expect(registry.operationsFor(m.operation.proxyInstanceId)).toEqual([identityFor(m)]);
  });

  it('adopt() releases reconstructed local state exactly once on settlement, like activate()', () => {
    const { registry, release } = registryWithCleanup();
    const m = meta();
    const { control } = fakeControl();
    registry.adopt(m, control, cleanupFor(m));
    registry.settled(identityFor(m));

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(cleanupFor(m));
    expect(registry.stateForJob(m.operation.jobId)).toBeNull();
  });

  it('adopt() wires stop() through the same control capability as activate()', async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control, stopCalls } = fakeControl();
    registry.adopt(m, control, cleanupFor(m));

    registry.stop(m.operation.jobId, 'signal_abort');
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toEqual(['signal_abort']);
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

  it('settled() on an identity this registry never activated is a silent no-op', () => {
    const registry = new LocalOperationRegistry();
    // A real, unrelated entry in the registry — proves the unknown identity is genuinely ignored rather than
    // merely confirming an empty registry does nothing.
    const activated = meta();
    const release = vi.fn();
    registry.connectCleanup({ release });
    registry.activate(activated, fakeControl().control, cleanupFor(activated));

    expect(() =>
      registry.settled({ jobId: 'unknown', operationId: 'unknown', proxyInstanceId: 'p', buildSetId: 'b' }),
    ).not.toThrow();

    expect(release).not.toHaveBeenCalled();
    expect(registry.stateForJob(activated.operation.jobId)).toBe('activated');
    expect(registry.stateForJob('unknown')).toBeNull();
  });

  it("stop() records the cause and sends it through the entry's control capability", async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control, stopCalls } = fakeControl();
    registry.activate(m, control, cleanupFor(m));

    registry.stop(m.operation.jobId, 'signal_abort');
    // `stop()` is fire-and-forget from the caller's side; give the queued microtask a turn.
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toEqual(['signal_abort']);
    expect(registry.recordedStopCauseFor(identityFor(m))).toBe('signal_abort');
  });

  it('stop() on a job with no live entry is a safe no-op', async () => {
    const registry = new LocalOperationRegistry();
    // A real, unrelated entry — proves the no-op does not reach some other live operation's control
    // capability rather than merely confirming an empty registry does nothing.
    const activated = meta();
    const { control, stopCalls } = fakeControl();
    registry.activate(activated, control, cleanupFor(activated));

    expect(() => registry.stop('never-registered', 'signal_abort')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toEqual([]);
    expect(registry.recordedStopCauseFor(identityFor(activated))).toBeNull();
    expect(registry.stateForJob('never-registered')).toBeNull();
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

  it('recordedStopCauseFor() answers null for an operation that was never stopped', () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    registry.activate(m, fakeControl().control, cleanupFor(m));

    expect(registry.recordedStopCauseFor(identityFor(m))).toBeNull();
  });

  it('stop() tolerates a control capability that rejects, rather than throwing into the caller', async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const control: OperationStopControl = { stop: async () => Promise.reject(new Error('rpc failed')) };
    registry.activate(m, control, cleanupFor(m));

    expect(() => registry.stop(m.operation.jobId, 'signal_abort')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // The cause is still recorded even though the send failed — the entry's own record of intent does not
    // depend on the RPC's outcome.
    expect(registry.recordedStopCauseFor(identityFor(m))).toBe('signal_abort');
  });

  describe('operationsFor()', () => {
    it('reports only the entries activated against the named proxy set', () => {
      const registry = new LocalOperationRegistry();
      const proxyInstanceId = randomUUID();
      const onSet = meta({ proxyInstanceId });
      const offSet = meta();
      registry.activate(onSet, fakeControl().control, cleanupFor(onSet));
      registry.activate(offSet, fakeControl().control, cleanupFor(offSet));

      expect(registry.operationsFor(proxyInstanceId)).toEqual([identityFor(onSet)]);
    });

    it('answers empty for a proxy set with no activated operations', () => {
      const registry = new LocalOperationRegistry();
      expect(registry.operationsFor('never-activated')).toEqual([]);
    });

    it('drops a settled entry — a fixed snapshot never reports an operation this coordinator already let go', () => {
      const registry = new LocalOperationRegistry();
      const proxyInstanceId = randomUUID();
      const m = meta({ proxyInstanceId });
      registry.activate(m, fakeControl().control, cleanupFor(m));
      registry.settled(identityFor(m));

      expect(registry.operationsFor(proxyInstanceId)).toEqual([]);
    });

    it('reports every operation this coordinator holds against a proxy carrying more than one', () => {
      const registry = new LocalOperationRegistry();
      const proxyInstanceId = randomUUID();
      const first = meta({ proxyInstanceId });
      const second = meta({ proxyInstanceId });
      registry.activate(first, fakeControl().control, cleanupFor(first));
      registry.activate(second, fakeControl().control, cleanupFor(second));

      const found = registry.operationsFor(proxyInstanceId);
      expect(found).toHaveLength(2);
      expect(found).toEqual(expect.arrayContaining([identityFor(first), identityFor(second)]));
    });
  });
});
