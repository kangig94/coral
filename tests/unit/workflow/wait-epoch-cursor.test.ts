import { describe, expect, it, vi } from 'vitest';

import type { InvocationContext } from '../../../src/runtime/invocation-context.js';
import type { LaunchedAtom, WorkflowExecutionPort } from '../../../src/workflow/execution-contract.js';
import { waitForAtoms } from '../../../src/workflow/wait.js';
import type { WaitStreamEvent } from '../../../src/jobs/wait.js';

function atom(jobId: string, atomIndex: number): LaunchedAtom {
  return {
    slotId: `workflow:0:${atomIndex}`,
    jobId,
    sessionId: `session-${atomIndex}`,
    providerName: 'claude',
    agent: 'worker',
    tagName: 'worker',
    stepIndex: 0,
    atomIndex,
    atomKey: `0:${atomIndex}`,
    generation: 0,
  };
}

function terminal(jobId: string, seq: number, epochKey: string, remainingJobIds: string[]): WaitStreamEvent {
  return {
    type: 'terminal',
    version: 'jobs.wait.v2',
    jobId,
    seq,
    epochKey,
    remainingJobIds,
    resultPath: `/tmp/${jobId}.md`,
    result: { content: `${jobId} done`, outcome: { kind: 'completed' }, durationMs: 1 },
    cursor: {
      version: 'jobs.wait.v2',
      locations: { old: 'lineage-old:7', newer: 'lineage-new:8' },
      positions: { 'lineage-old:7': jobId === 'old' ? seq : 3, 'lineage-new:8': jobId === 'newer' ? seq : 5 },
      deliveredJobIds: [jobId],
    },
  };
}

describe('workflow wait epoch cursor', () => {
  it('persists the remaining job epoch and resumes its local position after another epoch terminates', async () => {
    const waitStream = vi
      .fn()
      .mockImplementationOnce(async function* () {
        yield terminal('newer', 6, 'lineage-new:8', ['old']);
      })
      .mockImplementationOnce(async function* () {
        yield terminal('old', 4, 'lineage-old:7', []);
      });
    const results = await waitForAtoms(
      [atom('old', 0), atom('newer', 1)],
      { waitStream } as unknown as WorkflowExecutionPort,
      {} as InvocationContext,
      {
        time: { now: () => 0, monotonicNow: () => 0n },
        staleTimeoutMs: 0,
        staleCheckIntervalMs: 1_000,
        staleAbortTimeoutMs: 30_000,
        drainDeadlineMs: 30_000,
        onProgress: () => {},
        initialState: {
          cursor: {
            version: 'jobs.wait.v2',
            locations: { old: 'lineage-old:7', newer: 'lineage-new:8' },
            positions: { 'lineage-old:7': 3, 'lineage-new:8': 5 },
          },
        },
      },
    );
    expect(results).toEqual(
      new Map([
        ['0:1', 'newer done'],
        ['0:0', 'old done'],
      ]),
    );
    expect(waitStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        jobIds: ['old'],
        cursor: {
          version: 'jobs.wait.v2',
          locations: { old: 'lineage-old:7' },
          positions: { 'lineage-old:7': 3 },
          deliveredJobIds: [],
        },
      }),
    );
  });
});
