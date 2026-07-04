import { MAX_BUFFER } from '../../infra/process-constants.js';
import { errorMessage } from '../../infra/error-format.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/contracts/admission.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
import { windowsCommandName } from '../../infra/windows-shell.js';
import { gracefulKillByPid } from './process-supervision.js';

const IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL = 30_000;
const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;

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
};

export type SpawnDurableJobOptions = SpawnCliOptions & {
  jobDir: string;
  onRuntimeRecord?: (record: JobRuntime) => void;
};

export async function spawnDurableJobTransport(params: {
  runtime: Runtime;
  options: SpawnDurableJobOptions;
  pool: LaunchPool;
  internalPermitJobId: string | null;
  cleanupHandles: Map<symbol, () => void>;
  releaseLaunch: (jobId: string, pool: LaunchPool) => void;
  shouldTerminateAfterLaunch?: () => boolean;
}): Promise<CliExecResult> {
  const { runtime, options, pool, cleanupHandles, releaseLaunch, shouldTerminateAfterLaunch } = params;
  const { internalPermitJobId } = params;
  let abortHandler: (() => void) | null = null;
  let cleanupKey: symbol | null = null;

  try {
    if (options.signal?.aborted) {
      return { stdout: '', stderr: '', code: null, aborted: true };
    }

    const durable = await runtime.process.durable.launch({
      provider: options.provider,
      command: windowsCommandName(options.command, runtime.env.platform()),
      args: options.args,
      prompt: options.prompt,
      cwd: options.cwd,
      jobDir: options.jobDir,
      envAdditions: options.extraEnv,
    });
    cleanupKey = Symbol();
    const cleanup = (): void => {
      gracefulKillByPid(runtime, durable.pid);
    };
    cleanupHandles.set(cleanupKey, cleanup);
    if (shouldTerminateAfterLaunch?.()) {
      // terminateAll may have drained before this durable child was registered.
      cleanupHandles.delete(cleanupKey);
      cleanupKey = null;
      cleanup();
    }

    let abortedBySignal = false;
    let runtimeRecord = durable.runtimeRecord;
    let tailOffset = runtimeRecord.tailWatermark ?? 0;
    options.onRuntimeRecord?.(runtimeRecord);
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
        gracefulKillByPid(runtime, durable.pid);
      };

      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    while (true) {
      drainStdout();

      const completedExit = durableState.exitRecord;
      if (completedExit !== null) {
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
        runtime.process.kill(durable.pid, 'SIGTERM');
        throw new Error(`Durable process ${durable.pid} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`);
      }

      await runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
    }
  } finally {
    if (cleanupKey !== null) {
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
