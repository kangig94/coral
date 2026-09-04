import { MAX_BUFFER } from '../../infra/process-constants.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/contracts/admission.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { DurableCliProcessSubject, Runtime } from '../../runtime/ports.js';
import { type GracefulKillByPidOutcome } from '../../infra/process-supervision.js';
import { createMonotonicClock } from '../../infra/monotonic-clock.js';
import { ProcessContainmentError, reapRecordedContainment } from '../../infra/process-containment.js';
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

async function requestDurableProcessTermination(
  runtime: Runtime,
  pid: number,
  subject: DurableCliProcessSubject | null,
): Promise<GracefulKillByPidOutcome> {
  if (subject === null) return { kind: 'signal-refused', pid, reason: 'recorded-incarnation-unavailable' };
  const clock = createMonotonicClock(durableProcessCleanupClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds),
  });
  try {
    const outcome = await reapRecordedContainment(
      { pid: subject.pid, incarnation: subject.incarnation, processGroupId: subject.processGroupId },
      [subject.childRoot],
      clock.shiftMilliseconds(clock.now(), DURABLE_PROCESS_CLEANUP_DEADLINE_MS),
      {
        maxRecordedRoots: 1,
        clock,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (targetPid, platform) => runtime.process.readProcessIncarnation(targetPid, platform),
      },
    );
    return outcome.kind === 'containment-absent'
      ? { kind: 'observed-absent', pid }
      : { kind: 'signal-refused', pid, reason: 'expected-incarnation-mismatch' };
  } catch (error: unknown) {
    if (error instanceof ProcessContainmentError && error.code === 'process_identity_unverified') {
      return { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
    }
    return { kind: 'target-unobservable', pid, stage: 'after-sigkill' };
  }
}

export type DurableProcessCleanup = () => Promise<GracefulKillByPidOutcome>;

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
  onDurableProcessIdentity?: (identity: DurableCliProcessSubject) => void;
};

export async function spawnDurableJobTransport(params: {
  runtime: Runtime;
  options: SpawnDurableJobOptions;
  pool: LaunchPool;
  internalPermitJobId: string | null;
  cleanupHandles: Map<symbol, DurableProcessCleanup>;
  pendingLaunches: Set<Promise<void>>;
  releaseLaunch: (jobId: string, pool: LaunchPool) => void;
}): Promise<CliExecResult> {
  const { runtime, options, pool, cleanupHandles, pendingLaunches, releaseLaunch } = params;
  const { internalPermitJobId } = params;
  let abortHandler: (() => void) | null = null;
  let cleanupKey: symbol | null = null;
  let cleanupInFlight: Promise<GracefulKillByPidOutcome> | null = null;
  let durableExitObserved = false;
  let lastUnsettledDetail: string | null = null;
  let publishedPid: number | null = null;
  let publishedSubject: DurableCliProcessSubject | null = null;
  let resolvePendingLaunch!: () => void;
  let pendingLaunchOwned = true;
  const pendingLaunch = new Promise<void>((resolve) => {
    resolvePendingLaunch = resolve;
  });
  const releasePendingLaunch = (): void => {
    if (!pendingLaunchOwned) return;
    pendingLaunchOwned = false;
    pendingLaunches.delete(pendingLaunch);
    resolvePendingLaunch();
  };
  pendingLaunches.add(pendingLaunch);

  const cleanup = (): Promise<GracefulKillByPidOutcome> => {
    if (cleanupInFlight !== null) return cleanupInFlight;
    if (publishedPid === null)
      throw new Error('Durable cleanup was requested before a process identity was published.');
    const pid = publishedPid;
    cleanupInFlight = requestDurableProcessTermination(runtime, pid, publishedSubject).then((outcome) => {
      if (outcome.kind === 'observed-absent' && cleanupKey !== null) {
        cleanupHandles.delete(cleanupKey);
        cleanupKey = null;
        lastUnsettledDetail = null;
      } else if (outcome.kind !== 'observed-absent') {
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

  const publishSpawned = (launch: {
    runtimeRecord: Extract<JobRuntime, { transport: 'durable-cli' }>;
    leaderIncarnation: ProcessIncarnation | null;
    childPid: number | null;
  }): void => {
    if (publishedPid !== null) {
      if (publishedPid !== launch.runtimeRecord.pid) {
        throw new Error('Durable launch changed process identity after provisional publication.');
      }
      return;
    }
    publishedPid = launch.runtimeRecord.pid;
    let childIncarnation: ProcessIncarnation | null = null;
    if (launch.childPid !== null) {
      try {
        childIncarnation = runtime.process.readProcessIncarnation(
          launch.childPid,
          runtime.env.platform() as NodeJS.Platform,
        );
      } catch {
        childIncarnation = null;
      }
    }
    if (launch.leaderIncarnation !== null && launch.childPid !== null && childIncarnation !== null) {
      publishedSubject = {
        pid: launch.runtimeRecord.pid,
        incarnation: launch.leaderIncarnation,
        processGroupId: launch.runtimeRecord.pid,
        childRoot: { pid: launch.childPid, incarnation: childIncarnation },
      };
    }
    cleanupKey = Symbol();
    cleanupHandles.set(cleanupKey, cleanup);
    if (publishedSubject !== null) options.onDurableProcessIdentity?.(publishedSubject);
    options.onRuntimeRecord?.(launch.runtimeRecord);
    releasePendingLaunch();
  };

  try {
    if (options.signal?.aborted) {
      return { stdout: '', stderr: '', code: null, aborted: true };
    }

    const durable = await runtime.process.durable.launch({
      provider: options.provider,
      command: options.command,
      args: options.args,
      prompt: options.prompt,
      cwd: options.cwd,
      jobDir: options.jobDir,
      envAdditions: options.extraEnv,
      env: options.exactEnv,
      onSpawned: publishSpawned,
    });
    if (publishedPid === null) {
      let leaderIncarnation: ProcessIncarnation | null;
      try {
        leaderIncarnation = runtime.process.readProcessIncarnation(
          durable.pid,
          runtime.env.platform() as NodeJS.Platform,
        );
      } catch {
        leaderIncarnation = null;
      }
      publishSpawned({ runtimeRecord: durable.runtimeRecord, leaderIncarnation, childPid: null });
    } else if (publishedPid !== durable.pid) {
      throw new Error('Durable runtime readiness reported a different process from provisional publication.');
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
        void cleanup().catch((error: unknown) => {
          backendLog.warn(`[durable-process:${durable.pid}] Termination failed: ${errorMessage(error)}`);
        });
      };

      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    while (true) {
      drainStdout();

      const completedExit = durableState.exitRecord;
      if (completedExit !== null) {
        durableExitObserved = true;
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
    if (durableExitObserved && cleanupKey !== null) {
      cleanupHandles.delete(cleanupKey);
    }
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
