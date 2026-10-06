import { StoreCodecError } from '#src/store/body-codec.js';
import { nextDelivered, nextFinal } from '#tests/helpers/wait-stream.js';
import { progressVisitFromEvents, progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';

import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import type { WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';

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
    visitProgress: progressVisitFromEvents(
      () => journal,
      () => journal.at(-1)?.seq ?? 0,
    ),
    time: runtime.time,
    eventBus,
    sessionManager: { get: () => ({ activeJobId, state: 'pending', providerContinuity: null }) } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobProjectionDetail: () => {
      const terminal = journal.find((event): event is JobTerminalEvent => event.type === 'terminal');
      return {
        status: { ...status, lastSeq: terminal?.seq },
        launch: null,
        runtime: null,
        exit: terminal ? { ...terminal.result, endTime: terminal.ts, diagnostics: { progressFaults: [] } } : null,
      };
    },

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
  return {
    wait: new WaitCoordinator(deps),
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
  it('observes active carriers independently of a previously collected 501-line backlog', async () => {
    const f = fixture();
    f.journal.push(
      ...admitted(
        'job-1',
        Array.from({ length: 501 }, (_, i) => [i + 1, `line ${i}`]),
        false,
      ).detail.events,
    );
    let calls = 0;
    f.deps.observeCarriers = async () => [
      {
        jobId: 'job-1',
        storedPhase: 'running',
        observedMaxJournalSeq: 501,
        liveness: ++calls === 1 ? 'live' : 'unknown',
      },
    ];
    const index = new JobLocationIndex(f.runtime, '/coral');
    index.register('job-1', 'epoch', { projectRoot: '/project', workDir: '/project', jobKind: 'provider' });
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        visitProgress: progressVisitFromDetails(() => ({ ...admitted('job-1', [], false).detail, events: f.journal })),
        epochKey: () => 'epoch',
        detail: () => ({ ...admitted('job-1', [], false).detail, events: f.journal }),
        readWaitAdmission: (id, epoch, session) => f.wait.readWaitAdmission(id, epoch, session),
        readWaitAdmissions: (ids, epoch, session) => f.wait.readWaitAdmissions(ids, epoch, session),
        observeWaitCarriers: (ids, signal) => f.wait.observeWaitCarriers(ids, signal),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    const stream = addressing.waitStream({
      jobIds: ['job-1'],
      timeoutSeconds: 1,
      cursor: {
        jobs: [{ hash: waitJobHash('job-1'), epoch: waitEpochToken('epoch'), seq: 501, lineOffset: 0, flags: 0 }],
      },
    });
    const next = nextDelivered(stream);
    await flushMicrotasks(40);
    for (let i = 0; i < 4; i++) {
      f.runtime.time.tick(250);
      await flushMicrotasks(40);
    }
    expect((await next).value).toMatchObject({ type: 'waiting', carrierUnknownJobIds: ['job-1'] });
    expect(calls).toBeGreaterThan(1);
    await stream.return(undefined);
  });
  it('continues internal outcome waiting past progress pages without renewing the deadline', async () => {
    const f = fixture();
    f.journal.push(
      ...admitted(
        'job-1',
        Array.from({ length: 501 }, (_, i) => [i + 1, `line ${i}`]),
        false,
      ).detail.events,
    );
    let settled = false;
    const result = f.wait.waitStreamOnce('job-1', 1000).finally(() => {
      settled = true;
    });
    const assertion = expect(result).resolves.toMatchObject({ content: 'done' });
    await f.pollStarted;
    expect(settled).toBe(false);
    f.runtime.time.tick(250);
    await flushMicrotasks(30);
    f.journal.push({ ...f.terminal(), seq: 502 });
    f.runtime.time.tick(250);
    await flushMicrotasks(30);
    await assertion;
  });

  it('times out an internal paginated outcome wait only at its original deadline', async () => {
    const f = fixture();
    f.journal.push(
      ...admitted(
        'job-1',
        Array.from({ length: 1001 }, (_, i) => [i + 1, `line ${i}`]),
        false,
      ).detail.events,
    );
    let settled = false;
    const result = f.wait.waitStreamOnce('job-1', 1000).finally(() => {
      settled = true;
    });
    const assertion = expect(result).rejects.toThrow('Wait expired');
    // The backlog drains page by page across macrotasks; only the virtual deadline may end the wait.
    for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    for (let i = 0; i < 4; i++) {
      f.runtime.time.tick(250);
      await flushMicrotasks(50);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await assertion;
  });

  it('bounds active sibling progress by one frontier across a between-read commit', async () => {
    const f = fixture();
    let committed = false;
    let frontier = 0;
    f.deps.getCurrentJournalSeq = () => frontier;
    f.deps.loadJobProjectionDetail = (id) => ({
      status: { ...admitted(id, [], false).detail.status },
      launch: null,
      runtime: null,
      exit: null,
    });
    f.deps.visitProgress = (_epoch, visit) => {
      const frozen = committed;
      const source = progressVisitFromEvents(
        (id) => admitted(id, frozen ? [[id === 'a' ? 1 : 2, `${id} committed`]] : [], false).detail.events,
        () => (frozen ? 2 : 0),
      );
      const result = source('epoch', visit);
      committed = true;
      frontier = 2;
      return result;
    };
    const events = [];
    for await (const event of f.wait.waitForJobs({ jobIds: ['a', 'b'], timeoutSeconds: 0 })) events.push(event);
    const last = events.at(-1)!;
    const cursor = 'cursor' in last ? last.cursor : undefined;
    for await (const event of f.wait.waitForJobs({
      jobIds: ['a', 'b'],
      timeoutSeconds: 0,
      cursor,
    }))
      events.push(event);
    expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual([
      'a committed',
      'b committed',
    ]);
  });
  it('delivers an internal terminal without claiming an unavailable artifact', async () => {
    const f = fixture();
    f.deps.observeResultAvailability = () => ({ kind: 'repair-pending', ageUncertain: false });
    f.journal.push(f.terminal());
    const event = (await nextDelivered(f.wait.waitForJobs({ jobIds: ['job-1'] }))).value;
    expect(event).toMatchObject({ type: 'terminal' });
    expect(event).not.toHaveProperty('resultPath');
  });

  it('preserves queued activity when the shared reader has no journal progress', async () => {
    const f = fixture();
    const projected = f.deps.loadJobProjectionDetail('job-1');
    f.deps.loadJobProjectionDetail = () => ({ ...projected, status: { ...projected.status!, phase: 'queued' } });
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 0 });
    expect((await nextDelivered(stream)).value).toMatchObject({
      type: 'queued',
      jobId: 'job-1',
      jobKind: 'provider',
      sessionId: 'session-1',
      queuePosition: 0,
    });
    expect((await nextDelivered(stream)).value).toMatchObject({ type: 'waiting', waitingJobIds: ['job-1'] });
    await stream.return(undefined);
  });

  it('collects an internal outcome while the result artifact is pending', async () => {
    const f = fixture();
    f.deps.observeResultAvailability = () => ({ kind: 'repair-pending', ageUncertain: false });
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
    f.deps.loadJobProjectionDetail = () => ({
      status: { ...detail.status, jobKind: 'workflow', provider: 'codex', sessionId: 'session-1' },
      launch: null,
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
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 1 });
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
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 1 });
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
    const cursor = { jobs: [] };
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 1, cursor });
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
    expect(cursor).toEqual({ jobs: [] });
    const resumed = f.wait.waitForJobs({ jobIds: ['job-1'], cursor });
    expect((await nextFinal(resumed)).value).toMatchObject({ type: 'terminal', seq: 1 });
    await resumed.return(undefined);
  });
});
{
  describe('workflow readLaunchFailure uses the internal outcome reader', () => {
    it('returns the launch failure even while its artifact is unavailable', async () => {
      const runtime = new SimulationRuntime();
      const status: JobStatus = {
        jobId: 'job-1',
        owner: { kind: 'provider-session', id: 'session-1' },
        sessionId: 'session-1',
        provider: 'codex',
        projectRoot: '/project',
        workDir: fixtureCanonicalWorkDir('/project'),
        backendNamespace: 'test',
        jobKind: 'provider',
        phase: 'error',
        updatedAt: new Date(runtime.time.now()).toISOString(),
      };
      const terminal: JobTerminalEvent = {
        type: 'terminal',
        jobId: 'job-1',
        sessionId: 'session-1',
        seq: 1,
        ts: new Date(runtime.time.now()).toISOString(),
        result: {
          content: '',
          durationMs: 0,
          outcome: { kind: 'provider_exit', code: 2, note: 'auth failed' },
        } as never,
      };
      const journal: JobEvent[] = [terminal];
      const deps: WaitCoordinatorDeps = {
        visitProgress: progressVisitFromEvents(
          () => journal,
          () => 1,
        ),
        time: runtime.time,
        eventBus: new TypedEventBus(),
        sessionManager: {
          get: () => ({ activeJobId: undefined, state: 'pending', providerContinuity: null }),
        } as never,
        launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
        loadJobProjectionDetail: () =>
          ({
            status,
            launch: null,
            runtime: null,
            exit: { ...terminal.result, endTime: terminal.ts, diagnostics: { progressFaults: [] } },
          }) as never,

        aggregateWorkflowUsage: () => undefined,
        getCurrentJournalSeq: () => 1,
        resultJobsRoot: '/results',
        observeResultAvailability: () => ({ kind: 'failed', cause: 'cutoff-untrusted', retryScheduled: true }),
        subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
      };
      const wait = new WaitCoordinator(deps);
      let thrown: unknown;
      const events: unknown[] = [];
      try {
        for await (const event of wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
          events.push(event);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'terminal',
          result: expect.objectContaining({ outcome: { kind: 'provider_exit', code: 2, note: 'auth failed' } }),
        }),
      );
    });
  });
}

it('a missing internal job is a failed outcome after one read, without re-entering the reader', async () => {
  const f = fixture();
  const load = vi.fn(() => ({ status: null, launch: null, runtime: null, exit: null }));
  f.deps.loadJobProjectionDetail = load;
  f.deps.observeJobAbsence = () => true;
  const wait = new WaitCoordinator(f.deps);
  await expect(wait.waitStreamOnce('missing', 1000)).rejects.toThrow('missing');
  expect(load).toHaveBeenCalledTimes(1);
});

it('reuses the active frontier and decodes only newly appended progress', () => {
  const f = fixture();
  const session = {};
  const read = vi.spyOn(f.deps, 'visitProgress');
  for (let seq = 1; seq <= 1000; seq++)
    f.journal.push({
      ...f.terminal(),
      type: 'progress',
      seq,
      message: `line ${seq}`,
      timing: {
        origin: 'runtime',
        originAt: '2026-10-04T00:00:00.000Z',
        emittedAt: '2026-10-04T00:00:00.000Z',
        elapsedMs: 0,
      },
    });
  f.wait.readWaitAdmissions(['job-1'], 'epoch', session);
  read.mockClear();
  for (let poll = 0; poll < 20; poll++) f.wait.readWaitAdmissions(['job-1'], 'epoch', session);
  expect(read).not.toHaveBeenCalled();
  f.journal.push({ ...f.journal[0], seq: 1001 });
  const next = f.wait.readWaitAdmissions(['job-1'], 'epoch', session);
  expect(read).not.toHaveBeenCalled();
  expect(next[0].detail).not.toHaveProperty('events');
});

it('keeps independent incremental frontiers for separate wait sessions', () => {
  const f = fixture();
  f.journal.push(...admitted('job-1', [[1, 'first']], false).detail.events);
  const read = vi.spyOn(f.deps, 'visitProgress');
  const first = {};
  const second = {};
  const a = f.wait.readWaitAdmissions(['job-1'], 'e', first)[0];
  for (let poll = 0; poll < 20; poll++) f.wait.readWaitAdmissions(['job-1'], 'e', first);
  const b = f.wait.readWaitAdmissions(['job-1'], 'e', second)[0];
  expect(read).not.toHaveBeenCalled();
  expect(a.detail).not.toHaveProperty('events');
  expect(b.detail).not.toHaveProperty('events');
});

it('observes availability once per terminal poll and emits one repair hint', () => {
  const f = fixture();
  f.journal.push(f.terminal());
  f.terminalize();
  const observe = vi.fn(() => ({ kind: 'repair-pending' as const, ageUncertain: false }));
  const hint = vi.fn();
  f.deps.observeResultAvailability = observe;
  f.deps.hintResultRepair = hint;
  const index = new JobLocationIndex(f.runtime, '/state');
  index.register('job-1', 'epoch', { projectRoot: '/project', workDir: '/project', jobKind: 'provider' });
  const addressing = new JobAddressing(
    index.readOnlyView(),
    {
      visitProgress: progressVisitFromDetails(() => null),
      epochKey: () => 'epoch',
      detail: () => null,
      readWaitAdmissions: (ids, epoch, session) => f.wait.readWaitAdmissions(ids, epoch, session),
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'pending',
    undefined,
    observe,
    hint,
  );
  const request = { jobIds: ['job-1'] };
  for (let poll = 0; poll < 20; poll++) addressing.admitWait(request);
  expect(observe).toHaveBeenCalledTimes(20);
  expect(hint).toHaveBeenCalledTimes(20);
});

it('reads projection and history once per unchanged admission frontier and preserves prior arrays', () => {
  const f = fixture();
  const projection = vi.spyOn(f.deps, 'loadJobProjectionDetail');
  const events = vi.spyOn(f.deps, 'visitProgress');
  const session = {};
  const first = f.wait.readWaitAdmission('job-1', 'epoch', session);
  for (let poll = 0; poll < 40; poll++) f.wait.readWaitAdmission('job-1', 'epoch', session);
  expect(projection).toHaveBeenCalledTimes(1);
  expect(events).not.toHaveBeenCalled();
  f.journal.push(f.terminal());
  f.wait.readWaitAdmission('job-1', 'epoch', session);
  expect(projection).toHaveBeenCalledTimes(2);
  expect(first.detail).not.toHaveProperty('events');
});

it.each([false, true])('internal waits answer missing only after explicit absence: %s', (explicitAbsence) => {
  const f = fixture();
  f.deps.loadJobProjectionDetail = () => ({ status: null, launch: null, runtime: null, exit: null });
  f.deps.observeJobAbsence = () => explicitAbsence;
  const admission = f.wait.readWaitAdmission('transferred', 'new-epoch', {});
  expect(admission.disposition).toBe(explicitAbsence ? 'missing' : 'admitted');
  if (!explicitAbsence) expect(admission.sourceRead).toBe('transient-unknown');
});

it('does not keep active history in a coordinator-lifetime cache when no session is supplied', () => {
  const f = fixture();
  f.journal.push(...admitted('job-1', [[1, 'first']], false).detail.events);
  const read = vi.spyOn(f.deps, 'visitProgress');
  for (let poll = 0; poll < 3; poll++) f.wait.readWaitAdmissions(['job-1'], 'epoch');
  expect(read).not.toHaveBeenCalled();
});

it('internal child wait reads its durable historical epoch', async () => {
  const f = fixture();
  f.deps.currentJobEpochKey = () => 'active';
  f.deps.loadJobProjectionDetail = () => ({ status: null, launch: null, runtime: null, exit: null });
  f.deps.observeJobAbsence = () => true;
  f.deps.internalWait = {
    admissions: () => [admitted('child', [], true, 'historical')],
    visitProgress: f.deps.visitProgress,
  };
  const events = [];
  for await (const event of f.wait.waitForOutcomes({ jobIds: ['child'], timeoutSeconds: 0 })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'terminal', jobId: 'child', result: { content: 'child result' } });
});

it('isolates an unreadable active projection from its healthy sibling', () => {
  const f = fixture();
  f.deps.loadJobProjectionDetail = (jobId) => {
    if (jobId === 'damaged') throw new Error('location read denied');
    return { status: admitted('job-1', [], false).detail.status, launch: null, runtime: null, exit: null };
  };
  const admissions = f.wait.readWaitAdmissions(['damaged', 'job-1'], 'epoch', {});
  expect(admissions[0]).toMatchObject({ disposition: 'admitted', sourceRead: 'transient-unknown' });
  expect(admissions[1]).toMatchObject({ jobId: 'job-1', disposition: 'admitted' });
});

it('caches a terminal body per request while unrelated journal writes advance', () => {
  const f = fixture();
  f.journal.push(f.terminal());
  f.terminalize();
  let frontier = 1;
  f.deps.getCurrentJournalSeq = () => frontier;
  const projection = vi.spyOn(f.deps, 'loadJobProjectionDetail');
  const availability = vi.spyOn(f.deps, 'observeResultAvailability');
  const session = {};
  const first = f.wait.readWaitAdmission('job-1', 'epoch', session);
  for (let poll = 0; poll < 30; poll++) {
    frontier++;
    expect(f.wait.readWaitAdmission('job-1', 'epoch', session).detail).toBe(first.detail);
  }
  expect(projection).toHaveBeenCalledTimes(1);
  expect(availability).toHaveBeenCalledTimes(31);
  f.wait.readWaitAdmission('job-1', 'epoch', {});
  expect(projection).toHaveBeenCalledTimes(2);
});

it('settles an active-journal decode failure as unreadable and propagates a code defect', () => {
  const f = fixture();
  f.deps.loadJobProjectionDetail = (jobId) => {
    if (jobId === 'undecodable') throw new StoreCodecError('Current codec rejected stored event', {});
    if (jobId === 'defect') throw new TypeError('defect');
    return { status: admitted(jobId, [], false).detail.status, launch: null, runtime: null, exit: null };
  };
  expect(f.wait.readWaitAdmissions(['undecodable', 'job-1'], 'epoch', {})).toMatchObject([
    { jobId: 'undecodable', disposition: 'outcome-unreadable', sourceRead: 'settled-unreadable' },
    { jobId: 'job-1', disposition: 'admitted' },
  ]);
  expect(() => f.wait.readWaitAdmissions(['defect'], 'epoch', {})).toThrow(TypeError);
});
