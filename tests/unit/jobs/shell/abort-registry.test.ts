import { describe, expect, it } from 'vitest';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
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
});
