import { progressVisitFromEvents, progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { expect, it } from 'vitest';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';
import { WaitCoordinator, type WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';

it('cursorless bounded wait: progress appended between polls beyond the tail window', async () => {
  const runtime = new SimulationRuntime();
  const status: JobStatus = {
    jobId: 'job-1',
    owner: { kind: 'provider-session', id: 's' },
    sessionId: 's',
    provider: 'codex',
    projectRoot: '/project',
    workDir: fixtureCanonicalWorkDir('/project'),
    backendNamespace: 'test',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: new Date(runtime.time.now()).toISOString(),
  };
  const journal: JobEvent[] = [];
  let seq = 0;
  const push = (n: number) => {
    for (let i = 0; i < n; i++) {
      seq++;
      journal.push({
        type: 'progress',
        jobId: 'job-1',
        sessionId: 's',
        seq,
        ts: '',
        message: `line ${seq}`,
        timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
      } as JobEvent);
    }
  };
  const readJobEvents: (id: string, after?: number) => JobEvent[] = (_id, after = 0) =>
    journal.filter((event) => event.seq > after);
  const deps: WaitCoordinatorDeps = {
    visitProgress: progressVisitFromEvents(readJobEvents),
    time: runtime.time,
    eventBus: new TypedEventBus(),
    sessionManager: { get: () => null } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    readJobLastSeq: () => null,
    loadJobWaitDetail: () => {
      const terminal = journal.find((e): e is JobTerminalEvent => e.type === 'terminal');
      return {
        status,
        runtime: null,
        exit: terminal ? { ...terminal.result, endTime: terminal.ts, diagnostics: { progressFaults: [] } } : null,
      };
    },

    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => seq,
    resultJobsRoot: '/results',
    observeResultAvailability: (jobId) => ({ kind: 'available', resultPath: `/results/${jobId}/result.md` }),
    subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
  };
  const wait = new WaitCoordinator(deps);
  push(5);
  const index = new JobLocationIndex(runtime, '/coral');
  index.register('job-1', 'epoch', { projectRoot: '/project', workDir: '/project', jobKind: 'provider' });
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => ({ status, events: journal, readiness: 'ready', exit: null })),
      epochKey: () => 'epoch',
      detail: () => ({ status, events: journal, readiness: 'ready', exit: null }),
      readWaitAdmission: (id, epoch, session) => wait.readWaitAdmission(id, epoch, session),
      readWaitAdmissions: (ids, epoch, session) => wait.readWaitAdmissions(ids, epoch, session),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'available', resultPath: '/x' }),
  );
  const events: WaitStreamEvent[] = [];
  const stream = addressing.waitStream({ jobIds: ['job-1'], timeoutSeconds: 3 });
  const done = (async () => {
    for await (const e of stream) events.push(e);
  })();
  await flushMicrotasks(40);
  // The job is chatty: 60 progress events land between two 250 ms polls.
  push(60);
  for (let i = 0; i < 20; i++) {
    runtime.time.tick(250);
    await flushMicrotasks(40);
  }
  await done;
  const lines = events.filter((e) => e.type === 'progress').map((e) => (e.type === 'progress' ? e.message : ''));
  expect(events.at(-1)?.type).toBe('waiting');

  expect(lines).toEqual(Array.from({ length: 65 }, (_, i) => `line ${i + 1}`));
});
