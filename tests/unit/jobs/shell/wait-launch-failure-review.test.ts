import { describe, expect, it } from 'vitest';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { JobEvent, JobStatus, JobTerminalEvent } from '#src/jobs/records.js';
import { WaitCoordinator, type WaitCoordinatorDeps } from '#src/jobs/shell/wait.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('workflow readLaunchFailure uses the legacy WaitCoordinator path', () => {
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
      result: { content: '', durationMs: 0, outcome: { kind: 'provider_exit', code: 2, note: 'auth failed' } } as never,
    };
    const journal: JobEvent[] = [terminal];
    const deps: WaitCoordinatorDeps = {
      time: runtime.time,
      eventBus: new TypedEventBus(),
      sessionManager: { get: () => ({ activeJobId: undefined, state: 'pending', providerContinuity: null }) } as never,
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
      loadJobProjectionDetail: () =>
        ({
          status,
          launch: null,
          runtime: null,
          exit: { ...terminal.result, endTime: terminal.ts, diagnostics: { progressFaults: [] } },
        }) as never,
      readJobEvents: () => journal,
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
