import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import { type WaitStreamEvent, serializeWaitCursor } from '#src/jobs/wait.js';
import type { BackendRoutingResult } from '#src/infra/backend-routing.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { openStoreDatabase } from '#src/store/db.js';
import { storePaths } from '#src/infra/path/store.js';
import type * as FollowMod from '#src/cli/follow.js';
import { buildErrorEnvelope } from '#src/cli/errors.js';
import { formatLaunch } from '#src/cli/format/jobs.js';
import { formatWaitProgress, formatWaitQueued, formatWaitTerminal } from '#src/cli/format/wait.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  runHandoff: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/coordinator/handoff-runner.js', () => ({
  runHandoff: mockState.runHandoff,
}));

type FollowModule = typeof FollowMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

function makeBackend(instanceId = 'backend-1') {
  const routing = {
    kind: 'use-current',
  } satisfies BackendRoutingResult;
  return {
    socketPath: '/tmp/coordinator.sock',
    instanceId,
    bundleHash: 'test-hash',
    flavor: 'prod' as const,
    namespace: 'test-namespace',
    host: '127.0.0.1',
    port: 4100,
    token: 'backend-token',
    version: '0.5.2',
    routing,
    request: vi.fn(),
    subscribe: mockState.subscribe,
    health: vi.fn(),
    shutdown: vi.fn(),
  };
}

const waitTiming = {
  origin: 'runtime',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

function makeProgressEvent(message = 'Still running'): Extract<WaitStreamEvent, { type: 'progress' }> {
  return {
    type: 'progress',
    jobId: 'job-1',
    seq: 1,
    message,
    timing: waitTiming,
  };
}

function makeQueuedEvent(): Extract<WaitStreamEvent, { type: 'queued' }> {
  return {
    type: 'queued',
    jobKind: 'provider',
    jobId: 'job-1',
    sessionId: 'session-1',
    queuePosition: 2,
    runningJobIds: ['job-9'],
    timing: { ...waitTiming, origin: 'queued' },
  };
}

function makeRunningEvent(): Extract<WaitStreamEvent, { type: 'waiting' }> {
  return {
    type: 'waiting',
    waitingJobIds: ['job-1'],
  };
}

function makeTerminalEvent(
  result: Record<string, unknown> = {},
  overrides: Partial<Extract<WaitStreamEvent, { type: 'terminal' }>> = {},
): Extract<WaitStreamEvent, { type: 'terminal' }> {
  return {
    type: 'terminal',
    jobId: 'job-1',
    seq: 1,
    remainingJobIds: [],
    resultPath: '/tmp/result.md',
    result: {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 0,
      ...result,
    } as Extract<WaitStreamEvent, { type: 'terminal' }>['result'],
    ...overrides,
  };
}

type TestLaunchAndFollowOptions = {
  launchResult: AcceptedLaunchResponse;
  abortJob: (jobId: string) => Promise<unknown>;
  pluginRoot: string;
  projectRoot: string;
  emitError: (error: unknown) => void;
  isTTY: boolean;
  columns: number;
  backoffScheduler?: (delayMs: number) => Promise<void>;
};

function makeOptions(overrides: Partial<TestLaunchAndFollowOptions> = {}): TestLaunchAndFollowOptions {
  return {
    launchResult: {
      kind: 'provider-session',
      launchState: 'running',
      jobId: 'job-1',
      sessionId: 'session-1',
    } satisfies AcceptedLaunchResponse,
    abortJob: async () => undefined,
    pluginRoot: '/plugin/root',
    projectRoot: '/project/root',
    emitError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(message + '\n');
      process.exitCode = 70;
    },
    isTTY: false,
    columns: 80,
    ...overrides,
  };
}

function makeSubscription(generatorFactory: () => AsyncGenerator<WaitStreamEvent>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: generatorFactory,
  };
}

type WorkflowChildFixture = Readonly<{
  jobId: string;
  workflowJobId: string;
  workflowSlotId: string;
  generation: number;
}>;

function createCauseRenderFixture(workflowChildren: readonly WorkflowChildFixture[] = []): {
  home: string;
  pluginRoot: string;
  cleanup(): void;
} {
  const home = mkdtempSync(join(tmpdir(), 'coral-follow-home-'));
  const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-follow-plugin-'));

  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: 'test-hash', flavor: 'prod' }),
    'utf-8',
  );

  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePaths('prod', { baseDir: join(home, '.coral') }).dbFile,
    storage: runtime.storage,
  });

  try {
    const insertEvent = db.prepare(
      `INSERT INTO events (
        seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
    );
    insertEvent.run(
      1,
      '2026-03-21T00:00:00.000Z',
      'workflow.completed',
      'workflow',
      'workflow-1',
      Buffer.from(
        JSON.stringify({
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow', id: 'workflow-1' }, seq: 2 },
          stepDetails: [],
        }),
        'utf-8',
      ),
    );
    insertEvent.run(
      2,
      '2026-03-21T00:00:00.000Z',
      'workflow.lifecycle_fault',
      'workflow',
      'workflow-1',
      Buffer.from(JSON.stringify({ kind: 'unknown', message: 'workflow failure' }), 'utf-8'),
    );
    insertEvent.run(
      3,
      '2026-03-21T00:00:00.000Z',
      'job.progress.emitted',
      'job',
      'job-activation-unknown',
      Buffer.from(
        JSON.stringify({
          kind: 'domain',
          stage: 'provider_operation_failed',
          message: 'Provider containment disappeared after activation may have begun.',
          detail: { code: 'activation_indeterminate' },
        }),
        'utf-8',
      ),
    );

    const insertProjection = db.prepare(
      `INSERT INTO projection_jobs (
        job_id, execution_owner, phase, terminal, diagnostics, session_id, provider,
        project_root, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
        workflow_slot, workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
      ) VALUES (?, ?, 'running', NULL, ?, ?, 'codex', ?, 'test-namespace', NULL, 'provider', ?, ?, ?, NULL, ?, 0)`,
    );
    for (const child of workflowChildren) {
      insertProjection.run(
        child.jobId,
        JSON.stringify({ kind: 'workflow', id: child.workflowJobId }),
        JSON.stringify({ progressFaults: [] }),
        `session-${child.jobId}`,
        '/project/root',
        child.workflowJobId,
        child.workflowSlotId,
        child.generation,
        '2026-03-21T00:00:00.000Z',
      );
    }
  } finally {
    db.close();
  }

  return {
    home,
    pluginRoot,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    },
  };
}

// `cli/follow.js` is a pure-function module; no module-level state mutates
// per test. Cache once and reuse. Tests that change `process.env.HOME` and
// need module-load-time env capture must call `loadFollowModuleFresh()`.
let cachedFollowModule: FollowModule | null = null;
async function loadFollowModule(): Promise<FollowModule> {
  cachedFollowModule ??= await import('#src/cli/follow.js');
  return cachedFollowModule;
}
async function loadFollowModuleFresh(): Promise<FollowModule> {
  vi.resetModules();
  cachedFollowModule = null;
  return loadFollowModule();
}

describe('cli follow', () => {
  let stdout = '';
  let stderr = '';
  let sigintHandler: (() => void) | null = null;

  beforeEach(() => {
    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');
    stdout = '';
    stderr = '';
    sigintHandler = null;
    process.exitCode = undefined;
    mockState.ensure.mockReset();
    mockState.runHandoff.mockReset().mockResolvedValue({ kind: 'run-current' });
    mockState.subscribe.mockReset();

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      stdout += toText(chunk);
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += toText(chunk);
      return true;
    }) as typeof process.stderr.write);

    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') {
        sigintHandler = listener as () => void;
      }
      return process;
    }) as typeof process.on);

    vi.spyOn(process, 'off').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT' && sigintHandler === listener) {
        sigintHandler = null;
      }
      return process;
    }) as typeof process.off);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('rejects incomplete child credentials before coordinator ensure', async () => {
    vi.stubEnv('CORAL_CHILD', '1');
    const { launchAndFollow } = await loadFollowModule();

    await expect(launchAndFollow(makeOptions())).rejects.toThrow(
      'This nested Coral command has incomplete child credentials and was not sent.',
    );
    expect(mockState.ensure).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });

  it('writes launch output and a path-first terminal summary in text mode', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const backend = makeBackend();
    const options = makeOptions();
    const terminalEvent = makeTerminalEvent();
    const terminalCursor = serializeWaitCursor({ afterSeq: 1 });

    mockState.ensure.mockResolvedValueOnce(backend);
    mockState.subscribe.mockResolvedValueOnce(
      makeSubscription(async function* () {
        yield terminalEvent;
      }),
    );

    await expect(launchAndFollow(options)).resolves.toBe(0);

    expect(stdout).toBe(
      `${formatLaunch(options.launchResult)}\n${formatWaitTerminal(terminalEvent, terminalCursor, false)}\n`,
    );
    expect(stderr).toBe('');
    expect(mockState.ensure).toHaveBeenCalledWith('/plugin/root');
    expect(mockState.subscribe).toHaveBeenCalledWith(
      'jobs.wait',
      {
        jobIds: ['job-1'],
        // The Bash tool's 600s ceiling minus the flush margin that lets a bounded wait write its resume
        // cursor before being killed — asserted as the derived value, not as a round number.
        timeoutSeconds: 590,
        projectRoot: '/project/root',
        supportsInterrupted: true,
      },
      {
        timeoutMs: 3_000,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('emits launch, queued, progress, waiting, and terminal text output with cursor resume', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const launchResult = {
      kind: 'provider-session',
      launchState: 'queued',
      jobId: 'job-1',
      sessionId: 'session-1',
    } satisfies AcceptedLaunchResponse;
    const queuedEvent = makeQueuedEvent();
    const progressEvent = makeProgressEvent('Halfway there');
    const waitingEvent = makeRunningEvent();
    const terminalEvent = makeTerminalEvent(
      { content: 'secret result body' },
      { seq: 2, usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.01 } },
    );
    const cursorAfterProgress = serializeWaitCursor({ afterSeq: 1 });
    const cursorAfterTerminal = serializeWaitCursor({ afterSeq: 2 });

    mockState.ensure.mockResolvedValueOnce(makeBackend('backend-1')).mockResolvedValueOnce(makeBackend('backend-2'));
    mockState.subscribe
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toBeUndefined();
        return makeSubscription(async function* () {
          yield queuedEvent;
          yield progressEvent;
          yield waitingEvent;
        });
      })
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toEqual({ afterSeq: 1 });
        return makeSubscription(async function* () {
          yield progressEvent;
          yield terminalEvent;
        });
      });

    await expect(launchAndFollow(makeOptions({ launchResult }))).resolves.toBe(0);

    expect(stdout).toBe(
      `${formatLaunch(launchResult)}\n` +
        `${formatWaitQueued(queuedEvent)}\n` +
        `${formatWaitProgress(progressEvent)}\n` +
        `Still waiting on 1 job. Run coral-cli wait jobs job-1 to continue waiting. (cursor: ${cursorAfterProgress})\n` +
        `${formatWaitTerminal(terminalEvent, cursorAfterTerminal, false)}\n`,
    );
    expect(mockState.ensure).toHaveBeenCalledTimes(2);
    expect(stdout.match(/Halfway there/gu)).toHaveLength(1);
  });

  it('skips a wait stream event of an unrecognized type and keeps the stream alive', async () => {
    // Reproduces an N-build CLI reading an N+1 coordinator's event: the wire delivers a `type` this build
    // never registered. `followJobs` must not crash rendering it (no `undefined` in the output) and must
    // not end the wait early — the following legitimate terminal event still has to arrive.
    const { followJobs } = await loadFollowModule();
    const terminalEvent = makeTerminalEvent();

    const exitCode = await followJobs({
      start: { kind: 'jobs', jobIds: ['job-1'] },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project/root',
      emitError: vi.fn(),
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs: vi.fn(),
      connect: async () => ({
        kind: 'subscription',
        subscription: makeSubscription(async function* () {
          yield { type: 'some-future-event' } as unknown as WaitStreamEvent;
          yield terminalEvent;
        }),
      }),
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('undefined');
    expect(stdout).toContain('Job job-1 completed');
  });

  it('reconnects silently on a successful terminal event with jobs remaining, printing no continuation line', async () => {
    const { followJobs } = await loadFollowModule();
    // `seq` is a global journal cursor, not per-job — the second event must advance past the first or the
    // render cursor treats it as already-seen and suppresses it.
    const firstTerminal = makeTerminalEvent({}, { jobId: 'job-1', seq: 1, remainingJobIds: ['job-2'] });
    const secondTerminal = makeTerminalEvent({}, { jobId: 'job-2', seq: 2, remainingJobIds: [] });

    const connect = vi
      .fn()
      .mockImplementationOnce(async () => ({
        kind: 'subscription' as const,
        subscription: makeSubscription(async function* () {
          yield firstTerminal;
        }),
      }))
      .mockImplementationOnce(async ({ jobIds }: { jobIds: readonly string[] }) => {
        expect(jobIds).toEqual(['job-2']);
        return {
          kind: 'subscription' as const,
          subscription: makeSubscription(async function* () {
            yield secondTerminal;
          }),
        };
      });

    const exitCode = await followJobs({
      start: { kind: 'jobs', jobIds: ['job-1', 'job-2'] },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project/root',
      emitError: vi.fn(),
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs: vi.fn(),
      connect,
    });

    expect(exitCode).toBe(0);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(stdout).toContain('Job job-1 completed');
    expect(stdout).toContain('Job job-2 completed');
    expect(stdout).not.toContain('to continue waiting');
  });

  it('reports which jobs are still live on an early non-zero exit, in both embed and non-embed output', async () => {
    const failingTerminal = makeTerminalEvent(
      { outcome: { kind: 'aborted', reason: 'signal_abort' } },
      { jobId: 'job-1', remainingJobIds: ['job-2'] },
    );

    for (const embed of [false, true]) {
      const { followJobs } = await loadFollowModule();
      stdout = '';
      const connect = vi.fn().mockResolvedValueOnce({
        kind: 'subscription' as const,
        subscription: makeSubscription(async function* () {
          yield failingTerminal;
        }),
      });

      const exitCode = await followJobs({
        start: { kind: 'jobs', jobIds: ['job-1', 'job-2'] },
        reconnectPolicy: 'until-terminal',
        projectRoot: '/project/root',
        emitError: vi.fn(),
        render: { isTTY: false, columns: 80, embed, verbose: false },
        abortJobs: vi.fn(),
        connect,
      });

      expect(exitCode).toBe(1);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('Run coral-cli wait jobs job-2 to continue waiting.');
    }
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'emits an exact resume command when a delegated wait ends from %s',
    async (signal) => {
      const { followJobs } = await loadFollowModule();
      const cursor = serializeWaitCursor({ afterSeq: 7 });
      const emitError = vi.fn();

      const exitCode = await followJobs({
        start: { kind: 'jobs', jobIds: ['job-2', 'job-3'], serializedCursor: cursor },
        reconnectPolicy: 'until-terminal',
        projectRoot: '/project/root',
        emitError,
        render: { isTTY: false, columns: 80, embed: false, verbose: false },
        abortJobs: vi.fn(),
        connect: async () => ({
          kind: 'delegated',
          outcome: { kind: 'handoff-signal', signal },
        }),
      });

      expect(exitCode).toBe(75);
      expect(emitError).toHaveBeenCalledOnce();
      expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
        envelope: {
          error: true,
          code: 'transient',
          message: `Delegated wait command ended from signal ${signal}; the jobs may still be running.`,
          remediation: `Rerun \`coral-cli wait jobs job-2 job-3 --cursor ${cursor}\` to continue waiting.`,
        },
        exitCode: 75,
      });
    },
  );

  it.each(['SIGKILL', 'SIGQUIT', 'SIGINT'] as const)(
    'emits an exact resume command when a delegated wait separately ends from %s',
    async (signal) => {
      const { followJobs } = await loadFollowModule();
      const cursor = serializeWaitCursor({ afterSeq: 7 });
      const emitError = vi.fn();

      const exitCode = await followJobs({
        start: { kind: 'jobs', jobIds: ['job-2', 'job-3'], serializedCursor: cursor },
        reconnectPolicy: 'until-terminal',
        projectRoot: '/project/root',
        emitError,
        render: { isTTY: false, columns: 80, embed: false, verbose: false },
        abortJobs: vi.fn(),
        connect: async () => ({
          kind: 'delegated',
          outcome: { kind: 'handoff-signal', signal },
        }),
      });

      expect(exitCode).toBe(75);
      expect(emitError).toHaveBeenCalledOnce();
      expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
        envelope: {
          error: true,
          code: 'transient',
          message: `Delegated wait command ended from signal ${signal}; the jobs may still be running.`,
          remediation: `Rerun \`coral-cli wait jobs job-2 job-3 --cursor ${cursor}\` to continue waiting.`,
        },
        exitCode: 75,
      });
    },
  );

  it('emits the remaining jobs and current cursor when a progressed stream ends before terminal', async () => {
    const { followJobs } = await loadFollowModule();
    const progressEvent = makeProgressEvent('Checkpoint reached');
    const cursor = serializeWaitCursor({ afterSeq: 1 });
    const emitError = vi.fn();
    const subscription = makeSubscription(async function* () {
      yield progressEvent;
    });

    const exitCode = await followJobs({
      start: { kind: 'jobs', jobIds: ['job-1', 'job-2'] },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project/root',
      emitError,
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs: vi.fn(),
      connect: async () => ({ kind: 'subscription', subscription }),
    });

    expect(exitCode).toBe(75);
    expect(subscription.close).toHaveBeenCalledOnce();
    expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
      envelope: {
        error: true,
        code: 'transient',
        message: 'The wait stream ended before a terminal event; the jobs may still be running.',
        remediation: `Rerun \`coral-cli wait jobs job-1 job-2 --cursor ${cursor}\` to continue waiting.`,
      },
      exitCode: 75,
    });
  });

  it('retries transient stream failures with a 1s backoff and resumes from the current cursor', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const options = makeOptions();
    const progressEvent = makeProgressEvent('Booting');
    const terminalEvent = makeTerminalEvent({ outcome: { kind: 'provider_exit', code: 7 } }, { seq: 2 });
    const cursorAfterTerminal = serializeWaitCursor({ afterSeq: 2 });
    const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);

    mockState.ensure.mockResolvedValueOnce(makeBackend('backend-1')).mockResolvedValueOnce(makeBackend('backend-2'));
    mockState.subscribe
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toBeUndefined();
        return makeSubscription(async function* () {
          yield progressEvent;
          throw new TypeError('terminated');
        });
      })
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toEqual({ afterSeq: 1 });
        return makeSubscription(async function* () {
          yield terminalEvent;
        });
      });

    await expect(launchAndFollow({ ...options, backoffScheduler })).resolves.toBe(7);

    expect(stdout).toBe(
      `${formatLaunch(options.launchResult)}\n` +
        `${formatWaitProgress(progressEvent)}\n` +
        `${formatWaitTerminal(terminalEvent, cursorAfterTerminal, false)}\n`,
    );
    expect(stderr).toBe('');
    expect(backoffScheduler).toHaveBeenCalledTimes(1);
    expect(backoffScheduler).toHaveBeenCalledWith(1_000);
    expect(mockState.ensure).toHaveBeenCalledTimes(2);
    expect(mockState.subscribe).toHaveBeenCalledTimes(2);
  });

  it('retries a malformed recognized wait event twice, then emits authored upgrade and resume guidance', async () => {
    const { followJobs } = await loadFollowModule();
    const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);
    const emitError = vi.fn();
    const cursor = serializeWaitCursor({ afterSeq: 0 });
    const connect = vi.fn(async () => ({
      kind: 'subscription' as const,
      subscription: makeSubscription(async function* () {
        yield { type: 'progress' } as unknown as WaitStreamEvent;
      }),
    }));

    const exitCode = await followJobs({
      start: { kind: 'jobs', jobIds: ['job-1'] },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project/root',
      emitError,
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs: vi.fn(),
      connect,
      backoffScheduler,
    });

    expect(exitCode).toBe(75);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(backoffScheduler).toHaveBeenCalledTimes(2);
    expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
      envelope: {
        error: true,
        code: 'transient',
        message:
          'The coordinator emitted a wait event this Coral build could not read. Rerun the command; if this keeps happening, upgrade the installed Coral plugin.',
        remediation: `Rerun \`coral-cli wait jobs job-1 --cursor ${cursor}\` to continue waiting.`,
      },
      exitCode: 75,
    });
  });

  it('emits the current cursor after transient subscription failures exhaust their retries', async () => {
    const { followJobs } = await loadFollowModule();
    const progressEvent = makeProgressEvent('Checkpoint reached');
    const cursor = serializeWaitCursor({ afterSeq: 1 });
    const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);
    const emitError = vi.fn();
    let emitProgress = true;
    const connect = vi.fn(async () => {
      const shouldEmitProgress = emitProgress;
      emitProgress = false;
      return {
        kind: 'subscription' as const,
        subscription: makeSubscription(async function* () {
          if (shouldEmitProgress) {
            yield progressEvent;
          }
          throw new TypeError('terminated');
        }),
      };
    });

    const exitCode = await followJobs({
      start: { kind: 'jobs', jobIds: ['job-1', 'job-2'] },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project/root',
      emitError,
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs: vi.fn(),
      connect,
      backoffScheduler,
    });

    expect(exitCode).toBe(75);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(backoffScheduler).toHaveBeenCalledTimes(2);
    expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
      envelope: {
        error: true,
        code: 'transient',
        message: 'terminated',
        remediation: `Rerun \`coral-cli wait jobs job-1 job-2 --cursor ${cursor}\` to continue waiting.`,
      },
      exitCode: 75,
    });
  });

  it('returns the emitted envelope exit code on non-transient stream failures without retrying', async () => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensure.mockResolvedValueOnce(makeBackend());
    mockState.subscribe.mockResolvedValueOnce(
      makeSubscription(async function* () {
        throw new Error('fatal wait failure');
      }),
    );

    await expect(launchAndFollow(makeOptions())).resolves.toBe(70);

    expect(stdout).toBe('Provider job job-1 launch accepted (provider session session-1)\n');
    expect(stderr).toBe('fatal wait failure\n');
    expect(process.exitCode).toBe(70);
    expect(mockState.ensure).toHaveBeenCalledTimes(1);
    expect(mockState.subscribe).toHaveBeenCalledTimes(1);
  });

  it('emits the current cursor when BackendUnreachableError exhausts reconnect attempts after progress', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const { BackendUnreachableError } = await import('#src/infra/http-errors.js');
    const progressEvent = makeProgressEvent('Checkpoint reached');
    const waitingEvent = makeRunningEvent();
    const cursor = serializeWaitCursor({ afterSeq: 1 });
    const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);
    const emitError = vi.fn();

    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.subscribe
      .mockResolvedValueOnce(
        makeSubscription(async function* () {
          yield progressEvent;
          yield waitingEvent;
        }),
      )
      .mockRejectedValueOnce(new BackendUnreachableError('fetch failed'))
      .mockRejectedValueOnce(new BackendUnreachableError('fetch failed'))
      .mockRejectedValueOnce(new BackendUnreachableError('fetch failed'));

    const options = makeOptions({
      emitError,
      backoffScheduler,
    });

    await expect(launchAndFollow(options)).resolves.toBe(75);

    expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
      envelope: {
        error: true,
        code: 'transient',
        message: 'fetch failed',
        remediation: `Rerun \`coral-cli wait jobs job-1 --cursor ${cursor}\` to continue waiting.`,
      },
      exitCode: 75,
    });
    expect(backoffScheduler).toHaveBeenCalledTimes(2);
    expect(backoffScheduler).toHaveBeenNthCalledWith(1, 1_000);
    expect(backoffScheduler).toHaveBeenNthCalledWith(2, 1_000);
    expect(mockState.ensure).toHaveBeenCalledTimes(4);
    expect(mockState.subscribe).toHaveBeenCalledTimes(4);
  });

  it.each(['backend_recovering', 'backend_shutting_down'])(
    'prints a cursor-free resume command when initial %s retries are exhausted',
    async (code) => {
      const { launchAndFollow } = await loadFollowModule();
      const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);
      const emitError = vi.fn();
      const subscriptionError = new Error('Backend is not accepting wait subscriptions.', {
        cause: { code, message: 'Backend is not accepting wait subscriptions.' },
      });

      mockState.ensure.mockResolvedValue(makeBackend());
      mockState.subscribe.mockRejectedValue(subscriptionError);

      await expect(launchAndFollow(makeOptions({ emitError, backoffScheduler }))).resolves.toBe(75);

      expect(buildErrorEnvelope(emitError.mock.calls[0]?.[0])).toEqual({
        envelope: {
          error: true,
          code: 'transient',
          message: 'Backend is not accepting wait subscriptions.',
          remediation: 'Rerun `coral-cli wait jobs job-1` to continue waiting.',
        },
        exitCode: 75,
      });
      expect(backoffScheduler).toHaveBeenCalledTimes(2);
      expect(mockState.subscribe).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['launch-follow', 'wait'] as const)(
    'prints backend recovery commands when %s exhausts initial connection attempts',
    async (path) => {
      const { followJobs, launchAndFollow } = await loadFollowModule();
      const { BackendUnreachableError } = await import('#src/infra/http-errors.js');
      const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);
      let renderedError = '';
      const emitError = vi.fn((error: unknown) => {
        expect(error).toBeInstanceOf(BackendUnreachableError);
        renderedError = (error as Error).message;
        process.exitCode = 69;
      });

      if (path === 'launch-follow') {
        mockState.ensure.mockResolvedValue(makeBackend());
        mockState.subscribe.mockRejectedValue(new BackendUnreachableError('fetch failed'));
        await expect(launchAndFollow(makeOptions({ emitError, backoffScheduler }))).resolves.toBe(69);
      } else {
        await expect(
          followJobs({
            start: { kind: 'jobs', jobIds: ['job-1'] },
            reconnectPolicy: 'bounded',
            connect: async () => {
              throw new BackendUnreachableError('fetch failed');
            },
            abortJobs: async () => undefined,
            projectRoot: '/project/root',
            emitError,
            render: { isTTY: false, columns: 80, embed: false, verbose: false },
            backoffScheduler,
          }),
        ).resolves.toBe(69);
      }

      expect(emitError).toHaveBeenCalledOnce();
      expect(renderedError).toContain('Run `coral-cli backend status` and follow its recovery guidance');
      expect(renderedError).toContain('`coral-cli wait jobs job-1` to continue waiting');
      expect(backoffScheduler).toHaveBeenCalledTimes(2);
      if (path === 'launch-follow') {
        expect(mockState.ensure).toHaveBeenCalledTimes(3);
        expect(mockState.subscribe).toHaveBeenCalledTimes(3);
      }
    },
  );

  it('warns on first SIGINT, aborts on second SIGINT, and calls abortJob once', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const started = createDeferred<void>();
    const abortJob = vi.fn().mockResolvedValue(undefined);

    mockState.ensure.mockResolvedValueOnce(makeBackend());
    mockState.subscribe.mockImplementationOnce(
      async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
        makeSubscription(async function* () {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true });
          });
        }),
    );

    const followPromise = launchAndFollow(makeOptions({ abortJob }));
    await started.promise;

    expect(sigintHandler).not.toBeNull();
    sigintHandler?.();
    sigintHandler?.();

    await expect(followPromise).resolves.toBe(1);

    expect(stdout).toBe('Provider job job-1 launch accepted (provider session session-1)\n');
    expect(stderr).toBe('\nPress Ctrl+C again to abort the job.\n');
    expect(abortJob).toHaveBeenCalledTimes(1);
    expect(abortJob).toHaveBeenCalledWith('job-1');
    expect(mockState.ensure).toHaveBeenCalledTimes(1);
    expect(mockState.subscribe).toHaveBeenCalledTimes(1);
    expect(process.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('warns on first SIGINT and aborts every bounded-wait job on the second', async () => {
    const { followJobs } = await loadFollowModule();
    const started = createDeferred<void>();
    const abortJobs = vi.fn().mockResolvedValue(undefined);

    const followPromise = followJobs({
      start: { kind: 'jobs', jobIds: ['job-1', 'job-2'] },
      reconnectPolicy: 'bounded',
      projectRoot: '/project/root',
      emitError: vi.fn(),
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      abortJobs,
      connect: async ({ signal }) => ({
        kind: 'subscription',
        subscription: makeSubscription(async function* () {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true });
          });
        }),
      }),
    });
    await started.promise;

    sigintHandler?.();
    expect(stderr).toBe('\nPress Ctrl+C again to abort the job.\n');
    expect(abortJobs).not.toHaveBeenCalled();

    sigintHandler?.();
    await expect(followPromise).resolves.toBe(1);

    expect(abortJobs).toHaveBeenCalledOnce();
    expect(abortJobs).toHaveBeenCalledWith(['job-1', 'job-2']);
  });

  it.each([
    [{}, 0],
    [{}, 0],
    [{}, 0],
    [{ outcome: { kind: 'provider_exit' as const, code: 256 } }, 1],
    [{ outcome: { kind: 'provider_exit' as const, code: 1.5 } }, 1],
    [{ outcome: { kind: 'aborted' as const, reason: 'signal_abort' as const } }, 1],
  ])('maps terminal result %j to exit code %i', async (result, expected) => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensure.mockResolvedValueOnce(makeBackend());
    mockState.subscribe.mockResolvedValueOnce(
      makeSubscription(async function* () {
        yield makeTerminalEvent(result);
      }),
    );

    await expect(launchAndFollow(makeOptions())).resolves.toBe(expected);
  });

  it('labels opaque workflow child ids with their durable slots while waiting on multiple jobs', async () => {
    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const architectJobId = '11111111-1111-4111-8111-111111111111';
    const criticJobId = '33333333-3333-4333-8333-333333333333';
    const architectSlot = `${workflowJobId}:0:0`;
    const criticSlot = `${workflowJobId}:0:1`;
    const fixture = createCauseRenderFixture([
      { jobId: architectJobId, workflowJobId, workflowSlotId: architectSlot, generation: 0 },
      { jobId: criticJobId, workflowJobId, workflowSlotId: criticSlot, generation: 0 },
    ]);
    const originalHome = process.env.HOME;
    const originalTmpdir = process.env.TMPDIR;

    try {
      process.env.HOME = fixture.home;
      process.env.TMPDIR = fixture.home;
      const { followJobs } = await loadFollowModuleFresh();
      const connect = vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'subscription' as const,
          subscription: makeSubscription(async function* () {
            yield { ...makeProgressEvent('Architect running'), jobId: architectJobId };
            yield makeTerminalEvent({}, { jobId: architectJobId, seq: 2, remainingJobIds: [criticJobId] });
          }),
        })
        .mockResolvedValueOnce({
          kind: 'subscription' as const,
          subscription: makeSubscription(async function* () {
            yield { ...makeProgressEvent('Critic running'), jobId: criticJobId, seq: 3 };
            yield makeTerminalEvent({}, { jobId: criticJobId, seq: 4, remainingJobIds: [] });
          }),
        });

      await expect(
        followJobs({
          start: { kind: 'jobs', jobIds: [architectJobId, criticJobId] },
          reconnectPolicy: 'until-terminal',
          projectRoot: '/project/root',
          emitError: vi.fn(),
          render: { isTTY: false, columns: 120, embed: false, verbose: false },
          abortJobs: vi.fn(),
          connect,
        }),
      ).resolves.toBe(0);

      expect(stdout).toContain('j0 · slot 0:0 (g0) - Architect running');
      expect(stdout).toContain('j1 · slot 0:1 (g0) - Critic running');
      expect(stdout).toContain(`Job ${architectJobId} (slot 0:0 (g0)) completed`);
      expect(stdout).toContain(`Job ${criticJobId} (slot 0:1 (g0)) completed`);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      fixture.cleanup();
    }
  });

  it('keeps identical slot positions unique when waiting across workflows', async () => {
    const firstWorkflowJobId = '22222222-2222-4222-8222-222222222222';
    const secondWorkflowJobId = '44444444-4444-4444-8444-444444444444';
    const firstJobId = '11111111-1111-4111-8111-111111111111';
    const secondJobId = '33333333-3333-4333-8333-333333333333';
    const fixture = createCauseRenderFixture([
      {
        jobId: firstJobId,
        workflowJobId: firstWorkflowJobId,
        workflowSlotId: `${firstWorkflowJobId}:0:0`,
        generation: 0,
      },
      {
        jobId: secondJobId,
        workflowJobId: secondWorkflowJobId,
        workflowSlotId: `${secondWorkflowJobId}:0:0`,
        generation: 0,
      },
    ]);
    const originalHome = process.env.HOME;
    const originalTmpdir = process.env.TMPDIR;

    try {
      process.env.HOME = fixture.home;
      process.env.TMPDIR = fixture.home;
      const { followJobs } = await loadFollowModuleFresh();
      const connect = vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'subscription' as const,
          subscription: makeSubscription(async function* () {
            yield { ...makeProgressEvent('First workflow running'), jobId: firstJobId };
            yield { ...makeProgressEvent('Second workflow running'), jobId: secondJobId, seq: 2 };
            yield makeTerminalEvent({}, { jobId: firstJobId, seq: 3, remainingJobIds: [secondJobId] });
          }),
        })
        .mockResolvedValueOnce({
          kind: 'subscription' as const,
          subscription: makeSubscription(async function* () {
            yield makeTerminalEvent({}, { jobId: secondJobId, seq: 4, remainingJobIds: [] });
          }),
        });

      await expect(
        followJobs({
          start: { kind: 'jobs', jobIds: [firstJobId, secondJobId] },
          reconnectPolicy: 'until-terminal',
          projectRoot: '/project/root',
          emitError: vi.fn(),
          render: { isTTY: false, columns: 120, embed: false, verbose: false },
          abortJobs: vi.fn(),
          connect,
        }),
      ).resolves.toBe(0);

      expect(stdout).toContain('j0 · slot 0:0 (g0) - First workflow running');
      expect(stdout).toContain('j1 · slot 0:0 (g0) - Second workflow running');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      fixture.cleanup();
    }
  });

  it('labels progress and terminal output for a single workflow child', async () => {
    const workflowJobId = '22222222-2222-4222-8222-222222222222';
    const childJobId = '11111111-1111-4111-8111-111111111111';
    const fixture = createCauseRenderFixture([
      {
        jobId: childJobId,
        workflowJobId,
        workflowSlotId: `${workflowJobId}:0:0`,
        generation: 0,
      },
    ]);
    const originalHome = process.env.HOME;
    const originalTmpdir = process.env.TMPDIR;

    try {
      process.env.HOME = fixture.home;
      process.env.TMPDIR = fixture.home;
      const { followJobs } = await loadFollowModuleFresh();

      await expect(
        followJobs({
          start: { kind: 'jobs', jobIds: [childJobId] },
          reconnectPolicy: 'until-terminal',
          projectRoot: '/project/root',
          emitError: vi.fn(),
          render: { isTTY: false, columns: 120, embed: false, verbose: false },
          abortJobs: vi.fn(),
          connect: async () => ({
            kind: 'subscription',
            subscription: makeSubscription(async function* () {
              yield { ...makeProgressEvent('Only child running'), jobId: childJobId };
              yield makeTerminalEvent({}, { jobId: childJobId, seq: 2, remainingJobIds: [] });
            }),
          }),
        }),
      ).resolves.toBe(0);

      expect(stdout).toContain('slot 0:0 (g0) - Only child running');
      expect(stdout).toContain(`Job ${childJobId} (slot 0:0 (g0)) completed`);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      fixture.cleanup();
    }
  });

  it.each([
    {
      name: 'a nested workflow cause',
      causeRef: { stream: { kind: 'workflow', id: 'workflow-1' }, seq: 1 },
      expected:
        'Job job-1 failed: Failed: Workflow failed. Caused by: Workflow lifecycle fault (unknown): workflow failure.',
    },
    {
      name: 'an indeterminate provider activation cause with its inspection command',
      causeRef: { stream: { kind: 'job', id: 'job-activation-unknown' }, seq: 3 },
      expected:
        'Job job-1 failed: Failed: Provider containment disappeared after activation may have begun. ' +
        'Activation indeterminate [activation_indeterminate]: the provider may have started. ' +
        'Run `coral-cli jobs detail job-activation-unknown` to inspect the durable job record before deciding whether to retry.',
    },
  ] as const)('renders $name from the store for failed terminal outcomes', async ({ causeRef, expected }) => {
    // Module-load-time env capture: this test needs fresh import after HOME change.
    const fixture = createCauseRenderFixture();
    const originalHome = process.env.HOME;
    const originalTmpdir = process.env.TMPDIR;

    try {
      process.env.HOME = fixture.home;
      process.env.TMPDIR = fixture.home;

      const { launchAndFollow } = await loadFollowModuleFresh();

      mockState.ensure.mockResolvedValueOnce(makeBackend());
      mockState.subscribe.mockResolvedValueOnce(
        makeSubscription(async function* () {
          yield makeTerminalEvent({
            content: '',
            outcome: {
              kind: 'failed',
              causeRef,
            },
          });
        }),
      );

      await expect(launchAndFollow(makeOptions({ pluginRoot: fixture.pluginRoot }))).resolves.toBe(1);

      expect(stdout).toContain(expected);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }

      fixture.cleanup();
    }
  });
});
