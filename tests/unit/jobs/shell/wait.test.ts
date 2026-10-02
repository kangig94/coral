import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';
import { WaitCoordinator, type WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
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
    loadJobProjectionDetail: () => ({ status, launch: null, runtime: null, exit: null }),
    readJobEvents: () => journal,
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => journal.at(-1)?.seq ?? 0,
    resultJobsRoot: '/results',
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

  it('rechecks persisted state after subscribing', async () => {
    const f = fixture();
    const on = f.eventBus.on.bind(f.eventBus);
    vi.spyOn(f.eventBus, 'on').mockImplementation((...args) => {
      on(...args);
      if (args[0] === 'session:released') {
        f.terminalize();
        f.releaseClaim();
      }
      return f.eventBus;
    });
    await expect(f.wait.waitForJobTerminal('job-1')).resolves.toBeUndefined();
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
    expect((await next).value).toEqual({ type: 'waiting', waitingJobIds: ['job-1'] });
    await stream.return(undefined);
  });

  it('replays a terminal arriving after timeout on the next request with the unchanged cursor', async () => {
    const f = fixture();
    const cursor = { afterSeq: 0 };
    const stream = f.wait.waitForJobs({ jobIds: ['job-1'], timeoutSeconds: 1, cursor });
    const next = stream.next();
    await f.pollStarted;
    f.runtime.time.tick(1001);
    expect((await next).value).toEqual({ type: 'waiting', waitingJobIds: ['job-1'] });
    await stream.return(undefined);
    f.journal.push(f.terminal());
    expect(cursor).toEqual({ afterSeq: 0 });
    const resumed = f.wait.waitForJobs({ jobIds: ['job-1'], cursor });
    expect((await resumed.next()).value).toMatchObject({ type: 'terminal', seq: 1 });
    await resumed.return(undefined);
  });
});
