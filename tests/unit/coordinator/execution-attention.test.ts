import { describe, expect, it, vi } from 'vitest';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';

describe('execution-scoped local ownership', () => {
  it('keeps the successor abortable when predecessor cleanup arrives late', () => {
    const registry = new AbortRegistry();
    const predecessor = vi.fn();
    const successor = vi.fn();
    registry.register('job', 1, predecessor);
    registry.register('job', 2, successor);
    const currentSignal = registry.getSignal('job', 2);
    registry.remove('job', 1);
    expect(registry.getSignal('job')).toBe(currentSignal);
    expect(registry.abort(['job'])).toEqual({ aborted: ['job'], notFound: [] });
    expect(predecessor).not.toHaveBeenCalled();
    expect(successor).toHaveBeenCalledOnce();
  });

  it('rearms queued continuations despite a release and an attached predecessor wait', () => {
    const attention = new JobAttention();
    attention.requested('job', 1);
    const oldWait = attention.beginWait([{ jobId: 'job', execution: 1 }]);
    attention.release('job', 1);
    attention.requested('job', 2);
    expect(attention.isUnwaited('job', 1)).toBe(false);
    expect(attention.isUnwaited('job', 2)).toBe(true);
    expect(attention.isReleased('job', 2)).toBe(false);
    const newWait = attention.beginWait([{ jobId: 'job', execution: 2 }]);
    oldWait();
    oldWait();
    expect(attention.isUnwaited('job', 2)).toBe(false);
    newWait();
    expect(attention.isUnwaited('job', 2)).toBe(true);
  });
});
