import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../../infra/process-constants.js';
import { errorMessage } from '../../infra/error-format.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/launch.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { Runtime, StoragePort } from '../../runtime/ports.js';
import { appendBuffer, gracefulKill, requirePipedHandles } from './process-helpers.js';

export { spawnProviderServerTransport } from './provider-server-transport.js';
export type {
  ProviderServerHandle,
  ProviderServerNotification,
  ProviderServerRpc,
  SpawnProviderServerFn,
  SpawnProviderServerOptions,
} from './provider-server-transport.js';

const IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL = 30_000;
const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;

export type CliExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type SpawnCliOptions = {
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

export type SpawnCliFn = (options: SpawnCliOptions) => Promise<CliExecResult>;
export type SpawnDurableJobFn = (options: SpawnDurableJobOptions) => Promise<CliExecResult>;

export function spawnCliTransport(params: {
  runtime: Runtime;
  options: SpawnCliOptions;
  pool: LaunchPool;
  internalPermitJobId: string | null;
  cleanupHandles: Map<symbol, () => void>;
  releaseLaunch: (jobId: string, pool: LaunchPool) => void;
}): Promise<CliExecResult> {
  const { runtime, options, pool, cleanupHandles, releaseLaunch } = params;
  let { internalPermitJobId } = params;

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortedBySignal = false;
    const child = runtime.process.spawn({
      command: options.command,
      args: options.args,
      cwd: options.cwd === '' ? undefined : options.cwd,
      shell: runtime.env.platform() === 'win32',
      envAdditions: options.extraEnv,
      mode: 'piped',
    });
    const { stdin, stdout: childStdout, stderr: childStderr } = requirePipedHandles(child, options.command);
    const cleanupKey = Symbol();
    cleanupHandles.set(cleanupKey, () => gracefulKill(child, runtime));

    let lastOutputAt = runtime.time.now();
    let lastTickAt = runtime.time.now();
    const idleChecker = runtime.time.setInterval(() => {
      if (settled) return;
      const now = runtime.time.now();
      const tickGap = now - lastTickAt;
      lastTickAt = now;

      if (tickGap > IDLE_CHECK_INTERVAL * 3) {
        lastOutputAt = now;
        return;
      }

      if (now - lastOutputAt >= IDLE_TIMEOUT) {
        settled = true;
        runtime.time.clearInterval(idleChecker);
        gracefulKill(child, runtime);
        cleanupHandles.delete(cleanupKey);
        if (internalPermitJobId) {
          releaseLaunch(internalPermitJobId, pool);
          internalPermitJobId = null;
        }
        reject(new Error(`${options.command} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
      }
    }, IDLE_CHECK_INTERVAL);

    const resetIdle = (): void => {
      lastOutputAt = runtime.time.now();
    };

    let abortHandler: (() => void) | null = null;

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      runtime.time.clearInterval(idleChecker);
      cleanupHandles.delete(cleanupKey);
      if (internalPermitJobId) {
        releaseLaunch(internalPermitJobId, pool);
        internalPermitJobId = null;
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
      return true;
    };

    if (options.signal) {
      abortHandler = () => {
        if (settled) return;
        abortedBySignal = true;
        runtime.time.clearInterval(idleChecker);
        gracefulKill(child, runtime);
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    childStdout.on('data', (data: string | Buffer) => {
      const chunk = data.toString();
      resetIdle();
      stdout = appendBuffer(stdout, chunk);
      if (options.onEvent) {
        lineBuffer += chunk;
        const parts = lineBuffer.split('\n');
        lineBuffer = parts.pop() ?? '';
        for (const line of parts) {
          if (line.trim()) options.onEvent(line);
        }
      }
    });

    childStderr.on('data', (data: string | Buffer) => {
      resetIdle();
      stderr = appendBuffer(stderr, data.toString());
    });

    child.on('close', (code) => {
      if (finish()) resolve({ stdout, stderr, code, aborted: abortedBySignal });
    });

    child.on('error', (err) => {
      if (finish()) reject(new Error(`Failed to spawn ${options.command}: ${err.message}`));
    });

    if (options.prompt) {
      stdin.on('error', (err) => {
        if (finish()) {
          child.kill('SIGTERM');
          reject(new Error(`Stdin write error: ${err.message}`));
        }
      });
      stdin.write(options.prompt);
    }
    stdin.end();
  });
}

export async function spawnDurableJobTransport(params: {
  runtime: Runtime;
  options: SpawnDurableJobOptions;
  pool: LaunchPool;
  internalPermitJobId: string | null;
  cleanupHandles: Map<symbol, () => void>;
  releaseLaunch: (jobId: string, pool: LaunchPool) => void;
}): Promise<CliExecResult> {
  const { runtime, options, pool, cleanupHandles, releaseLaunch } = params;
  const { internalPermitJobId } = params;
  let abortHandler: (() => void) | null = null;
  let killTimer: ReturnType<Runtime['time']['setTimeout']> | null = null;
  let cleanupKey: symbol | null = null;

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
    });
    cleanupKey = Symbol();
    cleanupHandles.set(cleanupKey, () => {
      runtime.process.kill(durable.pid, 'SIGTERM');
      const escalation = runtime.time.setTimeout(() => runtime.process.kill(durable.pid, 'SIGKILL'), SIGTERM_GRACE_MS);
      escalation.unref?.();
    });

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
      const { lines, newOffset } = readAppendedLines(runtime.storage, durable.stdoutPath, tailOffset);
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
        runtime.process.kill(durable.pid, 'SIGTERM');
        killTimer = runtime.time.setTimeout(() => {
          runtime.process.kill(durable.pid, 'SIGKILL');
        }, SIGTERM_GRACE_MS);
        killTimer.unref?.();
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
    if (killTimer) runtime.time.clearTimeout(killTimer);
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

function readAppendedLines(
  storage: StoragePort,
  path: string,
  fromOffset: number,
): { lines: string[]; newOffset: number } {
  try {
    const stats = storage.statSync(path);
    if (stats.size <= fromOffset) {
      return { lines: [], newOffset: fromOffset };
    }

    const byteLength = stats.size - fromOffset;
    const fd = storage.openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(byteLength);
      const bytesRead = storage.readSync(fd, buffer, 0, byteLength, fromOffset);
      if (bytesRead <= 0) {
        return { lines: [], newOffset: fromOffset };
      }

      const chunk = buffer.subarray(0, bytesRead);
      const lastNewlineIndex = chunk.lastIndexOf(0x0a);
      if (lastNewlineIndex === -1) {
        return { lines: [], newOffset: fromOffset };
      }

      const completeChunk = chunk.subarray(0, lastNewlineIndex + 1).toString('utf-8');
      const lines = completeChunk
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        .filter((line) => line.trim().length > 0);

      return {
        lines,
        newOffset: fromOffset + lastNewlineIndex + 1,
      };
    } finally {
      storage.closeSync(fd);
    }
  } catch {
    return { lines: [], newOffset: fromOffset };
  }
}
