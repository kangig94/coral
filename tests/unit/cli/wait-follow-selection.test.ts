import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type { WaitExecutionSelection } from '#src/jobs/wait/execution-selection.js';
import { isAcceptedLaunchResponse, handleLaunchResult } from '#src/cli/emit.js';
import type { WaitResumeError } from '#src/cli/errors.js';

const pin = (jobId: string, requestedSeq: number): WaitExecutionSelection => ({
  jobId,
  epochKey: 'epoch',
  requestedSeq,
  awaitingArtifact: false,
});
const launchResult = {
  kind: 'provider-session',
  launchState: 'running',
  jobId: 'a',
  epochKey: 'epoch',
  requestedSeq: 100,
} as const;
const terminal = (
  jobId: string,
  seq: number,
  executionSelections: WaitExecutionSelection[],
  remainingJobIds: string[] = [],
): WaitStreamEvent => ({
  type: 'terminal',
  jobId,
  seq,
  remainingJobIds,
  cursor: String(seq),
  exitCode: remainingJobIds.length ? 75 : 7,
  result: { content: `${jobId} selected`, durationMs: 1, outcome: { kind: 'provider_exit', code: 7 } },
  availability: { kind: 'available', resultPath: `/results/${jobId}` },
  resultPath: `/results/${jobId}`,
  executionSelections,
});
function subscription(events: readonly unknown[]) {
  return {
    close: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    _chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const options = {
  reconnectPolicy: 'until-terminal' as const,
  projectRoot: '/project',
  emitError: vi.fn(),
  render: { isTTY: false, columns: 80, embed: false, verbose: false },
};

describe('follow execution selection', () => {
  it('seeds launch #2 before its first admission and keeps it across handover even when #3 is latest', async () => {
    const selections = [pin('a', 100)];
    const connect = vi
      .fn<Parameters<typeof followJobs>[0]['connect']>()
      .mockResolvedValueOnce({ kind: 'subscription', subscription: subscription([{ type: 'handover' }]) })
      .mockResolvedValueOnce({
        kind: 'subscription',
        subscription: subscription([terminal('a', 120, [{ ...pin('a', 100), deliveredEndSeq: 120 }])]),
      });
    await expect(followJobs({ ...options, start: { kind: 'launch', launchResult }, connect })).resolves.toBe(7);
    expect(connect).toHaveBeenCalledTimes(2);
    for (const [request] of connect.mock.calls) {
      expect(request.executionSelections).toEqual(selections);
      expect(request.cursor).toBeUndefined();
      expect(request.jobIds).toEqual(['a']);
    }
  });

  it('reconnects only outstanding members with delivered-end evidence at W=279', async () => {
    const admitted = [pin('a', 1000), pin('b', 2)];
    const completed = [pin('a', 1000), { ...pin('b', 2), deliveredEndSeq: 950 }];
    const connect = vi
      .fn<Parameters<typeof followJobs>[0]['connect']>()
      .mockResolvedValueOnce({
        kind: 'subscription',
        subscription: subscription([
          { type: 'admission', executionSelections: admitted },
          { ...terminal('b', 950, completed, ['a']), cursor: '279', exitCode: undefined },
          { type: 'cursor', cursor: '279', executionSelections: completed },
          { type: 'handover' },
        ]),
      })
      .mockResolvedValueOnce({
        kind: 'subscription',
        subscription: subscription([terminal('a', 1100, [{ ...pin('a', 1000), deliveredEndSeq: 1100 }, completed[1]])]),
      });
    await expect(followJobs({ ...options, start: { kind: 'jobs', jobIds: ['a', 'b'] }, connect })).resolves.toBe(7);
    expect(connect.mock.calls[1][0]).toMatchObject({ jobIds: ['a'], cursor: '279', executionSelections: completed });
  });

  it('should print a plain continuation after disconnect before any progress cursor', async () => {
    const connect = vi.fn<Parameters<typeof followJobs>[0]['connect']>().mockResolvedValue({
      kind: 'subscription',
      subscription: subscription([{ type: 'admission', executionSelections: [pin('a', 100)] }]),
    });
    const emitError = vi.fn();
    await followJobs({ ...options, emitError, start: { kind: 'launch', launchResult }, connect });
    const error = emitError.mock.calls[0][0] as WaitResumeError;
    expect(error.remediation).toBe('Rerun `coral-cli jobs wait a` to continue waiting.');
  });

  it('rejects accepted launch shapes lacking the committed request address', () => {
    expect(isAcceptedLaunchResponse(launchResult)).toBe(true);
    expect(isAcceptedLaunchResponse({ kind: 'provider-session', launchState: 'running', jobId: 'a' })).toBe(false);
    expect(isAcceptedLaunchResponse({ ...launchResult, requestedSeq: 0 })).toBe(false);
  });
});

it.each([true, false])(
  'reports undecodable launch replies as unknown without interpreting them (detach=%s)',
  async (detach) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await handleLaunchResult({ kind: 'provider-session', launchState: 'running', jobId: 'untrusted-old-job' }, detach);
    expect(process.exitCode).toBe(75);
    const text = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(text).toContain('Launch outcome unknown — the job may already be running');
    expect(text).toContain('command=coral-cli jobs list');
    expect(text).not.toContain('untrusted-old-job');
    expect(process.stdout.write).not.toHaveBeenCalled();
  },
);
