import { MAX_BUFFER } from '../../infra/process-constants.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/contracts/admission.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
import { gracefulKillByPid, type GracefulKillByPidOutcome } from '../../infra/process-supervision.js';

const IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL = 30_000;
const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;

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
  incarnation: ProcessIncarnation | null,
): Promise<GracefulKillByPidOutcome> {
  try {
    if (runtime.process.observeLiveness(pid) === 'absent') return { kind: 'observed-absent', pid };
  } catch {
    // An unavailable liveness probe does not weaken the identity required to signal.
  }
  const disposition = gracefulKillByPid(runtime, pid, incarnation);
  return disposition.kind === 'escalation-scheduled' ? disposition.settlement : disposition;
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
  /**
   * Reports the durable wrapper's recorded identity, once, at the only moment it can be captured honestly:
   * the pid is known and the process is known to be the one just launched. An incarnation probed later could
   * belong to a recycled pid, which is precisely the confusion the pair exists to prevent — so a probe that
   * comes back empty reports nothing rather than a pid on its own.
   */
  onDurableProcessIdentity?: (identity: { pid: number; incarnation: ProcessIncarnation }) => void;
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
  let publishedIncarnation: ProcessIncarnation | null = null;
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
    cleanupInFlight = requestDurableProcessTermination(runtime, pid, publishedIncarnation).then((outcome) => {
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
    incarnation: ProcessIncarnation | null;
  }): void => {
    if (publishedPid !== null) {
      if (publishedPid !== launch.runtimeRecord.pid) {
        throw new Error('Durable launch changed process identity after provisional publication.');
      }
      return;
    }
    publishedPid = launch.runtimeRecord.pid;
    publishedIncarnation = launch.incarnation;
    cleanupKey = Symbol();
    cleanupHandles.set(cleanupKey, cleanup);
    if (launch.incarnation !== null) {
      options.onDurableProcessIdentity?.({ pid: launch.runtimeRecord.pid, incarnation: launch.incarnation });
    }
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
      let incarnation: ProcessIncarnation | null;
      try {
        incarnation = runtime.process.readProcessIncarnation(durable.pid, runtime.env.platform() as NodeJS.Platform);
      } catch {
        incarnation = null;
      }
      publishSpawned({ runtimeRecord: durable.runtimeRecord, incarnation });
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
