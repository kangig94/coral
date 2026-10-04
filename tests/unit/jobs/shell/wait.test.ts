import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';
import { WaitCoordinator, type WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

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
