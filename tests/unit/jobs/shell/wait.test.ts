import { StoreCodecError } from '#src/store/body-codec.js';
import { nextDelivered, nextFinal } from '#tests/helpers/wait-stream.js';
import { progressVisitFromEvents } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';

import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import type { WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { WaitStreamRequest } from '#src/jobs/wait/contract.js';

function fixture() {
  const runtime = new SimulationRuntime();
  const eventBus = new TypedEventBus();
  let activeJobId: string | undefined = 'job-1';
  let status: JobStatus = {
    jobId: 'job-1',
    owner: { kind: 'provider-session', id: 'session-1' },
    sessionId: 'session-1',
    provider: 'codex',
    projectRoot: '/project',
    workDir: fixtureCanonicalWorkDir('/project'),
    backendNamespace: 'test',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: new Date(runtime.time.now()).toISOString(),
  };
  const journal: JobEvent[] = [];
  const pollStarted = createDeferred<void>();
  const setTimeout = runtime.time.setTimeout.bind(runtime.time);
  vi.spyOn(runtime.time, 'setTimeout').mockImplementation((fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (ms === 250) pollStarted.resolve();
    return handle;
  });
  const deps: WaitCoordinatorDeps = {
    visitProgress: progressVisitFromEvents(() => journal),
    time: runtime.time,
    eventBus,
    sessionManager: { get: () => ({ activeJobId, state: 'pending', providerContinuity: null }) } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobWaitDetail: () => {
      const terminal = journal.find((event): event is JobTerminalEvent => event.type === 'terminal');
      return {
        status: { ...status, lastSeq: journal.at(-1)?.seq ?? 0 },
        runtime: null,
        exit: terminal ? { ...terminal.result, endTime: terminal.ts, diagnostics: { progressFaults: [] } } : null,
      };
    },
    readJobLastSeq: () => journal.at(-1)?.seq ?? 0,

    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => journal.at(-1)?.seq ?? 0,
    resultJobsRoot: '/results',
    observeResultAvailability: (jobId) => ({ kind: 'available', resultPath: `${'/results'}/${jobId}/result.md` }),
    subscribeJobEvents: ({ abortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) => abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
        }
      },
    }),
  };
  const wait = new WaitCoordinator(deps);
  const index = new JobLocationIndex(runtime, '/coral');
  for (const jobId of ['job-1', 'a', 'b'])
    index.register(jobId, 'epoch', { projectRoot: '/project', workDir: '/project', jobKind: 'provider' });
  // A client wait reaches this coordinator through job addressing, as production composes it.
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: wait.visitProgress,
      epochKey: () => 'epoch',
      detail: () => null,
      readWaitAdmissions: (ids, epoch, session) => wait.readWaitAdmissions(ids, epoch, session),
      observeWaitCarriers: (ids, signal) => wait.observeWaitCarriers(ids, signal),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
  );
  return {
    wait,
    clientWait: (request: WaitStreamRequest) => addressing.waitStream(request),
    deps,
    runtime,
    eventBus,
    journal,
    pollStarted: pollStarted.promise,
    terminalize: () => {
      status = { ...status, phase: 'completed' };
    },
    releaseClaim: () => {
      activeJobId = undefined;
    },
    terminal: (): JobTerminalEvent => ({
      type: 'terminal',
      jobId: 'job-1',
      sessionId: 'session-1',
      seq: 1,
      ts: new Date(runtime.time.now()).toISOString(),
      result: { content: 'done', durationMs: 0, outcome: { kind: 'completed' } },
    }),
  };
}

describe('WaitCoordinator', () => {
  it('delivers an internal terminal without claiming an unavailable artifact', async () => {
    const f = fixture();
    f.deps.observeResultAvailability = () => ({ kind: 'pending' });
    f.journal.push(f.terminal());
    const event = (await nextDelivered(f.wait.waitForOutcomes({ jobIds: ['job-1'] }))).value;
    expect(event).toMatchObject({ type: 'terminal' });
    expect(event).not.toHaveProperty('resultPath');
  });

  it('collects an internal outcome while the result artifact is pending', async () => {
    const f = fixture();
    f.deps.observeResultAvailability = () => ({ kind: 'pending' });
    f.journal.push(f.terminal());
    await expect(f.wait.waitStreamOnce('job-1')).resolves.toMatchObject({ content: 'done' });
  });

  it('preserves workflow usage and session continuity in shared admission', () => {
    const f = fixture();
    const detail = admitted('job-1').detail;
    f.deps.getCurrentJournalSeq = () => detail.events.at(-1)?.seq ?? 0;
    const usage = { inputTokens: 123, outputTokens: 456 } as never;
    f.deps.aggregateWorkflowUsage = () => usage;
    f.deps.sessionManager = {
      get: () => ({
        state: 'ready',
        conversationRef: { provider: 'codex', sessionId: 'session-1' },
        providerContinuity: null,
      }),
    } as never;
    f.deps.loadJobWaitDetail = () => ({
      status: { ...detail.status, jobKind: 'workflow', provider: 'codex', sessionId: 'session-1' },
      runtime: null,
      exit: detail.exit,
    });
    const result = f.wait.readWaitAdmission('job-1', 'epoch');
    expect(result.detail?.exit?.diagnostics.usage).toEqual(usage);
    expect(result.continuity).toMatchObject({ resumable: true, conversationRef: { sessionId: 'session-1' } });
  });

  it('waits for both terminal status and session claim release', async () => {
    const f = fixture();
    let settled = false;
    const waiting = f.wait.waitForJobTerminal('job-1').then(() => {
      settled = true;
    });
    f.releaseClaim();
    f.eventBus.emit('session:released', { jobId: 'job-1', sessionId: 'session-1' });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.terminalize();
    const g = fixture();
    g.terminalize();
    let terminalSettled = false;
    const terminalWaiting = g.wait.waitForJobTerminal('job-1').then(() => {
      terminalSettled = true;
    });
    g.eventBus.emit('job:completed', { jobId: 'job-1', result: g.terminal().result });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    f.eventBus.emit('job:completed', { jobId: 'job-1', result: f.terminal().result });
    g.releaseClaim();
    g.eventBus.emit('session:released', { jobId: 'job-1', sessionId: 'session-1' });
    await Promise.all([waiting, terminalWaiting]);
  });

  it('catches up from the durable journal after a missed notification', async () => {
    const f = fixture();
    const stream = f.clientWait({ jobIds: ['job-1'], timeoutSeconds: 1 });
    const next = nextDelivered(stream);
    await f.pollStarted;
    f.journal.push(f.terminal());
    f.runtime.time.tick(250);
    expect((await next).value).toMatchObject({ type: 'terminal', jobId: 'job-1', seq: 1 });
    await stream.return(undefined);
  });

  it('does not synthesize a terminal from status without journal evidence', async () => {
    const f = fixture();
    f.terminalize();
    f.releaseClaim();
    const stream = f.clientWait({ jobIds: ['job-1'], timeoutSeconds: 1 });
    const next = nextDelivered(stream);
    await f.pollStarted;
    f.runtime.time.tick(1001);
    expect((await next).value).toMatchObject({
      type: 'waiting',
      waitingJobIds: ['job-1'],
      carrierUnknownJobIds: ['job-1'],
    });
    await stream.return(undefined);
  });

  it('replays a terminal arriving after timeout on the next request with the unchanged cursor', async () => {
    const f = fixture();
    const cursor = savedCursor(0, 'epoch');
    const stream = f.clientWait({ jobIds: ['job-1'], timeoutSeconds: 1, cursor });
    const next = nextFinal(stream);
    await f.pollStarted;
    f.runtime.time.tick(1001);
    expect((await next).value).toMatchObject({
      type: 'waiting',
      waitingJobIds: ['job-1'],
      carrierUnknownJobIds: ['job-1'],
    });
    await stream.return(undefined);
    f.journal.push(f.terminal());
    const resumed = f.clientWait({ jobIds: ['job-1'], cursor });
    expect((await nextFinal(resumed)).value).toMatchObject({ type: 'terminal', seq: 1 });
    await resumed.return(undefined);
  });
});

it('a missing internal job is a failed outcome', async () => {
  const f = fixture();
  f.deps.loadJobWaitDetail = () => ({ status: null, runtime: null, exit: null });
  f.deps.observeJobAbsence = () => true;
  const wait = new WaitCoordinator(f.deps);
  await expect(wait.waitStreamOnce('missing', 1000)).rejects.toThrow('missing');
});

it.each([false, true])('internal waits answer missing only after explicit absence: %s', (explicitAbsence) => {
  const f = fixture();
  f.deps.loadJobWaitDetail = () => ({ status: null, runtime: null, exit: null });
  f.deps.observeJobAbsence = () => explicitAbsence;
  const admission = f.wait.readWaitAdmission('transferred', 'new-epoch', {});
  expect(admission.disposition).toBe(explicitAbsence ? 'missing' : 'unknown');
});

it('internal child wait reads its durable historical epoch', async () => {
  const f = fixture();
  f.deps.currentJobEpochKey = () => 'active';
  f.deps.loadJobWaitDetail = () => ({ status: null, runtime: null, exit: null });
  f.deps.observeJobAbsence = () => true;
  f.deps.internalWait = {
    admissions: () => [admitted('child', [], true, 'historical')],
    visitProgress: f.deps.visitProgress,
  };
  const events = [];
  for await (const event of f.wait.waitForOutcomes({ jobIds: ['child'], timeoutSeconds: 0 })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'terminal', jobId: 'child', result: { content: 'child result' } });
});

it('settles an active-journal decode failure as unreadable and propagates a code defect', () => {
  const f = fixture();
  f.deps.loadJobWaitDetail = (jobId) => {
    if (jobId === 'undecodable') throw new StoreCodecError('Current codec rejected stored event', {});
    if (jobId === 'defect') throw new TypeError('defect');
    return { status: admitted(jobId, [], false).detail.status, runtime: null, exit: null };
  };
  expect(f.wait.readWaitAdmissions(['undecodable', 'job-1'], 'epoch', {})).toMatchObject([
    { jobId: 'undecodable', disposition: 'unreadable' },
    { jobId: 'job-1', disposition: 'admitted' },
  ]);
  expect(() => f.wait.readWaitAdmissions(['defect'], 'epoch', {})).toThrow(TypeError);
});
