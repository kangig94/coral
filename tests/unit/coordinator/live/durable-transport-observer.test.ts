import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FailureDomainContainment, FailureDomainObservation } from '#src/infra/failure-domain.js';
import type * as ProcessContainmentModule from '#src/infra/process-containment.js';

const reapRecordedContainment = vi.hoisted(() => vi.fn());

vi.mock('#src/infra/process-containment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessContainmentModule>()),
  reapRecordedContainment,
}));

import {
  spawnDurableJobTransport,
  type DurableProcessCleanup,
  type DurableProcessRetention,
  type PendingDurableLaunch,
  type SpawnDurableJobOptions,
} from '#src/coordinator/live/durable-transport.js';
import type { LaunchPool } from '#src/jobs/contracts/admission.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { DurableProcessExit } from '#src/runtime/durable-runtime.js';
import type { DurableContainmentOperatorControl, DurableProcessIdentityCallback } from '#src/providers/cli-runner.js';
import { createDurableTestRuntime } from '#tests/helpers/durable-runtime.js';
import type { DurableLaunchResult, Runtime } from '#src/runtime/ports.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const roots: string[] = [];

afterEach(() => {
  reapRecordedContainment.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function durableFixturePaths(label: string): { jobDir: string; stdoutPath: string; stderrPath: string } {
  const jobDir = mkdtempSync(join(tmpdir(), `coral-durable-${label}-`));
  roots.push(jobDir);
  const stdoutPath = join(jobDir, 'stdout');
  const stderrPath = join(jobDir, 'stderr');
  writeFileSync(stdoutPath, '');
  writeFileSync(stderrPath, '');
  return { jobDir, stdoutPath, stderrPath };
}

function callerOwnership(runtime: Runtime, pool: LaunchPool) {
  return {
    kind: 'caller' as const,
    permit: {
      reservationId: 'observer-reservation',
      jobId: 'observer-job',
      pool,
      provider: 'codex',
      holder: { kind: 'local-execution' as const },
      acquiredAt: 0,
    },
    abortRegistry: new AbortRegistry(),
  };
}

function launchResult(paths: ReturnType<typeof durableFixturePaths>): DurableLaunchResult {
  const pid = 82_001;
  const incarnation = testIncarnation('durable-wrapper');
  return {
    disposition: 'launched',
    launchHandle: 'durable-test-launch' as never,
    pid,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    runtimeRecord: {
      transport: 'durable-cli',
      pid,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      startTime: new Date(0).toISOString(),
    },
    processSubject: {
      pid,
      incarnation,
      processGroupId: pid,
      childRoot: { pid: pid + 1, incarnation: testIncarnation('durable-child') },
    },
  };
}

function startWrapperPublication(
  callbacks: Pick<SpawnDurableJobOptions, 'onRuntimeRecord' | 'onDurableProcessIdentity'>,
  failureDomain?: FailureDomainContainment,
) {
  const paths = durableFixturePaths('publication');
  const launched = launchResult(paths);
  const cleanup = deferred<{ kind: 'containment-absent' }>();
  const readinessError = new Error('synthetic readiness failure');
  const cleanupHandles = new Map<symbol, DurableProcessCleanup>();
  const cleanupRetentions = new Map<DurableProcessCleanup, DurableProcessRetention>();
  const pendingLaunches = new Set<PendingDurableLaunch>();
  reapRecordedContainment.mockImplementationOnce(() => cleanup.promise);
  const base = createDurableTestRuntime();
  const runtime: Runtime = {
    ...base,
    process: {
      ...base.process,
      failureDomainContainment: () => failureDomain,
      durable: {
        launch: async (options) => {
          options.onWrapperIdentified?.({
            runtimeRecord: launched.runtimeRecord,
            pid: launched.pid,
            leaderIncarnation: launched.processSubject.incarnation,
          });
          throw readinessError;
        },
        waitForExit: () => new Promise<DurableProcessExit>(() => undefined),
      },
    },
  };
  const result = spawnDurableJobTransport({
    runtime,
    options: {
      provider: 'codex',
      command: 'fixture',
      args: [],
      jobId: 'observer-job',
      jobDir: paths.jobDir,
      failureDomainName: 'job-test-1',
      ...callbacks,
    },
    pool: {} as LaunchPool,
    ownership: callerOwnership(runtime, {} as LaunchPool),
    cleanupHandles,
    cleanupRetentions,
    pendingLaunches,
    releaseLaunch: vi.fn(),
  });

  return {
    cleanup,
    cleanupHandles,
    cleanupRetentions,
    pendingLaunches,
    readinessError,
    result,
    launched,
  };
}

describe('durable transport observer timing and cleanup ownership', () => {
  it.each(['populated', 'missing', 'unknown'] as const)(
    'retains cleanup when a leaf observed by the reaper becomes %s before its awaited result',
    async (transition) => {
      let observation: FailureDomainObservation = { kind: 'missing' };
      let changeAfterProof = false;
      let outerHold = false;
      const fixture = startWrapperPublication(
        {
          onRuntimeRecord: vi.fn(),
          onDurableProcessIdentity: (_subject, status) => {
            if (status?.kind === 'held') outerHold = true;
            if (status?.kind === 'absence-confirmed') outerHold = false;
            return { kind: 'published' };
          },
        },
        {
          observe: () => {
            if (changeAfterProof && observation.kind === 'absent') {
              queueMicrotask(() => {
                observation = { kind: 'populated' };
              });
            }
            return observation;
          },
          kill: () => ({ kind: 'refused', errno: 'EACCES' }),
        },
      );
      const rejection = fixture.result.catch((error: unknown) => error);
      await vi.waitFor(() => expect(reapRecordedContainment).toHaveBeenCalledOnce());
      observation = { kind: 'absent' };
      reapRecordedContainment.mock.calls[0][3].failureDomain.observe();
      observation = transition === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: transition };
      fixture.cleanup.resolve({ kind: 'containment-absent' });
      await flushMicrotasks(64);
      expect(fixture.cleanupHandles.size).toBe(1);
      expect(fixture.cleanupRetentions.size).toBe(1);
      observation = { kind: 'absent' };
      reapRecordedContainment.mockResolvedValue({ kind: 'containment-absent' });
      changeAfterProof = true;
      await [...fixture.cleanupRetentions.keys()][0]();
      expect(outerHold).toBe(true);
      expect(fixture.cleanupHandles.size).toBe(1);
      changeAfterProof = false;
      observation = { kind: 'absent' };
      await [...fixture.cleanupRetentions.keys()][0]();
      await expect(rejection).resolves.toBe(fixture.readinessError);
    },
  );

  it('names failed runtime publication and releases the pending launch after publishing identity', async () => {
    const publicationError = new Error('synthetic runtime publication failure');
    const onDurableProcessIdentity = vi.fn(() => ({ kind: 'published' as const }));
    const fixture = startWrapperPublication({
      onRuntimeRecord: () => {
        throw publicationError;
      },
      onDurableProcessIdentity,
    });
    const rejection = fixture.result.catch((error: unknown) => error);

    await vi.waitFor(() => expect(reapRecordedContainment).toHaveBeenCalledOnce());

    expect(onDurableProcessIdentity).toHaveBeenCalledOnce();
    expect(fixture.pendingLaunches.size).toBe(0);
    expect(fixture.cleanupHandles.size).toBe(1);
    expect([...fixture.cleanupRetentions.values()]).toEqual([
      expect.objectContaining({
        publication: {
          kind: 'observed-unpublished',
          owner: 'process-exit',
          publicationLoss: 'runtime publication failed: synthetic runtime publication failure',
        },
      }),
    ]);

    fixture.cleanup.resolve({ kind: 'containment-absent' });
    await expect(rejection).resolves.toBe(publicationError);
  });

  it('keeps a retained identity publication durably published and releases the pending launch', async () => {
    const fixture = startWrapperPublication({
      onRuntimeRecord: vi.fn(),
      onDurableProcessIdentity: () => ({ kind: 'retained' as const, reason: 'synthetic identity retention' }),
    });
    const rejection = fixture.result.catch((error: unknown) => error);

    await vi.waitFor(() => expect(reapRecordedContainment).toHaveBeenCalledOnce());

    expect(fixture.pendingLaunches.size).toBe(0);
    expect(fixture.cleanupHandles.size).toBe(1);
    expect([...fixture.cleanupRetentions.values()]).toEqual([
      expect.objectContaining({
        publication: {
          kind: 'durably-published',
          owner: 'successor-recovery',
          evidence: {
            kind: 'durable-cli-runtime',
            jobId: 'observer-job',
            pid: fixture.launched.runtimeRecord.pid,
            leaderIncarnation: fixture.launched.processSubject.incarnation,
          },
        },
      }),
    ]);

    fixture.cleanup.resolve({ kind: 'containment-absent' });
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'durable process identity publication retained: synthetic identity retention',
    );
  });

  it('keeps an absent runtime callback observed and names the missing proof', async () => {
    const fixture = startWrapperPublication({
      onDurableProcessIdentity: () => ({ kind: 'published' }),
    });
    const rejection = fixture.result.catch((error: unknown) => error);

    await vi.waitFor(() => expect(reapRecordedContainment).toHaveBeenCalledOnce());

    expect(fixture.pendingLaunches.size).toBe(0);
    expect([...fixture.cleanupRetentions.values()]).toEqual([
      expect.objectContaining({
        publication: {
          kind: 'observed-unpublished',
          owner: 'process-exit',
          publicationLoss: 'runtime publication callback is unavailable',
        },
      }),
    ]);

    fixture.cleanup.resolve({ kind: 'containment-absent' });
    await expect(rejection).resolves.toBe(fixture.readinessError);
  });

  it('keeps a superseded cleanup joinable while its replacement runs', async () => {
    const paths = durableFixturePaths('retarget');
    const launched = launchResult(paths);
    const firstCleanup = deferred<{ kind: 'identity-unobservable'; signalDelivered: boolean }>();
    const secondCleanup = deferred<{ kind: 'containment-absent' }>();
    const exited = deferred<DurableProcessExit>();
    reapRecordedContainment
      .mockImplementationOnce(() => firstCleanup.promise)
      .mockImplementationOnce(() => secondCleanup.promise);
    const controller = new AbortController();
    let operatorControl: DurableContainmentOperatorControl | undefined;
    let wake: (() => void) | undefined;
    const onIdentity: DurableProcessIdentityCallback = (_subject, status, control) => {
      if (status?.kind === 'held') operatorControl = control;
      return { kind: 'published' };
    };
    const base = createDurableTestRuntime();
    const runtime: Runtime = {
      ...base,
      time: {
        ...base.time,
        monotonicNow: () => 0n,
        sleep: () =>
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
        setInterval: () => ({}),
        clearInterval: vi.fn(),
      },
      process: {
        ...base.process,
        durable: {
          launch: async (options) => {
            options.onWrapperIdentified?.({
              runtimeRecord: launched.runtimeRecord,
              pid: launched.pid,
              leaderIncarnation: launched.processSubject.incarnation,
            });
            controller.abort();
            options.onSpawned?.({
              runtimeRecord: launched.runtimeRecord,
              leaderIncarnation: launched.processSubject.incarnation,
              childRoot: launched.processSubject.childRoot,
            });
            return launched;
          },
          waitForExit: () => exited.promise,
        },
      },
    };

    const result = spawnDurableJobTransport({
      runtime,
      options: {
        provider: 'codex',
        command: 'fixture',
        args: [],
        jobDir: paths.jobDir,
        failureDomainName: 'job-test-1',
        signal: controller.signal,
        onDurableProcessIdentity: onIdentity,
      },
      pool: {} as LaunchPool,
      ownership: callerOwnership(runtime, {} as LaunchPool),
      cleanupHandles: new Map<symbol, DurableProcessCleanup>(),
      cleanupRetentions: new Map<DurableProcessCleanup, DurableProcessRetention>(),
      pendingLaunches: new Set<PendingDurableLaunch>(),
      releaseLaunch: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Retargeting must start the replacement without waiting for the superseded attempt to settle.
    expect(reapRecordedContainment).toHaveBeenCalledTimes(2);
    expect(operatorControl?.abandon()).toMatchObject({ kind: 'retained', reason: expect.stringContaining('settling') });

    firstCleanup.resolve({ kind: 'identity-unobservable', signalDelivered: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(operatorControl?.abandon()).toMatchObject({ kind: 'retained', reason: expect.stringContaining('settling') });

    secondCleanup.resolve({ kind: 'containment-absent' });
    exited.resolve({ exitCode: 0, signal: null, endTime: new Date(1).toISOString() });
    wake?.();
    await expect(result).resolves.toMatchObject({ code: 0, aborted: true });
  });

  it('retains cleanup ownership until an active attempt settles before abandonment', async () => {
    const paths = durableFixturePaths('abandon-settlement');
    const launched = launchResult(paths);
    const cleanupAttempt = deferred<{ kind: 'identity-unobservable'; signalDelivered: boolean }>();
    const cleanupHandles = new Map<symbol, DurableProcessCleanup>();
    reapRecordedContainment.mockImplementationOnce(() => cleanupAttempt.promise);
    const controller = new AbortController();
    let operatorControl: DurableContainmentOperatorControl | undefined;
    let wake: (() => void) | undefined;
    const onIdentity: DurableProcessIdentityCallback = (_subject, status, control) => {
      if (status?.kind === 'held') operatorControl = control;
      return { kind: 'published' };
    };
    const base = createDurableTestRuntime();
    const runtime: Runtime = {
      ...base,
      time: {
        ...base.time,
        monotonicNow: () => 0n,
        sleep: () =>
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
        setInterval: () => ({}),
        clearInterval: vi.fn(),
      },
      process: {
        ...base.process,
        durable: {
          launch: async (options) => {
            options.onSpawned?.({
              runtimeRecord: launched.runtimeRecord,
              leaderIncarnation: launched.processSubject.incarnation,
              childRoot: launched.processSubject.childRoot,
            });
            return launched;
          },
          waitForExit: () => new Promise<DurableProcessExit>(() => undefined),
        },
      },
    };

    const result = spawnDurableJobTransport({
      runtime,
      options: {
        provider: 'codex',
        command: 'fixture',
        args: [],
        jobDir: paths.jobDir,
        failureDomainName: 'job-test-1',
        signal: controller.signal,
        onDurableProcessIdentity: onIdentity,
      },
      pool: {} as LaunchPool,
      ownership: callerOwnership(runtime, {} as LaunchPool),
      cleanupHandles,
      cleanupRetentions: new Map<DurableProcessCleanup, DurableProcessRetention>(),
      pendingLaunches: new Set<PendingDurableLaunch>(),
      releaseLaunch: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(reapRecordedContainment).toHaveBeenCalledOnce();
    expect(operatorControl?.abandon()).toMatchObject({ kind: 'retained', reason: expect.stringContaining('settling') });
    expect(cleanupHandles.size).toBe(1);

    cleanupAttempt.resolve({ kind: 'identity-unobservable', signalDelivered: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(operatorControl?.abandon()).toMatchObject({ kind: 'abandoned' });
    expect(cleanupHandles.size).toBe(0);
    wake?.();
    await expect(result).resolves.toMatchObject({ code: null, aborted: true });
  });
});

it.each([false, true])('carries entered publication result %s into live containment evidence', async (persisted) => {
  const paths = durableFixturePaths('entry-publication');
  const base = createDurableTestRuntime();
  const cleanupHandles = new Map<symbol, DurableProcessCleanup>();
  const cleanupRetentions = new Map<DurableProcessCleanup, DurableProcessRetention>();
  let publishedEntry = false;
  let observedEntry: boolean | undefined;
  const failure = new Error('entry-wiring-failed');
  const runtime: Runtime = {
    ...base,
    process: {
      ...base.process,
      failureDomainRoot: { kind: 'placed', root: '/scope' },
      removeFailureDomain: vi.fn(() => ({ kind: 'removed' }) as const),
      failureDomainContainment: () => ({ observe: () => ({ kind: 'absent' }), kill: () => ({ kind: 'entered' }) }),
      durable: {
        ...base.process.durable,
        launch: async (options) => {
          options.onWrapperIdentified?.({
            runtimeRecord: launchResult(paths).runtimeRecord,
            pid: 82_001,
            leaderIncarnation: testIncarnation('durable-wrapper'),
          });
          options.onWrapperEntered?.();
          throw failure;
        },
      },
    },
  };
  reapRecordedContainment.mockImplementation(async (_subject, _roots, _deadline, environment) => {
    observedEntry = environment.failureDomain.hasEntered();
    return { kind: 'containment-absent' };
  });
  await expect(
    spawnDurableJobTransport({
      runtime,
      options: {
        provider: 'codex',
        command: 'fixture',
        args: [],
        jobDir: paths.jobDir,
        failureDomainName: 'job-entry-1',
        onDurableProcessIdentity: (_identity, _status, _control, placement) => {
          if (placement === 'entered') {
            publishedEntry = true;
            return { kind: 'published', failureDomainEntered: persisted };
          }
          return { kind: 'published', failureDomainReady: true };
        },
      },
      pool: 'default',
      cleanupHandles,
      cleanupRetentions,
      pendingLaunches: new Set<PendingDurableLaunch>(),
      releaseLaunch: () => ({ kind: 'released', pool: 'default', admittedNext: false }),
      ownership: callerOwnership(runtime, 'default'),
    }),
  ).rejects.toThrow('entry-wiring-failed');
  expect(publishedEntry).toBe(true);
  expect(observedEntry).toBe(persisted);
  expect(reapRecordedContainment).toHaveBeenCalled();
  expect(cleanupHandles.size).toBe(0);
  expect(runtime.process.removeFailureDomain).not.toHaveBeenCalled();
});
