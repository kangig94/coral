import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderOperationEventIdentity } from '#src/jobs/provider-event.js';
import type { ProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta.js';
import { LocalOperationRegistry, type OperationStopControl } from '#src/coordinator/services/operation-registry.js';

function meta(overrides: Partial<ProviderOperationRuntimeMeta> = {}): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: randomUUID(),
    operationId: randomUUID(),
    buildSetId: randomUUID(),
    hostFingerprint: 'a'.repeat(64),
    guardianInstanceId: randomUUID(),
    guardianPid: 100,
    guardianProcessStartedAtSeconds: 1,
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: randomUUID(),
    proxyPid: 200,
    reaperInstanceId: randomUUID(),
    reaperPid: 300,
    reaperProcessStartedAtSeconds: 2,
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-group',
    proxyProcessStartedAtSeconds: 3,
    proxyProcessGroupId: 200,
    canonicalEndpoint: '/tmp/proxy.sock',
    reservationId: randomUUID(),
    activationNonce: randomUUID(),
    providerRootPid: 7_001,
    providerRootProcessStartedAtSeconds: 800,
    jointContainmentReceipt: 'joint-1',
    committedThroughProviderSeq: 0,
    ...overrides,
  };
}

function identityFor(m: ProviderOperationRuntimeMeta): ProviderOperationEventIdentity {
  return { jobId: m.jobId, operationId: m.operationId, proxyInstanceId: m.proxyInstanceId, buildSetId: m.buildSetId };
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

    registry.activate(m, control, () => {});

    expect(registry.stateForJob(m.jobId)).toBe('activated');
  });

  it('stateForJob() answers null for a job with no live entry', () => {
    const registry = new LocalOperationRegistry();
    expect(registry.stateForJob('never-registered')).toBeNull();
  });

  it('settled() runs release() exactly once and forgets the entry', () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control } = fakeControl();
    const release = vi.fn();

    registry.activate(m, control, release);
    registry.settled(identityFor(m));

    expect(release).toHaveBeenCalledTimes(1);
    expect(registry.stateForJob(m.jobId)).toBeNull();

    // Idempotent: a second settlement of the same identity (a replayed terminal) does not run release again
    // or throw.
    registry.settled(identityFor(m));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('settled() on an identity this registry never activated is a silent no-op', () => {
    const registry = new LocalOperationRegistry();
    expect(() =>
      registry.settled({ jobId: 'unknown', operationId: 'unknown', proxyInstanceId: 'p', buildSetId: 'b' }),
    ).not.toThrow();
  });

  it("stop() records the cause and sends it through the entry's control capability", async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control, stopCalls } = fakeControl();
    registry.activate(m, control, () => {});

    registry.stop(m.jobId, 'signal_abort');
    // `stop()` is fire-and-forget from the caller's side; give the queued microtask a turn.
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toEqual(['signal_abort']);
    expect(registry.recordedStopCauseFor(identityFor(m))).toBe('signal_abort');
  });

  it('stop() on a job with no live entry is a safe no-op', () => {
    const registry = new LocalOperationRegistry();
    expect(() => registry.stop('never-registered', 'signal_abort')).not.toThrow();
  });

  it('stop() only sends the first recorded cause — a second abort of an already-stopping operation changes nothing', async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const { control, stopCalls } = fakeControl();
    registry.activate(m, control, () => {});

    registry.stop(m.jobId, 'signal_abort');
    registry.stop(m.jobId, 'user_abort');
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls).toEqual(['signal_abort']);
    expect(registry.recordedStopCauseFor(identityFor(m))).toBe('signal_abort');
  });

  it('recordedStopCauseFor() answers null for an operation that was never stopped', () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    registry.activate(m, fakeControl().control, () => {});

    expect(registry.recordedStopCauseFor(identityFor(m))).toBeNull();
  });

  it('stop() tolerates a control capability that rejects, rather than throwing into the caller', async () => {
    const registry = new LocalOperationRegistry();
    const m = meta();
    const control: OperationStopControl = { stop: async () => Promise.reject(new Error('rpc failed')) };
    registry.activate(m, control, () => {});

    expect(() => registry.stop(m.jobId, 'signal_abort')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // The cause is still recorded even though the send failed — the entry's own record of intent does not
    // depend on the RPC's outcome.
    expect(registry.recordedStopCauseFor(identityFor(m))).toBe('signal_abort');
  });
});
