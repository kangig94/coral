import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';
import { WaitCoordinator, type WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
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
    time: runtime.time,
    eventBus,
    sessionManager: { get: () => ({ activeJobId, state: 'pending', providerContinuity: null }) } as never,
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
    loadJobProjectionDetail: () => {
      const terminal = journal.find((event): event is JobTerminalEvent => event.type === 'terminal');
      return {
        status,
        launch: null,
        runtime: null,
        exit: terminal ? { ...terminal.result, endTime: terminal.ts, diagnostics: { progressFaults: [] } } : null,
      };
    },
    readJobEvents: () => journal,
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
      ).detail!.events,
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
        epochKey: () => 'epoch',
        detail: () => ({ ...admitted('job-1', [], false).detail!, events: f.journal }),
        readWaitAdmission: (id, epoch) => f.wait.readWaitAdmission(id, epoch),
        readWaitAdmissions: (ids, epoch) => f.wait.readWaitAdmissions(ids, epoch),
        observeWaitCarriers: (ids, signal) => f.wait.observeWaitCarriers(ids, signal),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: (request) => f.wait.waitForJobs(request),
      },
      () => false,
      () => 'pending',
    );
    const stream = addressing.waitStream({
      jobIds: ['job-1'],
      supportsWaitV3: true,
      timeoutSeconds: 1,
      cursor: {
        version: 'jobs.wait.v3',
        epochs: [{ token: waitEpochToken('epoch'), watermark: 501, lineOffset: 0 }],
        jobs: [{ hash: waitJobHash('job-1'), epoch: 0, flags: 0 }],
      },
    });
    const next = stream.next();
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
      ).detail!.events,
    );
    let settled = false;
    const result = f.wait.waitStreamOnce('job-1', 1000).finally(() => {
      settled = true;
    });
    const assertion = expect(result).resolves.toMatchObject({ content: 'done' });
    await flushMicrotasks(100);
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
      ).detail!.events,
    );
    let settled = false;
    const result = f.wait.waitStreamOnce('job-1', 1000).finally(() => {
      settled = true;
    });
    const assertion = expect(result).rejects.toThrow('Wait expired');
    await flushMicrotasks(5000);
    expect(settled).toBe(false);
    for (let i = 0; i < 4; i++) {
      f.runtime.time.tick(250);
      await flushMicrotasks(50);
    }
    await assertion;
  });

  it('bounds active sibling progress by one frontier across a between-read commit', async () => {
    const f = fixture();
    let committed = false;
    let frontier = 0;
    f.deps.getCurrentJournalSeq = () => frontier;
    f.deps.loadJobProjectionDetail = (id) => ({
      status: { ...admitted(id, [], false).detail!.status },
      launch: null,
      runtime: null,
      exit: null,
    });
    f.deps.readJobEvents = (id) => {
      const events = admitted(id, committed ? [[id === 'a' ? 1 : 2, `${id} committed`]] : [], false).detail!.events;
      if (id === 'a' && !committed) {
        committed = true;
        frontier = 2;
      }
      return events;
    };
    const events = [];
    for await (const event of f.wait.waitForJobs({ jobIds: ['a', 'b'], supportsWaitV3: true, timeoutSeconds: 0 }))
      events.push(event);
    const cursor = events.at(-1)!.cursor;
    for await (const event of f.wait.waitForJobs({
      jobIds: ['a', 'b'],
      supportsWaitV3: true,
      timeoutSeconds: 0,
      cursor,
    }))
      events.push(event);
    expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual([
      'a committed',
      'b committed',
    ]);
  });
  it('refuses an unavailable legacy artifact instead of naming a file', async () => {
    const f = fixture();
    f.deps.observeResultAvailability = () => ({ kind: 'repair-pending', ageUncertain: false });
    f.journal.push(f.terminal());
    await expect(f.wait.waitForJobs({ jobIds: ['job-1'] }).next()).rejects.toMatchObject({
      code: 'wait_epoch_unsupported',
    });
  });

  it('preserves queued activity when the shared V3 reader has no journal progress', async () => {
    const f = fixture();
    const projected = f.deps.loadJobProjectionDetail('job-1');
    f.deps.loadJobProjectionDetail = () => ({ ...projected, status: { ...projected.status!, phase: 'queued' } });
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], supportsWaitV3: true, timeoutSeconds: 0 });
    expect((await stream.next()).value).toMatchObject({
      type: 'queued',
      jobId: 'job-1',
      jobKind: 'provider',
      sessionId: 'session-1',
      queuePosition: 0,
    });
    expect((await stream.next()).value).toMatchObject({ type: 'waiting', waitingJobIds: ['job-1'] });
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
    const detail = admitted('job-1').detail!;
    f.deps.readJobEvents = () => detail.events;
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
    const next = stream.next();
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
    const next = stream.next();
    await f.pollStarted;
    f.runtime.time.tick(1001);
    expect((await next).value).toEqual({ type: 'waiting', waitingJobIds: ['job-1'], carrierUnknownJobIds: ['job-1'] });
    await stream.return(undefined);
  });

  it('replays a terminal arriving after timeout on the next request with the unchanged cursor', async () => {
    const f = fixture();
    const cursor = { afterSeq: 0 };
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 1, cursor });
    const next = stream.next();
    await f.pollStarted;
    f.runtime.time.tick(1001);
    expect((await next).value).toEqual({ type: 'waiting', waitingJobIds: ['job-1'], carrierUnknownJobIds: ['job-1'] });
    await stream.return(undefined);
    f.journal.push(f.terminal());
    expect(cursor).toEqual({ afterSeq: 0 });
    const resumed = f.wait.waitForJobs({ jobIds: ['job-1'], cursor });
    expect((await resumed.next()).value).toMatchObject({ type: 'terminal', seq: 1 });
    await resumed.return(undefined);
  });
});
