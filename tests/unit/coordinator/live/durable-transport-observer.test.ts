import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
} from '#src/coordinator/live/durable-transport.js';
import type { LaunchPool } from '#src/jobs/contracts/admission.js';
import type { DurableProcessExit } from '#src/runtime/durable-runtime.js';
import type { DurableContainmentOperatorControl, DurableProcessIdentityCallback } from '#src/providers/cli-runner.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { DurableLaunchResult, Runtime } from '#src/runtime/ports.js';
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

function spawn(runtime: Runtime, paths: ReturnType<typeof durableFixturePaths>, signal?: AbortSignal) {
  return spawnDurableJobTransport({
    runtime,
    options: {
      provider: 'codex',
      command: 'fixture',
      args: [],
      jobDir: paths.jobDir,
      ...(signal === undefined ? {} : { signal }),
    },
    pool: {} as LaunchPool,
    internalPermitJobId: null,
    cleanupHandles: new Map<symbol, DurableProcessCleanup>(),
    cleanupRetentions: new Map<DurableProcessCleanup, DurableProcessRetention>(),
    pendingLaunches: new Set<PendingDurableLaunch>(),
    releaseLaunch: vi.fn(),
  });
}

describe('durable transport observer timing and cleanup ownership', () => {
  it.each([60_000, 600_000])('does not consume idle budget during %dms of observer lateness', async (latenessMs) => {
    const paths = durableFixturePaths(`idle-${latenessMs}`);
    const launched = launchResult(paths);
    const exited = deferred<DurableProcessExit>();
    let monotonicNow = 0n;
    let sleeps = 0;
    const base = createRealRuntime('prod');
    const runtime: Runtime = {
      ...base,
      time: {
        ...base.time,
        monotonicNow: () => monotonicNow,
        sleep: async () => {
          sleeps += 1;
          if (sleeps <= 1_140) monotonicNow += 500n;
          else if (sleeps === 1_141) monotonicNow += BigInt(latenessMs);
          else if (sleeps === 1_142) {
            monotonicNow += 500n;
            exited.resolve({ exitCode: 0, signal: null, endTime: new Date(1).toISOString() });
          }
        },
      },
      process: {
        ...base.process,
        observeLiveness: () => 'absent',
        readProcessIncarnation: () => null,
        durable: {
          launch: async () => launched,
          waitForExit: () => exited.promise,
        },
      },
    };

    await expect(spawn(runtime, paths)).resolves.toMatchObject({ code: 0, aborted: false });
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
    const base = createRealRuntime('prod');
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
        signal: controller.signal,
        onDurableProcessIdentity: onIdentity,
      },
      pool: {} as LaunchPool,
      internalPermitJobId: null,
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
    const base = createRealRuntime('prod');
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
        signal: controller.signal,
        onDurableProcessIdentity: onIdentity,
      },
      pool: {} as LaunchPool,
      internalPermitJobId: null,
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
