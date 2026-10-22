import type { WaitStreamRequest } from '#src/jobs/wait/contract.js';
import { JobWaitService } from '#src/coordinator/services/job-wait.js';
import { waitExecutions } from '#tests/helpers/wait-executions.js';
import { TEST_EPOCH } from '#tests/helpers/wait-session.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
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

  it('attaches wait attention to the selected execution while the successor is current', async () => {
    const f = waitExecutions();
    f.request('job', 10);
    f.end('job', 20);
    f.request('job', 30);
    const attention = new JobAttention();
    attention.requested('job', 1);
    attention.requested('job', 2);
    const admitWait = vi.fn((request: WaitStreamRequest) => f.coordinator.admitWait(request));
    const service = new JobWaitService({
      jobAttention: attention,
      runtime: { time: new VirtualTime() },
      waitCoordinator: {
        admitWait,
        readWaitAdmission: (jobId, epochKey, request) => f.coordinator.readWaitAdmission(jobId, epochKey, request),
        waitForOutcomes: f.stream,
        waitForJobTerminal: async () => {},
        waitStreamOnce: async () => ({ content: '', continuity: null }),
      },
      loadJobProjectionDetail: (jobId) => ({ ...f.load(jobId), launch: null }),
      subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
      getCurrentJournalSeq: () => 30,
    });
    const wait = service.waitStream({
      jobIds: ['job'],
      executionSelections: [{ jobId: 'job', epochKey: TEST_EPOCH, requestedSeq: 10, awaitingArtifact: false }],
    });
    await wait.next();
    expect(admitWait).toHaveBeenCalledOnce();
    expect(attention.isUnwaited('job', 1)).toBe(false);
    expect(attention.isUnwaited('job', 2)).toBe(true);
    await wait.return(undefined);
    expect(attention.isUnwaited('job', 1)).toBe(true);
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

it('refreshes acceptance holds for an attached wait without rereading unchanged journal evidence', () => {
  const f = waitExecutions();
  f.request('job', 10);
  const request = { jobIds: ['job'] };
  const first = f.coordinator.readWaitAdmission('job', TEST_EPOCH, request);
  expect(first.detail?.status.finishingStatus).toBeUndefined();
  const loaded = f.load.mock.calls.length;
  f.histories.get('job')![0].status!.finishingStatus = {
    stage: 'accept',
    kind: 'blocked',
    reason: 'disk full',
    successor: 'recovery-quarantine',
  };
  expect(f.coordinator.readWaitAdmission('job', TEST_EPOCH, request).detail?.status.finishingStatus).toMatchObject({
    kind: 'blocked',
    reason: 'disk full',
  });
  expect(f.load).toHaveBeenCalledTimes(loaded);
});
