import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableTestRuntime } from '#tests/helpers/durable-runtime.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator, LAUNCH_RECLAMATION_AGE_FLOOR_MS } from '#src/coordinator/live/admission.js';
import type { DurableProcessCleanup } from '#src/coordinator/live/durable-transport.js';
import type { DurableContainmentOperatorControl } from '#src/providers/cli-runner.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { liveChildAuthority } from '#src/infra/process-supervision.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableProvisionalProcessSubject,
  ProcessPort,
  Runtime,
} from '#src/runtime/ports.js';

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_WORKERS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_WORKERS;
const TEST_PROVIDER_PID = 20_000;

const runtimeRoots: string[] = [];

afterEach(() => {
  for (const root of runtimeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createAdmissionRuntime(): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-launch-admission-'));
  runtimeRoots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

describe('succession admission pause', () => {
  let now: number;
  let coordinator: LaunchCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    const runtime = createAdmissionRuntime();
    coordinator = new LaunchCoordinator({
      runtime: {
        ...runtime,
        time: { ...runtime.time, now: () => now, monotonicNow: () => BigInt(now) },
      },
    });
  });

  afterEach(() => vi.useRealTimers());

  it('should admit accepted descendants and invalidate a prepared attempt', () => {
    const revision = coordinator.admissionRevision();
    const child = coordinator.requestLaunch('child', 'claude', { kind: 'workflow', id: 'parent' }, 'default', true);
    expect(child).toMatchObject({ type: 'immediate' });
    expect(coordinator.admissionRevision()).toBeGreaterThan(revision);
    expect(coordinator.beginSuccessionCommitWindow('stale', revision)).toEqual({
      kind: 'refused',
      reason: 'stale-preparation',
    });

    const currentRevision = coordinator.admissionRevision();
    expect(coordinator.beginSuccessionCommitWindow('attempt', currentRevision).kind).toBe('paused');
    expect(coordinator.admitTopLevelLaunch()).toBe(false);
    const round = coordinator.requestLaunch('round', 'claude', { kind: 'discussion', id: 'accepted' }, 'discuss', true);
    expect(round).toMatchObject({ type: 'immediate' });
    expect(coordinator.successionAdmissionPaused()).toBe(true);
    expect(coordinator.admissionRevision()).toBeGreaterThan(currentRevision);
    expect(coordinator.endSuccessionCommitWindow('attempt')).toBe(true);
    expect(coordinator.beginSuccessionCommitWindow('stale', currentRevision)).toEqual({
      kind: 'refused',
      reason: 'stale-preparation',
    });
  });
});

function restoreEnv(name: 'CORAL_MAX_WORKERS' | 'CORAL_DISCUSS_MAX_WORKERS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function testSignalAuthority(pid: number, hasExited: () => boolean, requestTermination?: () => void) {
  const child: ChildProcessLike = {
    pid,
    get exitCode() {
      return hasExited() ? 0 : null;
    },
    signalCode: null,
    stdin: null,
    stdout: null,
    stderr: null,
    on() {
      return this;
    },
    kill: () => true,
  };
  const authority = liveChildAuthority(child);
  if (authority === undefined) throw new Error('Expected test child authority.');
  return requestTermination === undefined ? authority : Object.freeze({ ...authority, requestTermination });
}

function createCoordinator(): LaunchCoordinator {
  return new LaunchCoordinator({ runtime: createAdmissionRuntime() });
}

function providerOwner(id: string) {
  return { kind: 'provider-session' as const, id };
}

describe('launch admission', () => {
  let coordinator: LaunchCoordinator;

  beforeEach(() => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    coordinator = createCoordinator();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
  });

  it('fences a reused job from stale cancellation and permit release', async () => {
    const firstBlocker = coordinator.requestLaunch('blocker-1', 'codex', providerOwner('blocker-session-1'), 'default');
    if (firstBlocker === 'queue_full' || firstBlocker.type !== 'immediate') throw new Error('expected blocker');
    const staleHandle = coordinator.requestLaunch('reused-job', 'codex', providerOwner('old-session'), 'default');
    if (staleHandle === 'queue_full' || staleHandle.type !== 'queued') throw new Error('expected old queued handle');
    coordinator.releaseLaunch(firstBlocker.permit);
    const stalePermit = await staleHandle.waitForPermit();
    coordinator.releaseLaunch(stalePermit);

    const secondBlocker = coordinator.requestLaunch(
      'blocker-2',
      'codex',
      providerOwner('blocker-session-2'),
      'default',
    );
    if (secondBlocker === 'queue_full' || secondBlocker.type !== 'immediate') throw new Error('expected blocker');
    const currentHandle = coordinator.requestLaunch('reused-job', 'codex', providerOwner('new-session'), 'default');
    if (currentHandle === 'queue_full' || currentHandle.type !== 'queued') {
      throw new Error('expected current queued handle');
    }

    expect(staleHandle.cancel()).toEqual({ kind: 'admitted', permit: stalePermit });
    expect(coordinator.queuePosition('reused-job', 'default')).toBe(1);

    const permit = currentHandle.waitForPermit();
    coordinator.releaseLaunch(secondBlocker.permit);
    const currentPermit = await permit;
    expect(currentPermit.reservationId).not.toBe(stalePermit.reservationId);
    expect(coordinator.releaseLaunch(stalePermit)).toEqual({ kind: 'already-released', pool: 'default' });
    expect(coordinator.getActiveJobIds()).toEqual(['reused-job']);
  });

  it('reclaims only exact terminal absence and retains live or unknown ownership', async () => {
    let now = 10_000;
    const base = createAdmissionRuntime();
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    const source = localCoordinator.requestLaunch('ended-job', 'codex', providerOwner('session'), 'default');
    if (source === 'queue_full' || source.type !== 'immediate') throw new Error('expected source permit');
    const identity = { jobId: source.permit.jobId, operationId: 'ended-operation' };
    expect(localCoordinator.prepareProviderOperationBinding(source.permit, identity)).toEqual({ kind: 'prepared' });
    expect(localCoordinator.commitProviderOperationBinding(identity).kind).toBe('bound');
    const waiting = localCoordinator.requestLaunch('waiting-job', 'codex', providerOwner('waiting'), 'default');
    if (waiting === 'queue_full' || waiting.type !== 'queued') throw new Error('expected queued permit');
    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS;

    localCoordinator.connectLaunchReclamationOracle('proxy-operation', () => ({ kind: 'job-live' }));
    localCoordinator.sweepStaleLaunchPermits();
    expect(localCoordinator.reservationFor(identity.jobId)).not.toBeNull();
    localCoordinator.connectLaunchReclamationOracle('proxy-operation', () => {
      throw new Error('ownership unavailable');
    });
    localCoordinator.sweepStaleLaunchPermits();
    expect(localCoordinator.reservationFor(identity.jobId)).not.toBeNull();
    localCoordinator.connectLaunchReclamationOracle('proxy-operation', () => ({
      kind: 'provider-operation-absent',
      operationId: 'different-operation',
      jobEvidence: { kind: 'job-terminal', phase: 'completed' },
    }));
    localCoordinator.sweepStaleLaunchPermits();
    expect(localCoordinator.reservationFor(identity.jobId)).not.toBeNull();
    expect(localCoordinator.queuePosition('waiting-job', 'default')).toBe(1);

    localCoordinator.connectLaunchReclamationOracle('proxy-operation', () => ({
      kind: 'provider-operation-absent',
      operationId: identity.operationId,
      jobEvidence: { kind: 'job-terminal', phase: 'completed' },
    }));
    localCoordinator.sweepStaleLaunchPermits();
    expect((await waiting.waitForPermit()).jobId).toBe('waiting-job');
    expect(localCoordinator.reservationFor(identity.jobId)).toBeNull();
  });

  it('binds and settles a proxy operation with a successor permit', () => {
    const admission = coordinator.requestLaunch('job-proxy', 'codex', providerOwner('session-proxy'), 'default');
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
    const identity = { jobId: 'job-proxy', operationId: 'operation-proxy' };

    expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'prepared' });
    const binding = coordinator.commitProviderOperationBinding(identity);
    expect(binding).toMatchObject({
      kind: 'bound',
      successorPermit: {
        reservationId: admission.permit.reservationId,
        holder: { kind: 'proxy-operation', operationId: 'operation-proxy' },
      },
    });
    if (binding.kind !== 'bound') throw new Error('expected bound operation');
    expect(coordinator.releaseLaunch(admission.permit)).toEqual({
      kind: 'transferred',
      pool: 'default',
      holder: { kind: 'proxy-operation', operationId: 'operation-proxy' },
    });
    expect(coordinator.launchReleaseDiagnostics()).toEqual([
      {
        reservationId: admission.permit.reservationId,
        jobId: admission.permit.jobId,
        pool: 'default',
        provider: 'codex',
        attemptedHolder: { kind: 'local-execution' },
        disposition: {
          kind: 'transferred',
          pool: 'default',
          holder: { kind: 'proxy-operation', operationId: 'operation-proxy' },
        },
        observedAtMs: expect.any(Number),
      },
    ]);
    expect(coordinator.settleProviderOperationBinding(identity)).toMatchObject({
      kind: 'settled',
      reservationId: admission.permit.reservationId,
    });
    expect(coordinator.releaseLaunch(binding.successorPermit)).toEqual({
      kind: 'already-released',
      pool: 'default',
    });
  });

  it('does not let delayed settlement for an old operation release a newer job generation', () => {
    const first = coordinator.requestLaunch('job-reused-operation', 'codex', providerOwner('first'), 'default');
    if (first === 'queue_full' || first.type !== 'immediate') throw new Error('expected first permit');
    const oldOperation = { jobId: first.permit.jobId, operationId: 'old-operation' };
    expect(coordinator.prepareProviderOperationBinding(first.permit, oldOperation)).toEqual({ kind: 'prepared' });
    expect(coordinator.releaseLaunch(first.permit)).toMatchObject({ kind: 'released' });

    const second = coordinator.requestLaunch('job-reused-operation', 'codex', providerOwner('second'), 'default');
    if (second === 'queue_full' || second.type !== 'immediate') throw new Error('expected second permit');

    expect(coordinator.settleProviderOperationBinding(oldOperation)).toEqual({ kind: 'settled-unbound' });
    expect(coordinator.reservationFor(second.permit.jobId)).toMatchObject({
      kind: 'active',
      executionOwner: providerOwner('second'),
    });
    expect(coordinator.releaseLaunch(second.permit)).toMatchObject({ kind: 'released' });
  });

  it('joins a cleanup attempt that outlives the caller deadline', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    let settleCleanup!: (outcome: { kind: 'observed-absent'; pid: number }) => void;
    const cleanupSettlement = new Promise<{ kind: 'observed-absent'; pid: number }>((resolve) => {
      settleCleanup = resolve;
    });
    const cleanup = vi.fn(() => cleanupSettlement);
    cleanupHandles.set(Symbol('deferred-child'), cleanup);
    const controller = new AbortController();

    const initial = coordinator.terminateRegisteredChildren(controller.signal);
    controller.abort();
    await expect(initial).resolves.toMatchObject({ kind: 'children-unresolved-at-deadline' });

    const retry = coordinator.terminateRegisteredChildren();
    expect(cleanup).toHaveBeenCalledOnce();
    settleCleanup({ kind: 'observed-absent', pid: TEST_PROVIDER_PID });
    await expect(retry).resolves.toEqual({ kind: 'all-children-observed-absent' });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reaps an attributable readiness failure and holds an unattributable group', async () => {
    {
      const base = createDurableTestRuntime();
      const incarnation = testIncarnation(7_001);
      let elapsedMs = 0n;
      let exited = false;
      let settleWrapper!: () => void;
      const wrapperSettlement = new Promise<void>((resolve) => {
        settleWrapper = resolve;
      });
      const launch = vi.fn(async (options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
        options.onWrapperSpawned?.({
          pid: TEST_PROVIDER_PID,
          settled: wrapperSettlement,
          requestTermination: () => ({
            kind: 'signal-failed',
            pid: null,
            signal: 'SIGTERM',
            reason: 'kill-port-returned-false',
          }),
        });
        options.onWrapperIdentified?.({
          runtimeRecord: {
            transport: 'durable-cli',
            pid: TEST_PROVIDER_PID,
            stdoutPath: '/tmp/readiness-rejection/stdout',
            stderrPath: '/tmp/readiness-rejection/stderr',
            startTime: new Date(0).toISOString(),
          },
          pid: TEST_PROVIDER_PID,
          leaderIncarnation: incarnation,
          signalAuthority: testSignalAuthority(TEST_PROVIDER_PID, () => exited),
        });
        throw new Error('synthetic readiness rejection');
      });
      const kill = vi.fn<ProcessPort['kill']>((pid, signal) => {
        if (signal === 0) return !exited;
        expect(pid).toBe(-TEST_PROVIDER_PID);
        exited = true;
        settleWrapper();
        return true;
      });
      const runtime: Runtime = {
        ...base,
        env: { ...base.env, platform: () => 'darwin' },
        time: {
          ...base.time,
          monotonicNow: () => elapsedMs,
          sleep: async (milliseconds) => {
            elapsedMs += BigInt(milliseconds);
          },
        },
        process: {
          ...base.process,
          kill,
          observeLiveness: () => (exited ? 'absent' : 'alive'),
          readProcessIncarnation: () => (exited ? null : incarnation),
          observeRecordedProcessAsync: async () => (exited ? 'absent' : 'alive'),
          durable: { ...base.process.durable, launch },
        },
      };
      const localCoordinator = new LaunchCoordinator({ runtime });

      await expect(
        localCoordinator.spawnDurableJob({
          provider: 'codex',
          command: 'codex',
          args: ['exec'],
          jobDir: '/tmp/readiness-rejection',
        }),
      ).rejects.toThrow('synthetic readiness rejection');

      await expect(localCoordinator.terminateRegisteredChildren()).resolves.toEqual({
        kind: 'all-children-observed-absent',
      });
      expect(kill).toHaveBeenCalledWith(-TEST_PROVIDER_PID, 'SIGTERM');
    }

    {
      const base = createDurableTestRuntime();
      const incarnation = testIncarnation(7_002);
      let elapsedMs = 0n;
      const requestTermination = vi.fn();
      let settleWrapper!: () => void;
      const wrapperSettlement = new Promise<void>((resolve) => {
        settleWrapper = resolve;
      });
      const launch = vi.fn(async (options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
        options.onWrapperSpawned?.({
          pid: TEST_PROVIDER_PID,
          settled: wrapperSettlement,
          requestTermination,
        });
        options.onWrapperIdentified?.({
          runtimeRecord: {
            transport: 'durable-cli',
            pid: TEST_PROVIDER_PID,
            stdoutPath: '/tmp/provisional-readiness-rejection/stdout',
            stderrPath: '/tmp/provisional-readiness-rejection/stderr',
            startTime: new Date(0).toISOString(),
          },
          pid: TEST_PROVIDER_PID,
          leaderIncarnation: incarnation,
          signalAuthority: testSignalAuthority(TEST_PROVIDER_PID, () => false, requestTermination),
        });
        throw new Error('synthetic provisional readiness rejection');
      });
      const runtime: Runtime = {
        ...base,
        env: { ...base.env, platform: () => 'darwin' },
        time: {
          ...base.time,
          monotonicNow: () => elapsedMs,
          sleep: async (milliseconds) => {
            elapsedMs += BigInt(milliseconds);
          },
        },
        process: {
          ...base.process,
          observeLiveness: () => 'alive',
          readProcessIncarnation: () => null,
          durable: { ...base.process.durable, launch },
        },
      };
      const localCoordinator = new LaunchCoordinator({ runtime });
      const observations = vi.fn(
        (
          identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
          status?: DurableContainmentStatus,
          control?: DurableContainmentOperatorControl,
        ) => {
          if (status?.kind === 'held') {
            expect(identity).toEqual({
              kind: 'provisional-wrapper',
              pid: TEST_PROVIDER_PID,
              incarnation,
              processGroupId: TEST_PROVIDER_PID,
              provider: 'codex',
              jobDir: '/tmp/provisional-readiness-rejection',
            });
            const abandonment = control?.abandon();
            expect(abandonment).toEqual({
              kind: 'abandoned',
              reason: 'job ownership was released without proof of process absence',
              nextStep: 'Inspect the recorded process because it may still be live.',
            });
            if (abandonment?.kind === 'abandoned') settleWrapper();
          }
          return { kind: 'published' as const };
        },
      );

      await expect(
        localCoordinator.spawnDurableJob({
          provider: 'codex',
          command: 'codex',
          args: ['exec'],
          jobDir: '/tmp/provisional-readiness-rejection',
          onDurableProcessIdentity: observations,
        }),
      ).rejects.toThrow('synthetic provisional readiness rejection');

      expect(requestTermination).not.toHaveBeenCalled();
      expect(
        observations.mock.calls.some(
          ([identity, status]) => 'kind' in identity && status?.kind === 'operator-abandoned',
        ),
      ).toBe(true);
      await expect(localCoordinator.terminateRegisteredChildren()).resolves.toEqual({
        kind: 'all-children-observed-absent',
      });
    }
  });

  it('retains cleanup ownership and settlement when absence publication fails', async () => {
    const base = createDurableTestRuntime();
    const incarnation = testIncarnation(7_003);
    const childRoot = { pid: TEST_PROVIDER_PID + 1, incarnation };
    const runtimeRecord = {
      transport: 'durable-cli' as const,
      pid: TEST_PROVIDER_PID,
      stdoutPath: '/tmp/failed-absence-publication/stdout',
      stderrPath: '/tmp/failed-absence-publication/stderr',
      startTime: new Date(0).toISOString(),
    };
    let processAbsent = false;
    let elapsedMs = 0n;
    const intervals = new Map<object, () => void>();
    const clearInterval = vi.fn((handle: object) => intervals.delete(handle));
    const exitRecord = { exitCode: 0, signal: null, endTime: new Date(1).toISOString() } as const;
    let resolveExit!: (record: typeof exitRecord) => void;
    const exit = new Promise<typeof exitRecord>((resolve) => {
      resolveExit = resolve;
    });
    let observeExit!: () => void;
    const waitingForExit = new Promise<void>((resolve) => {
      observeExit = resolve;
    });
    const runtime: Runtime = {
      ...base,
      env: { ...base.env, platform: () => 'darwin' },
      time: {
        ...base.time,
        monotonicNow: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += BigInt(milliseconds);
        },
        setInterval: (callback) => {
          const handle = { unref: vi.fn() };
          intervals.set(handle, callback);
          return handle;
        },
        clearInterval,
      },
      process: {
        ...base.process,
        kill: vi.fn(() => true),
        observeLiveness: () => (processAbsent ? 'absent' : 'unknown'),
        readProcessIncarnation: () => null,
        durable: {
          launch: async (options) => {
            options.onSpawned?.({ runtimeRecord, leaderIncarnation: incarnation, childRoot });
            return {
              disposition: 'launched',
              launchHandle: 'failed-absence-publication' as never,
              pid: TEST_PROVIDER_PID,
              stdoutPath: runtimeRecord.stdoutPath,
              stderrPath: runtimeRecord.stderrPath,
              runtimeRecord,
              processSubject: {
                pid: TEST_PROVIDER_PID,
                incarnation,
                processGroupId: TEST_PROVIDER_PID,
                childRoot,
              },
            };
          },
          waitForExit: () => {
            observeExit();
            return exit;
          },
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const abort = new AbortController();
    let publishIdentity!: () => void;
    const identityPublished = new Promise<void>((resolve) => {
      publishIdentity = resolve;
    });
    let publishHold!: () => void;
    const holdPublished = new Promise<void>((resolve) => {
      publishHold = resolve;
    });
    let absencePublicationAttempts = 0;
    let holdControl: DurableContainmentOperatorControl | undefined;
    const observations = vi.fn(
      (
        _identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
        status?: DurableContainmentStatus,
        control?: DurableContainmentOperatorControl,
      ) => {
        if (status === undefined) publishIdentity();
        if (status?.kind === 'held') {
          holdControl = control;
          publishHold();
        }
        if (status?.kind === 'absence-confirmed') {
          absencePublicationAttempts += 1;
          return { kind: 'retained' as const, reason: 'synthetic absence publication failure' };
        }
        return { kind: 'published' as const };
      },
    );
    let settled = false;
    const spawn = localCoordinator
      .spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/failed-absence-publication',
        signal: abort.signal,
        onDurableProcessIdentity: observations,
      })
      .finally(() => {
        settled = true;
      });

    await identityPublished;
    await waitingForExit;
    abort.abort();
    await holdPublished;
    const cleanupOwnership = localCoordinator as unknown as {
      readonly cleanupHandles: Map<symbol, DurableProcessCleanup>;
      readonly cleanupRetentions: Map<DurableProcessCleanup, unknown>;
    };
    const retainedCleanup = [...cleanupOwnership.cleanupHandles.values()][0];
    if (retainedCleanup === undefined) throw new Error('Expected retained durable cleanup ownership');
    await retainedCleanup();
    expect(intervals.size).toBe(1);
    const retry = [...intervals.entries()][0];
    if (retry === undefined) throw new Error('Expected active containment retry');
    const [retryHandle, retryCleanup] = retry;
    processAbsent = true;
    retryCleanup();
    expect(holdControl?.abandon()).toEqual({
      kind: 'retained',
      reason: 'the active durable containment cleanup attempt is still settling',
      nextStep: 'Retry the abort after the active cleanup attempt settles.',
    });
    expect(cleanupOwnership.cleanupHandles.size).toBe(1);
    await retainedCleanup();

    expect(absencePublicationAttempts).toBe(1);
    expect(cleanupOwnership.cleanupHandles.size).toBe(1);
    expect(cleanupOwnership.cleanupRetentions.size).toBe(1);
    expect(clearInterval).not.toHaveBeenCalledWith(retryHandle);
    expect(intervals.has(retryHandle)).toBe(true);
    expect(settled).toBe(false);

    expect(holdControl?.abandon()).toEqual({
      kind: 'abandoned',
      reason: 'job ownership was released without proof of process absence',
      nextStep: 'Inspect the recorded process because it may still be live.',
    });
    resolveExit(exitRecord);
    await expect(spawn).resolves.toMatchObject({ code: 0, aborted: true });
    expect(clearInterval).toHaveBeenCalledWith(retryHandle);
  });
});
