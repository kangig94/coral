import { MAX_BUFFER } from '../../infra/process-constants.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/contracts/admission.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { StoragePort } from '../../infra/port-types.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableLaunchResult,
  DurableLaunchSignalAuthority,
  Runtime,
} from '../../runtime/ports.js';
import { type GracefulKillByPidOutcome } from '../../infra/process-supervision.js';
import { createMonotonicClock } from '../../infra/monotonic-clock.js';
import {
  observeRecordedContainment,
  ProcessContainmentError,
  reapRecordedContainment,
} from '../../infra/process-containment.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../../infra/process-constants.js';

const IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL = 30_000;
const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;
const durableProcessCleanupClockScope = Symbol('durable-process-cleanup');
const DURABLE_PROCESS_CLEANUP_DEADLINE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;

function terminationOutcomeDetail(outcome: Exclude<GracefulKillByPidOutcome, { kind: 'observed-absent' }>): string {
  switch (outcome.kind) {
    case 'signal-refused':
      return outcome.reason;
    case 'signal-failed':
      return `${outcome.signal}:${outcome.reason}`;
    case 'target-unobservable':
    case 'target-alive':
      return `${outcome.kind}:${outcome.stage}`;
  }
}

export type DurableProcessRetention =
  | Readonly<{
      kind: 'recorded-wrapper-group';
      provider: string;
      jobDir: string;
      containment: Readonly<{
        pid: number;
        incarnation: ProcessIncarnation;
        processGroupId: number;
        childRoot: Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null;
      }>;
    }>
  | Readonly<{
      kind: 'unverified-wrapper-pid';
      provider: string;
      jobDir: string;
      pid: number;
    }>;

export type PendingDurableLaunchIdentity = Readonly<{
  kind: 'awaiting-wrapper-identity';
  provider: string;
  jobDir: string;
}>;

export type PendingDurableLaunch = Readonly<{
  settled: Promise<void>;
  retainedIdentity(): PendingDurableLaunchIdentity;
}>;

async function requestDurableProcessTermination(
  runtime: Runtime,
  retained: DurableProcessRetention,
  signalAuthority?: DurableLaunchSignalAuthority,
): Promise<GracefulKillByPidOutcome> {
  if (retained.kind === 'unverified-wrapper-pid') {
    return { kind: 'signal-refused', pid: retained.pid, reason: 'recorded-incarnation-unavailable' };
  }
  const { containment } = retained;
  const pid = containment.pid;
  const liveSignalAuthority =
    signalAuthority?.pid === pid && signalAuthority.hasExited() === false ? signalAuthority : undefined;
  const recordedRoots =
    liveSignalAuthority === undefined || runtime.env.platform() === 'linux'
      ? containment.childRoot === null
        ? []
        : [containment.childRoot]
      : [];
  const clock = createMonotonicClock(durableProcessCleanupClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds),
  });
  try {
    const outcome = await reapRecordedContainment(
      containment,
      recordedRoots,
      clock.shiftMilliseconds(clock.now(), DURABLE_PROCESS_CLEANUP_DEADLINE_MS),
      {
        maxRecordedRoots: 1,
        clock,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (targetPid, platform) => runtime.process.readProcessIncarnation(targetPid, platform),
        ...(liveSignalAuthority === undefined
          ? {}
          : {
              knownLiveChildFor: (targetPid: number) =>
                targetPid === liveSignalAuthority.pid ? liveSignalAuthority : undefined,
            }),
      },
    );
    if (outcome.kind !== 'containment-absent') {
      return { kind: 'signal-refused', pid, reason: 'expected-incarnation-mismatch' };
    }
    if (containment.childRoot === null || recordedRoots.length > 0) return { kind: 'observed-absent', pid };
    const subject = { ...containment, childRoot: containment.childRoot };
    const observation = observeRecordedContainment(subject, {
      process: runtime.process,
      platform: runtime.env.platform() as NodeJS.Platform,
      readProcessIncarnation: (targetPid, platform) => runtime.process.readProcessIncarnation(targetPid, platform),
    });
    if (observation.kind === 'absent') return { kind: 'observed-absent', pid };
    return observation.kind === 'alive'
      ? { kind: 'target-alive', pid, stage: 'after-sigkill' }
      : { kind: 'target-unobservable', pid, stage: 'after-sigkill' };
  } catch (error: unknown) {
    if (error instanceof ProcessContainmentError && error.code === 'process_identity_unverified') {
      return { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
    }
    return { kind: 'target-unobservable', pid, stage: 'after-sigkill' };
  }
}

export type DurableProcessCleanup = () => Promise<GracefulKillByPidOutcome>;

type DurableProviderResultDisposition =
  | Readonly<{ kind: 'absence-confirmed' }>
  | Readonly<{ kind: 'held'; reason: string }>
  | Readonly<{ kind: 'operator-abandoned' }>;

export type CliExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

type SpawnCliOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
  permitGranted?: boolean;
  pool?: LaunchPool;
  extraEnv?: Record<string, string>;
  exactEnv?: Record<string, string>;
};

export type SpawnDurableJobOptions = SpawnCliOptions & {
  jobDir: string;
  onRuntimeRecord?: (record: JobRuntime) => void;
  /** A partial containment identity must not cross the durable publication boundary. */
  onDurableProcessIdentity?: (identity: DurableCliProcessSubject, status?: DurableContainmentStatus) => void;
};

export async function spawnDurableJobTransport(params: {
  runtime: Runtime;
  options: SpawnDurableJobOptions;
  pool: LaunchPool;
  internalPermitJobId: string | null;
  cleanupHandles: Map<symbol, DurableProcessCleanup>;
  cleanupRetentions: Map<DurableProcessCleanup, DurableProcessRetention>;
  pendingLaunches: Set<PendingDurableLaunch>;
  releaseLaunch: (jobId: string, pool: LaunchPool) => void;
}): Promise<CliExecResult> {
  const { runtime, options, pool, cleanupHandles, cleanupRetentions, pendingLaunches, releaseLaunch } = params;
  const { internalPermitJobId } = params;
  let abortHandler: (() => void) | null = null;
  let cleanupKey: symbol | null = null;
  let cleanupInFlight: Promise<GracefulKillByPidOutcome> | null = null;
  let containmentAbsenceConfirmed = false;
  let containmentAbandoned = false;
  let providerResultHeld = false;
  let resolveContainmentAbsence!: () => void;
  const containmentAbsence = new Promise<void>((resolve) => {
    resolveContainmentAbsence = resolve;
  });
  let lastUnsettledDetail: string | null = null;
  let lastPublishedStatus: string | null = null;
  let publishedPid: number | null = null;
  let publishedSubject: DurableCliProcessSubject | null = null;
  let signalAuthority: DurableLaunchSignalAuthority | undefined;
  let retainedProcess: DurableProcessRetention | null = null;
  let resolvePendingLaunch!: () => void;
  let pendingLaunchOwned = true;
  const pendingSettlement = new Promise<void>((resolve) => {
    resolvePendingLaunch = resolve;
  });
  const pendingLaunch: PendingDurableLaunch = {
    settled: pendingSettlement,
    retainedIdentity: () => ({
      kind: 'awaiting-wrapper-identity',
      provider: options.provider,
      jobDir: options.jobDir,
    }),
  };
  const releasePendingLaunch = (): void => {
    if (!pendingLaunchOwned) return;
    pendingLaunchOwned = false;
    pendingLaunches.delete(pendingLaunch);
    resolvePendingLaunch();
  };
  pendingLaunches.add(pendingLaunch);

  const releaseCleanupOwnership = (): void => {
    if (cleanupKey === null) return;
    cleanupHandles.delete(cleanupKey);
    cleanupRetentions.delete(cleanup);
    cleanupKey = null;
    containmentAbsenceConfirmed = true;
    resolveContainmentAbsence();
    lastUnsettledDetail = null;
  };

  const publishContainmentStatus = (status: DurableContainmentStatus): void => {
    const subject = publishedSubject;
    if (subject === null) return;
    const statusKey = JSON.stringify(status);
    if (statusKey === lastPublishedStatus) return;
    try {
      options.onDurableProcessIdentity?.(subject, status);
      lastPublishedStatus = statusKey;
    } catch (error: unknown) {
      backendLog.warn(`[durable-process:${subject.pid}] Failed to publish containment status: ${errorMessage(error)}`);
    }
  };

  const abandonCleanupOwnership = (): void => {
    if (!providerResultHeld || cleanupKey === null) return;
    cleanupHandles.delete(cleanupKey);
    cleanupRetentions.delete(cleanup);
    cleanupKey = null;
    containmentAbandoned = true;
    resolveContainmentAbsence();
    publishContainmentStatus({ kind: 'operator-abandoned', processAbsenceProven: false });
  };

  const cleanup = (): Promise<GracefulKillByPidOutcome> => {
    if (cleanupInFlight !== null) return cleanupInFlight;
    if (publishedPid === null || retainedProcess === null)
      throw new Error('Durable cleanup was requested before a process identity was published.');
    const pid = publishedPid;
    cleanupInFlight = requestDurableProcessTermination(runtime, retainedProcess, signalAuthority).then((outcome) => {
      if (outcome.kind === 'observed-absent') {
        releaseCleanupOwnership();
      } else {
        const detail = terminationOutcomeDetail(outcome);
        if (detail !== lastUnsettledDetail) {
          backendLog.warn(`[durable-process:${pid}] Termination remains unsettled (${detail}).`);
          lastUnsettledDetail = detail;
        }
      }
      return outcome;
    });
    void cleanupInFlight.then(
      () => {
        cleanupInFlight = null;
      },
      () => {
        cleanupInFlight = null;
      },
    );
    return cleanupInFlight;
  };

  const settleProviderResultContainment = async (): Promise<DurableProviderResultDisposition> => {
    if (containmentAbsenceConfirmed) return { kind: 'absence-confirmed' };
    if (containmentAbandoned) return { kind: 'operator-abandoned' };
    if (retainedProcess?.kind === 'recorded-wrapper-group') {
      const childRoot = retainedProcess.containment.childRoot;
      if (childRoot !== null) {
        const subject = { ...retainedProcess.containment, childRoot };
        const environment = {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid: number, platform: NodeJS.Platform) =>
            runtime.process.readProcessIncarnation(pid, platform),
        } as const;
        const observation = observeRecordedContainment(subject, environment);
        if (observation.kind === 'absent') {
          await Promise.race([runtime.time.sleep(CONTAINMENT_DISAPPEARANCE_CONFIRM_MS), containmentAbsence]);
          if (containmentAbsenceConfirmed) return { kind: 'absence-confirmed' };
          if (containmentAbandoned) return { kind: 'operator-abandoned' };
          const confirmation = observeRecordedContainment(subject, environment);
          if (confirmation.kind === 'absent') {
            releaseCleanupOwnership();
            return { kind: 'absence-confirmed' };
          }
          return {
            kind: 'held',
            reason: confirmation.kind === 'unobservable' ? confirmation.reason : 'containment is still alive',
          };
        }
      }
    }

    const outcome = await cleanup();
    if (containmentAbandoned) return { kind: 'operator-abandoned' };
    return outcome.kind === 'observed-absent'
      ? { kind: 'absence-confirmed' }
      : { kind: 'held', reason: terminationOutcomeDetail(outcome) };
  };

  const publishWrapperSpawned = (launch: {
    pid: number;
    leaderIncarnation: ProcessIncarnation | null;
    signalAuthority?: DurableLaunchSignalAuthority;
  }): void => {
    if (publishedPid !== null) {
      if (publishedPid !== launch.pid) {
        throw new Error('Durable launch changed process identity after provisional publication.');
      }
      return;
    }
    publishedPid = launch.pid;
    signalAuthority = launch.signalAuthority;
    retainedProcess =
      launch.leaderIncarnation === null
        ? { kind: 'unverified-wrapper-pid', provider: options.provider, jobDir: options.jobDir, pid: launch.pid }
        : {
            kind: 'recorded-wrapper-group',
            provider: options.provider,
            jobDir: options.jobDir,
            containment: {
              pid: launch.pid,
              incarnation: launch.leaderIncarnation,
              processGroupId: launch.pid,
              childRoot: null,
            },
          };
    cleanupKey = Symbol();
    cleanupHandles.set(cleanupKey, cleanup);
    cleanupRetentions.set(cleanup, retainedProcess);
    releasePendingLaunch();
  };

  const publishSpawned = (launch: {
    runtimeRecord: Extract<JobRuntime, { transport: 'durable-cli' }>;
    leaderIncarnation: ProcessIncarnation | null;
    childRoot: DurableCliProcessSubject['childRoot'] | null;
    signalAuthority?: DurableLaunchSignalAuthority;
  }): void => {
    publishWrapperSpawned({
      pid: launch.runtimeRecord.pid,
      leaderIncarnation: launch.leaderIncarnation,
      ...(launch.signalAuthority === undefined ? {} : { signalAuthority: launch.signalAuthority }),
    });
    if (launch.leaderIncarnation !== null && launch.childRoot !== null) {
      publishedSubject = {
        pid: launch.runtimeRecord.pid,
        incarnation: launch.leaderIncarnation,
        processGroupId: launch.runtimeRecord.pid,
        childRoot: launch.childRoot,
      };
      retainedProcess = {
        kind: 'recorded-wrapper-group',
        provider: options.provider,
        jobDir: options.jobDir,
        containment: { ...publishedSubject, childRoot: publishedSubject.childRoot },
      };
      cleanupRetentions.set(cleanup, retainedProcess);
    }
    if (publishedSubject !== null) options.onDurableProcessIdentity?.(publishedSubject);
    options.onRuntimeRecord?.(launch.runtimeRecord);
  };

  try {
    if (options.signal?.aborted) {
      return { stdout: '', stderr: '', code: null, aborted: true };
    }

    const launchOptions = {
      provider: options.provider,
      command: options.command,
      args: options.args,
      prompt: options.prompt,
      cwd: options.cwd,
      jobDir: options.jobDir,
      envAdditions: options.extraEnv,
      env: options.exactEnv,
      onWrapperSpawned: publishWrapperSpawned,
      onSpawned: publishSpawned,
    };
    let durable: DurableLaunchResult;
    try {
      durable = await runtime.process.durable.launch(launchOptions);
    } catch (launchError: unknown) {
      if (cleanupKey === null) throw launchError;
      while (true) {
        const disposition = await settleProviderResultContainment();
        if (disposition.kind === 'absence-confirmed') throw launchError;
        if (disposition.kind === 'operator-abandoned') throw launchError;
        providerResultHeld = true;
        publishContainmentStatus({
          kind: 'held',
          reason: disposition.reason,
          retryIntervalMs: DURABLE_RUNTIME_POLL_INTERVAL_MS,
          abandonment: 'abort-job',
        });
        if (options.signal?.aborted) {
          abandonCleanupOwnership();
          throw launchError;
        }
        await runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
      }
    }
    if (publishedPid === null) {
      publishSpawned({
        runtimeRecord: durable.runtimeRecord,
        leaderIncarnation: durable.processSubject.incarnation,
        childRoot: durable.processSubject.childRoot,
        ...(durable.signalAuthority === undefined ? {} : { signalAuthority: durable.signalAuthority }),
      });
    } else if (publishedPid !== durable.pid) {
      throw new Error('Durable runtime readiness reported a different process from provisional publication.');
    }
    if (durable.signalAuthority !== undefined) {
      if (durable.signalAuthority.pid !== durable.pid) {
        throw new Error('Durable launch signal authority names a different process from launch readiness.');
      }
      signalAuthority = durable.signalAuthority;
    }

    let abortedBySignal = false;
    let runtimeRecord = durable.runtimeRecord;
    let tailOffset = runtimeRecord.tailWatermark ?? 0;
    const durableState: { exitRecord: DurableProcessExit | null; exitError: unknown } = {
      exitRecord: null,
      exitError: null,
    };
    let lastOutputAt = runtime.time.now();
    let lastTickAt = runtime.time.now();

    void runtime.process.durable
      .waitForExit(durable)
      .then((record) => {
        durableState.exitRecord = record;
      })
      .catch((error: unknown) => {
        durableState.exitError = error;
      });

    const drainStdout = (): void => {
      const { lines, newOffset } = readAppendedLines(durable.stdoutPath, tailOffset, runtime.storage);
      if (newOffset === tailOffset) {
        return;
      }

      tailOffset = newOffset;
      lastOutputAt = runtime.time.now();
      runtimeRecord = { ...runtimeRecord, tailWatermark: newOffset };
      options.onRuntimeRecord?.(runtimeRecord);

      for (const line of lines) {
        options.onEvent?.(line);
      }
    };

    if (options.signal) {
      abortHandler = () => {
        if (abortedBySignal) return;
        abortedBySignal = true;
        void cleanup().then(
          (outcome) => {
            if (outcome.kind !== 'observed-absent' && providerResultHeld) abandonCleanupOwnership();
          },
          (error: unknown) => {
            backendLog.warn(`[durable-process:${durable.pid}] Termination failed: ${errorMessage(error)}`);
            if (providerResultHeld) abandonCleanupOwnership();
          },
        );
      };

      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    while (true) {
      drainStdout();

      const completedExit = durableState.exitRecord;
      if (completedExit !== null) {
        const disposition = await settleProviderResultContainment();
        if (disposition.kind === 'held') {
          providerResultHeld = true;
          publishContainmentStatus({
            kind: 'held',
            reason: disposition.reason,
            retryIntervalMs: DURABLE_RUNTIME_POLL_INTERVAL_MS,
            abandonment: 'abort-job',
          });
          if (options.signal?.aborted) {
            abandonCleanupOwnership();
            continue;
          }
          await Promise.race([runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS), containmentAbsence]);
          continue;
        }
        if (providerResultHeld && disposition.kind === 'absence-confirmed') {
          publishContainmentStatus({ kind: 'absence-confirmed' });
        }
        drainStdout();
        return {
          stdout: readOutputFile(runtime.storage, durable.stdoutPath),
          stderr: readOutputFile(runtime.storage, durable.stderrPath),
          code: completedExit.exitCode,
          aborted: abortedBySignal,
        };
      }

      if (durableState.exitError) {
        throw durableState.exitError instanceof Error
          ? durableState.exitError
          : new Error(errorMessage(durableState.exitError));
      }

      const now = runtime.time.now();
      const tickGap = now - lastTickAt;
      lastTickAt = now;
      if (tickGap > IDLE_CHECK_INTERVAL * 3) {
        lastOutputAt = now;
      } else if (now - lastOutputAt >= IDLE_TIMEOUT) {
        const disposition = await cleanup();
        if (disposition.kind === 'observed-absent') {
          throw new Error(
            `Durable process ${durable.pid} terminated after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`,
          );
        }
        lastOutputAt = runtime.time.now();
      }

      await runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
    }
  } finally {
    releasePendingLaunch();
    if (abortHandler && options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (internalPermitJobId) {
      releaseLaunch(internalPermitJobId, pool);
    }
  }
}

function readOutputFile(storage: StoragePort, path: string): string {
  try {
    const stats = storage.statSync(path);
    const bytesToRead = Math.min(stats.size, MAX_BUFFER + 1);
    const fd = storage.openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = storage.readSync(fd, buffer, 0, bytesToRead, 0);
      const output = buffer.subarray(0, bytesRead).toString('utf-8');
      if (stats.size > MAX_BUFFER) {
        return output.slice(0, MAX_BUFFER) + '\n[output truncated at 10MB]';
      }
      return output;
    } finally {
      storage.closeSync(fd);
    }
  } catch {
    return '';
  }
}
