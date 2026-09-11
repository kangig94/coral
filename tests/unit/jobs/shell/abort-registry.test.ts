import { describe, expect, it } from 'vitest';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createRealRuntime } from '#src/runtime/real.js';

const runtime = createRealRuntime('prod');

describe('jobs AbortRegistry', () => {
  it('register returns a UUID', () => {
    const registry = new AbortRegistry(runtime.ids);
    const jobId = registry.register();
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('has returns true while registered, false after remove', () => {
    const registry = new AbortRegistry(runtime.ids);
    const jobId = registry.register();
    expect(registry.has(jobId)).toBe(true);
    expect(registry.listActive()).toEqual([jobId]);
    registry.remove(jobId);
    expect(registry.has(jobId)).toBe(false);
    expect(registry.listActive()).toEqual([]);
  });

  it('abort aborts the correct jobs and reports notFound correctly', () => {
    const registry = new AbortRegistry(runtime.ids);
    const firstJobId = registry.register();
    const secondJobId = registry.register();

    const result = registry.abort([firstJobId, 'missing-job']);

    expect(result).toEqual({
      aborted: [firstJobId],
      notFound: ['missing-job'],
    });
    expect(registry.getSignal(firstJobId)?.aborted).toBe(true);
    expect(registry.getSignal(secondJobId)?.aborted).toBe(false);
    expect(registry.listActive()).toEqual([firstJobId, secondJobId]);
  });

  it('register with onAbort fires callback when job is aborted', () => {
    const registry = new AbortRegistry(runtime.ids);
    let called = false;
    const jobId = registry.register(undefined, () => {
      called = true;
    });

    expect(called).toBe(false);
    registry.abort([jobId]);
    expect(called).toBe(true);
  });

  it('register with explicit jobId and onAbort uses the given ID', () => {
    const registry = new AbortRegistry(runtime.ids);
    let called = false;
    const jobId = registry.register('adopted-42', () => {
      called = true;
    });

    expect(jobId).toBe('adopted-42');
    expect(registry.has('adopted-42')).toBe(true);
    registry.abort(['adopted-42']);
    expect(called).toBe(true);
  });

  it('register without onAbort still works normally', () => {
    const registry = new AbortRegistry(runtime.ids);
    const jobId = registry.register('plain-job');

    expect(jobId).toBe('plain-job');
    expect(registry.has('plain-job')).toBe(true);
    const result = registry.abort(['plain-job']);
    expect(result.aborted).toEqual(['plain-job']);
  });

  it('releases the captured permit when abort settles even if the carrier never returns', () => {
    const registry = new AbortRegistry(runtime.ids);
    const admission = new LaunchCoordinator({ runtime });
    let carrierStarted = false;
    const carrierSettlement = new Promise<void>(() => {});
    const unsettledCarrier = () => {
      carrierStarted = true;
      void carrierSettlement;
    };
    const launched = admission.requestLaunch(
      'stuck-carrier',
      'codex',
      { kind: 'provider-session', id: 'stuck-session' },
      'default',
    );
    if (launched === 'queue_full' || launched.type !== 'immediate') throw new Error('expected exact permit');
    registry.register(launched.permit.jobId, unsettledCarrier, () => admission.releaseLaunch(launched.permit));

    expect(registry.abort([launched.permit.jobId])).toEqual({ aborted: [launched.permit.jobId], notFound: [] });
    expect(carrierStarted).toBe(true);
    expect(admission.reservationFor(launched.permit.jobId)).toBeNull();
    expect(admission.active).toBe(0);
  });
});
