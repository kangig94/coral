import { describe, expect, it } from 'vitest';
import { AbortRegistry } from '../abort-registry.js';

describe('execution AbortRegistry', () => {
  it('register returns a UUID', () => {
    const registry = new AbortRegistry();
    const jobId = registry.register();
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('has returns true while registered, false after remove', () => {
    const registry = new AbortRegistry();
    const jobId = registry.register();
    expect(registry.has(jobId)).toBe(true);
    registry.remove(jobId);
    expect(registry.has(jobId)).toBe(false);
  });

  it('abort aborts the correct jobs and reports notFound correctly', () => {
    const registry = new AbortRegistry();
    const firstJobId = registry.register();
    const secondJobId = registry.register();

    const result = registry.abort([firstJobId, 'missing-job']);

    expect(result).toEqual({
      aborted: [firstJobId],
      notFound: ['missing-job'],
    });
    expect(registry.getSignal(firstJobId)?.aborted).toBe(true);
    expect(registry.getSignal(secondJobId)?.aborted).toBe(false);
  });
});
