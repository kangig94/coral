import { vi } from 'vitest';
import { WaitCoordinator, type WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import type { ExecutionWaitDetail } from '#src/jobs/wait/execution-detail.js';
import type { WaitProgressRow, WaitStreamRequest } from '#src/jobs/wait/contract.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { admitted, TEST_EPOCH } from '#tests/helpers/wait-session.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

export function waitExecutions() {
  const time = new VirtualTime();
  vi.spyOn(time, 'sleep').mockImplementation(async (ms) => {
    time.tick(ms);
  });
  const histories = new Map<string, ExecutionWaitDetail[]>();
  const progress = new Map<string, WaitProgressRow[]>();
  const pendingArtifacts = new Set<string>();
  let frontier = 0;
  const request = (jobId: string, requestedSeq: number, queued = false) => {
    const history = histories.get(jobId) ?? [];
    const detail = admitted(jobId, [], false).detail;
    history.push({
      status: {
        ...detail.status,
        execution: history.length + 1,
        lastSeq: requestedSeq,
        phase: queued ? 'queued' : 'running',
      },
      requestedSeq,
      runtime: null,
      exit: null,
    });
    histories.set(jobId, history);
    frontier = Math.max(frontier, requestedSeq);
  };
  const end = (jobId: string, seq: number) => {
    const latest = histories.get(jobId)!.at(-1)!;
    latest.status = { ...latest.status!, phase: 'completed', lastSeq: seq };
    latest.terminalSeq = seq;
    latest.exit = {
      content: `${jobId}#${latest.status.execution}`,
      outcome: { kind: 'completed' },
      durationMs: 1,
      diagnostics: { progressFaults: [] },
      endTime: '2026-10-22T00:00:00Z',
    };
    frontier = Math.max(frontier, seq);
  };
  const addProgress = (jobId: string, seq: number, message: string) => {
    const rows = progress.get(jobId) ?? [];
    rows.push({ seq, message, timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 } });
    progress.set(jobId, rows);
    const latest = histories.get(jobId)!.at(-1)!;
    latest.status = { ...latest.status!, lastSeq: seq };
    frontier = Math.max(frontier, seq);
  };
  const visit: WaitCoordinatorDeps['visitProgress'] = (_epoch, read) => ({
    kind: 'read',
    value: read({
      frontier: () => frontier,
      after: (id, after, count, through = frontier) =>
        (progress.get(id) ?? []).filter((row) => row.seq > after && row.seq <= through).slice(0, count),
      newest: (id, count, after = 0, through = frontier) =>
        (progress.get(id) ?? []).filter((row) => row.seq > after && row.seq <= through).slice(-count),
    }),
  });
  const load = vi.fn((id: string, requestedSeq?: number): ExecutionWaitDetail => {
    const history = histories.get(id) ?? [];
    const selected =
      requestedSeq === undefined ? history.at(-1) : history.find((entry) => entry.requestedSeq === requestedSeq);
    return {
      ...(selected ?? { status: null, runtime: null, exit: null }),
      requestSeqs: history.map((entry) => entry.requestedSeq!),
    };
  });
  const coordinator = new WaitCoordinator({
    time,
    eventBus: new TypedEventBus(),
    conversationManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobWaitDetail: load,
    readExecutionFinishingStatus: ({ jobId, execution }) =>
      histories.get(jobId)?.find((entry) => entry.status?.execution === execution)?.status?.finishingStatus ?? null,
    readJobLastSeq: (id) => histories.get(id)?.at(-1)?.status?.lastSeq ?? null,
    visitProgress: visit,
    aggregateWorkflowUsage: () => undefined,
    subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    getCurrentJournalSeq: () => frontier,
    currentJobEpochKey: () => TEST_EPOCH,
    resultJobsRoot: '/results',
    observeResultAvailability: (id, execution) =>
      pendingArtifacts.has(`${id}#${execution}`)
        ? { kind: 'pending' }
        : { kind: 'available', resultPath: `/results/${id}/executions/${execution}/result.md` },
  });
  const stream = (input: WaitStreamRequest) =>
    readWaitSession({
      request: input,
      activeEpochKey: TEST_EPOCH,
      time,
      visit,
      read: () => coordinator.readWaitAdmissions(input.jobIds, TEST_EPOCH, input),
      observe: (session) => session.observeCoverage(input.jobIds, [], frontier),
    });
  return { request, end, addProgress, histories, progress, coordinator, stream, load, pendingArtifacts, visit, time };
}
