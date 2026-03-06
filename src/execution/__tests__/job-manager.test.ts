import { describe, expect, it } from 'vitest';
import { JobManager } from '../job-manager.js';

describe('execution JobManager', () => {
  it('allocate returns a UUID', () => {
    const manager = new JobManager();

    const jobId = manager.allocate('session-1', 'codex');

    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('isActive returns true for launching and running, false for completed', () => {
    const manager = new JobManager();
    const jobId = manager.allocate('session-1', 'codex');

    expect(manager.isActive(jobId)).toBe(true);

    manager.setPhase(jobId, 'running');
    expect(manager.isActive(jobId)).toBe(true);

    manager.setPhase(jobId, 'completed');
    expect(manager.isActive(jobId)).toBe(false);
  });

  it('abort aborts the correct jobs and reports notFound correctly', () => {
    const manager = new JobManager();
    const firstJobId = manager.allocate('session-1', 'codex');
    const secondJobId = manager.allocate('session-2', 'claude');

    const result = manager.abort([firstJobId, 'missing-job']);

    expect(result).toEqual({
      aborted: [firstJobId],
      notFound: ['missing-job'],
    });
    expect(manager.get(firstJobId)?.controller.signal.aborted).toBe(true);
    expect(manager.get(secondJobId)?.controller.signal.aborted).toBe(false);
  });
});
