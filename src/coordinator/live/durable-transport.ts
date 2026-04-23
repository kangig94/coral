import { createInterface, type Interface } from 'node:readline';
import { backendLog } from '../../infra/backend-log.js';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../../infra/process-constants.js';
import { buildJsonRpcError } from '../../infra/json-rpc-error.js';
import { errorMessage } from '../../infra/error-format.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/launch.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { ChildProcessLike, Runtime, StoragePort } from '../../runtime/ports.js';

const IDLE_TIMEOUT = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL = 30_000;
const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;

export type CliExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type ProviderServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type ProviderServerPendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type ProviderServerRpc = {
  request: <TResult = unknown>(method: string, params?: Record<string, unknown>) => Promise<TResult>;
  notify: (method: string, params?: Record<string, unknown>) => void;
};

export type ProviderServerHandle = {
  pid: number;
  child: ChildProcessLike;
  generation: number;
  rpc: ProviderServerRpc;
  onNotification: (handler: (message: ProviderServerNotification) => void) => () => void;
  closePromise: Promise<Error | void>;
  markExpectedClose: () => void;
  close: () => Promise<void>;
};

type ProviderServerEntry = {
  provider: string;
  child: ChildProcessLike;
  pid: number;
  generation: number;
  pending: Map<number, ProviderServerPendingRequest>;
  nextRequestId: number;
  notificationHandlers: Set<(message: ProviderServerNotification) => void>;
  readline: Interface;
  stderr: string;
  closed: boolean;
  closeRequested: boolean;
  closePromise: Promise<Error | void>;
  resolveClose: (outcome: Error | void) => void;
  closeOutcome: Error | void;
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

export type SpawnProviderServerOptions = {
  provider: string;
  command: string;
  args: string[];
  cwd?: string;
  extraEnv?: Record<string, string>;
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
};

export type SpawnCliFn = (options: SpawnCliOptions) => Promise<CliExecResult>;
export type SpawnDurableJobFn = (options: SpawnDurableJobOptions) => Promise<CliExecResult>;
export type SpawnProviderServerFn = (options: SpawnProviderServerOptions) => Promise<ProviderServerHandle>;

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

export async function spawnProviderServerTransport(params: {
  runtime: Runtime;
  options: SpawnProviderServerOptions;
  generation: number;
}): Promise<ProviderServerHandle> {
  const { runtime, options, generation } = params;
  const child = runtime.process.spawn({
    command: options.command,
    args: options.args,
    cwd: options.cwd === '' ? undefined : options.cwd,
    shell: runtime.env.platform() === 'win32',
    envAdditions: options.extraEnv,
    mode: 'piped',
  });
  const { stdin, stdout: childStdout, stderr: childStderr } = requirePipedHandles(child, options.command);

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to spawn ${options.command}: child pid is unavailable`);
  }

  childStdout.setEncoding('utf8');
  childStderr.setEncoding('utf8');

  let resolveClose!: (outcome: Error | void) => void;
  const closePromise = new Promise<Error | void>((resolve) => {
    resolveClose = resolve;
  });

  const entry: ProviderServerEntry = {
    provider: options.provider,
    child,
    pid,
    generation,
    pending: new Map(),
    nextRequestId: 1,
    notificationHandlers: new Set(),
    readline: createInterface({ input: childStdout as unknown as NodeJS.ReadableStream }),
    stderr: '',
    closed: false,
    closeRequested: false,
    closePromise,
    resolveClose,
    closeOutcome: undefined,
  };

  const finalizeClose = (outcome?: Error): void => {
    if (outcome) {
      entry.closeOutcome = outcome;
    }
    detachProviderServer(entry, outcome);
    entry.resolveClose(entry.closeRequested ? undefined : entry.closeOutcome);
  };

  entry.readline.on('line', (line: string) => {
    handleProviderServerLine(entry, line, runtime);
  });

  childStderr.on('data', (chunk: string | Buffer) => {
    entry.stderr = appendBuffer(entry.stderr, chunk.toString());
  });

  stdin.on('error', (error: Error) => {
    if (entry.closed) return;
    const stdinError = createProviderServerError(entry.provider, `stdin error: ${error.message}`, {
      stderr: entry.stderr,
    });
    backendLog.error(stdinError.message, error);
    detachProviderServer(entry, stdinError);
    gracefulKill(child, runtime);
  });

  child.on('error', (error: Error) => {
    const closeError = createProviderServerError(options.provider, `failed: ${error.message}`, {
      stderr: entry.stderr,
    });
    if (!entry.closeRequested) {
      backendLog.error(`Provider server ${options.provider} failed`, error);
    }
    detachProviderServer(entry, closeError);
    entry.resolveClose(entry.closeRequested ? undefined : closeError);
  });

  child.on('close', (code, signal) => {
    let closeError: Error | undefined;
    if (!entry.closeRequested) {
      const detail = signal ? `exited unexpectedly (signal ${signal})` : `exited unexpectedly (exit ${code})`;
      closeError = createProviderServerError(options.provider, detail, { stderr: entry.stderr });
      if (code !== 0 || signal !== null) {
        backendLog.error(closeError.message);
      }
    }
    finalizeClose(closeError);
  });

  const rpc: ProviderServerRpc = {
    request: <TResult = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TResult> => {
      if (entry.closed) {
        return Promise.reject(createProviderServerError(entry.provider, 'is closed', { stderr: entry.stderr }));
      }

      const id = entry.nextRequestId;
      entry.nextRequestId += 1;

      return new Promise<TResult>((resolve, reject) => {
        entry.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
        try {
          sendProviderServerMessage(entry, { id, method, params });
        } catch (error) {
          entry.pending.delete(id);
          reject(
            error instanceof Error ? error : createProviderServerError(entry.provider, `failed to send ${method}`),
          );
        }
      });
    },
    notify: (method: string, params: Record<string, unknown> = {}): void => {
      if (entry.closed) return;
      try {
        sendProviderServerMessage(entry, { method, params });
      } catch (error) {
        const notifyError =
          error instanceof Error ? error : createProviderServerError(entry.provider, `failed to send ${method}`);
        backendLog.error(notifyError.message, error);
        detachProviderServer(entry, notifyError);
        gracefulKill(entry.child, runtime);
      }
    },
  };

  if (options.initializeRequest) {
    await rpc.request(options.initializeRequest.method, options.initializeRequest.params);
  }

  return {
    pid,
    child,
    generation,
    rpc,
    onNotification: (handler: (message: ProviderServerNotification) => void): (() => void) => {
      if (entry.closed) return () => {};
      entry.notificationHandlers.add(handler);
      return () => {
        entry.notificationHandlers.delete(handler);
      };
    },
    closePromise,
    markExpectedClose: () => {
      entry.closeRequested = true;
    },
    close: async () => {
      shutdownProviderServer(entry, 'closed', runtime);
      await entry.closePromise;
    },
  };
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
      pool,
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

function safeKill(child: ChildProcessLike, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

function gracefulKill(child: ChildProcessLike, runtime: Runtime): void {
  safeKill(child, 'SIGTERM');
  const killTimer = runtime.time.setTimeout(() => {
    safeKill(child, 'SIGKILL');
  }, SIGTERM_GRACE_MS);
  child.on('close', () => runtime.time.clearTimeout(killTimer));
}

function requirePipedHandles(
  child: ChildProcessLike,
  command: string,
): {
  stdin: NonNullable<ChildProcessLike['stdin']>;
  stdout: NonNullable<ChildProcessLike['stdout']>;
  stderr: NonNullable<ChildProcessLike['stderr']>;
} {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(`Failed to spawn ${command}: piped stdio handles are unavailable`);
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function appendBuffer(current: string, chunk: string): string {
  if (current.length >= MAX_BUFFER) return current;
  const combined = current + chunk;
  if (combined.length > MAX_BUFFER) {
    return combined.slice(0, MAX_BUFFER) + '\n[output truncated at 10MB]';
  }
  return combined;
}

function createProviderServerError(
  provider: string,
  detail: string,
  extra?: { stderr?: string; rpcCode?: number; data?: unknown },
): Error {
  const stderr = extra?.stderr?.trim();
  const suffix = stderr ? `: ${stderr}` : '';
  const error = new Error(`Provider server ${provider} ${detail}${suffix}`) as Error & {
    rpcCode?: number;
    data?: unknown;
  };
  if (extra?.rpcCode !== undefined) error.rpcCode = extra.rpcCode;
  if (extra?.data !== undefined) error.data = extra.data;
  return error;
}

function rejectPendingProviderRequests(entry: ProviderServerEntry, error: Error): void {
  for (const pending of entry.pending.values()) {
    pending.reject(error);
  }
  entry.pending.clear();
}

function detachProviderServer(entry: ProviderServerEntry, error?: Error): void {
  if (entry.closed) return;
  entry.closed = true;
  if (error) {
    entry.closeOutcome = error;
  }
  entry.notificationHandlers.clear();
  rejectPendingProviderRequests(
    entry,
    error ?? createProviderServerError(entry.provider, 'closed', { stderr: entry.stderr }),
  );
  entry.readline.close();
}

function encodeProviderServerMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function sendProviderServerMessage(entry: ProviderServerEntry, message: unknown): void {
  const stdin = entry.child.stdin;
  if (entry.closed || !stdin || stdin.destroyed) {
    throw createProviderServerError(entry.provider, 'stdin is not available', { stderr: entry.stderr });
  }
  stdin.write(encodeProviderServerMessage(message));
}

function handleProviderServerLine(entry: ProviderServerEntry, line: string, runtime: Runtime): void {
  if (!line.trim() || entry.closed) return;

  let message: {
    id?: number;
    method?: string;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown };
    params?: Record<string, unknown>;
  };
  try {
    message = JSON.parse(line) as typeof message;
  } catch (error) {
    const parseError = createProviderServerError(entry.provider, 'emitted invalid JSONL', {
      stderr: entry.stderr,
      data: { line, message: error instanceof Error ? error.message : String(error) },
    });
    backendLog.error(parseError.message, error);
    detachProviderServer(entry, parseError);
    gracefulKill(entry.child, runtime);
    return;
  }

  if (typeof message.id === 'number' && typeof message.method === 'string') {
    try {
      sendProviderServerMessage(entry, {
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported provider-server request: ${message.method}`),
      });
    } catch (error) {
      const protocolError =
        error instanceof Error ? error : createProviderServerError(entry.provider, 'failed to answer server request');
      backendLog.error(protocolError.message, error);
      detachProviderServer(entry, protocolError);
      gracefulKill(entry.child, runtime);
    }
    return;
  }

  if (typeof message.id === 'number') {
    const pending = entry.pending.get(message.id);
    if (!pending) return;
    entry.pending.delete(message.id);

    if (message.error) {
      pending.reject(
        createProviderServerError(entry.provider, `${pending.method} failed`, {
          stderr: entry.stderr,
          rpcCode: message.error.code,
          data: message.error.data,
        }),
      );
      return;
    }

    pending.resolve(message.result);
    return;
  }

  if (typeof message.method !== 'string') {
    const protocolError = createProviderServerError(entry.provider, 'emitted a malformed JSON-RPC message', {
      stderr: entry.stderr,
      data: message,
    });
    backendLog.error(protocolError.message);
    detachProviderServer(entry, protocolError);
    gracefulKill(entry.child, runtime);
    return;
  }

  const notification: ProviderServerNotification = {
    method: message.method,
    params: message.params,
  };
  for (const handler of entry.notificationHandlers) {
    handler(notification);
  }
}

function beginProviderServerShutdown(entry: ProviderServerEntry, detail: string): void {
  if (entry.closed) return;
  entry.closeRequested = true;
  detachProviderServer(entry, createProviderServerError(entry.provider, detail, { stderr: entry.stderr }));
}

function shutdownProviderServer(entry: ProviderServerEntry, detail: string, runtime: Runtime): void {
  beginProviderServerShutdown(entry, detail);
  gracefulKill(entry.child, runtime);
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
