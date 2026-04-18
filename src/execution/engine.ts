import { createInterface, type Interface } from 'node:readline';
import { backendLog } from '../shared/backend-log.js';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../shared/process-constants.js';
import { buildJsonRpcError, errorMessage } from '../shared/utils.js';
import type { JobExitRecord, JobRuntimeRecord } from '../shared/types.js';
import type { ChildProcessLike, Runtime, StoragePort } from '../runtime/ports.js';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity
const IDLE_CHECK_INTERVAL = 30_000; // poll interval for idle detection

export type LaunchPool = 'default' | 'discuss' | 'curate';
export const CURATE_MAX_WORKERS = 1;
const MAX_QUEUE_SIZE = 20;

export type LaunchPermit = { type: 'immediate' };

export type QueuedHandle = {
  type: 'queued';
  queuePosition: number;
  waitForPermit: () => Promise<void>;
  cancel: () => void;
};

export type AdmissionResult = LaunchPermit | QueuedHandle | 'queue_full';

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

type QueuedLaunchEntry = {
  jobId: string;
  provider: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PoolState = { active: Map<string, string>; queued: QueuedLaunchEntry[] };

const IMMEDIATE_PERMIT: LaunchPermit = { type: 'immediate' };
const QUEUE_CANCELED_MESSAGE = 'Launch canceled while queued';
const QUEUE_DRAINED_MESSAGE = 'Launch canceled while queue was drained';

export type CliBusyErrorDetail = {
  error: 'busy';
  provider: string;
  globalActive: number;
  globalLimit: number;
};

export class CliBusyError extends Error {
  readonly detail: CliBusyErrorDetail;

  constructor(detail: CliBusyErrorDetail) {
    const message = `Runner is busy (${detail.globalActive}/${detail.globalLimit} for ${detail.provider})`;
    super(message);
    this.name = 'CliBusyError';
    this.detail = detail;
  }
}

export type SpawnCliFn = (options: SpawnCliOptions) => Promise<CliExecResult>;
export type SpawnDurableJobFn = (options: SpawnDurableJobOptions) => Promise<CliExecResult>;
export type SpawnProviderServerFn = (options: SpawnProviderServerOptions) => Promise<ProviderServerHandle>;

export class LaunchCoordinator {
  private readonly cleanupHandles = new Map<symbol, () => void>();
  private nextProviderServerGeneration = 1;
  private readonly pools: Map<LaunchPool, PoolState> = new Map<LaunchPool, PoolState>();
  private readonly signalLaunchPermits = new WeakMap<AbortSignal, { jobId: string; pool: LaunchPool }>();
  private readonly runtime: Runtime;

  constructor(options: { runtime: Runtime }) {
    this.runtime = options.runtime;
    this.pools.set('default', { active: new Map<string, string>(), queued: [] });
    this.pools.set('discuss', { active: new Map<string, string>(), queued: [] });
    this.pools.set('curate', { active: new Map<string, string>(), queued: [] });
  }

  /** Number of active launch permits across all pools. */
  get active(): number {
    let total = 0;
    for (const state of this.pools.values()) {
      total += state.active.size;
    }
    return total;
  }

  requestLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): AdmissionResult {
    const activeLaunches = this.getActiveMap(pool);
    const queuedLaunches = this.getQueue(pool);
    if (activeLaunches.has(jobId)) return IMMEDIATE_PERMIT;

    const existingQueued = this.findQueuedLaunch(jobId, pool);
    if (existingQueued) return this.queuedHandle(existingQueued, pool);

    if (queuedLaunches.length === 0 && this.hasLaunchCapacity(pool)) {
      activeLaunches.set(jobId, provider);
      return IMMEDIATE_PERMIT;
    }

    if (queuedLaunches.length >= MAX_QUEUE_SIZE) return 'queue_full';

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = { jobId, provider, promise, resolve, reject };
    queuedLaunches.push(entry);
    return this.queuedHandle(entry, pool);
  }

  releaseLaunch(jobId: string, pool: LaunchPool = 'default'): void {
    const activeLaunches = this.getActiveMap(pool);
    if (!activeLaunches.delete(jobId)) return;
    this.admitQueueHead(pool);
  }

  cancelQueued(jobId: string, pool: LaunchPool = 'default'): boolean {
    const queuedLaunches = this.getQueue(pool);
    const index = queuedLaunches.findIndex((entry) => entry.jobId === jobId);
    if (index === -1) return false;
    const [entry] = queuedLaunches.splice(index, 1);
    entry.reject(new Error(QUEUE_CANCELED_MESSAGE));
    this.admitQueueHead(pool);
    return true;
  }

  queueDepth(pool: LaunchPool = 'default'): number {
    return this.getQueue(pool).length;
  }

  queuePosition(jobId: string, pool: LaunchPool = 'default'): number | null {
    const index = this.getQueue(pool).findIndex((entry) => entry.jobId === jobId);
    return index === -1 ? null : index + 1;
  }

  getActiveJobIds(pool: LaunchPool = 'default'): string[] {
    return [...this.getActiveMap(pool).keys()];
  }

  bindLaunchPermit(jobId: string, signal: AbortSignal, pool: LaunchPool = 'default'): void {
    this.signalLaunchPermits.set(signal, { jobId, pool });
  }

  spawnCli(options: SpawnCliOptions): Promise<CliExecResult> {
    const pool = options.pool ?? 'default';
    let internalPermitJobId: string | null = null;
    try {
      internalPermitJobId = this.reserveInternalPermitOrThrow(options, pool, 'spawncli');
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let abortedBySignal = false;
      const child = this.runtime.process.spawn({
        command: options.command,
        args: options.args,
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string is not a valid cwd
        cwd: options.cwd || undefined,
        shell: this.runtime.env.platform() === 'win32',
        envAdditions: options.extraEnv,
        mode: 'piped',
      });
      const { stdin, stdout: childStdout, stderr: childStderr } = requirePipedHandles(child, options.command);
      const cleanupKey = Symbol();
      this.cleanupHandles.set(cleanupKey, () => gracefulKill(child, this.runtime));

      let lastOutputAt = this.runtime.time.now();
      let lastTickAt = this.runtime.time.now();
      const idleChecker = this.runtime.time.setInterval(() => {
        if (settled) return;
        const now = this.runtime.time.now();
        const tickGap = now - lastTickAt;
        lastTickAt = now;

        if (tickGap > IDLE_CHECK_INTERVAL * 3) {
          // Tick arrived far later than expected — system likely woke from sleep.
          // Reset baseline so the child gets a fresh idle window to resume output.
          lastOutputAt = now;
          return;
        }

        if (now - lastOutputAt >= IDLE_TIMEOUT) {
          settled = true;
          this.runtime.time.clearInterval(idleChecker);
          gracefulKill(child, this.runtime);
          this.cleanupHandles.delete(cleanupKey);
          if (internalPermitJobId) {
            this.releaseLaunch(internalPermitJobId, pool);
            internalPermitJobId = null;
          }
          reject(new Error(`${options.command} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
        }
      }, IDLE_CHECK_INTERVAL);

      const resetIdle = (): void => {
        lastOutputAt = this.runtime.time.now();
      };

      let abortHandler: (() => void) | null = null;

      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        this.runtime.time.clearInterval(idleChecker);
        this.cleanupHandles.delete(cleanupKey);
        if (internalPermitJobId) {
          this.releaseLaunch(internalPermitJobId, pool);
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
          this.runtime.time.clearInterval(idleChecker);
          gracefulKill(child, this.runtime);
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
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- split() always returns at least one element
          lineBuffer = parts.pop()!;
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

  spawnProviderServer(options: SpawnProviderServerOptions): Promise<ProviderServerHandle> {
    return this.spawnProviderServerAsync(options);
  }

  spawnDurableJob(options: SpawnDurableJobOptions): Promise<CliExecResult> {
    return this.spawnDurableJobAsync(options);
  }

  restoreActiveLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): void {
    this.getActiveMap(pool).set(jobId, provider);
  }

  restoreQueuedLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): QueuedHandle {
    const queuedLaunches = this.getQueue(pool);

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    const entry: QueuedLaunchEntry = { jobId, provider, promise, resolve, reject };
    queuedLaunches.push(entry);

    return this.queuedHandle(entry, pool);
  }

  terminateAll(): void {
    this.drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
    for (const cleanup of this.cleanupHandles.values()) {
      cleanup();
    }
    this.cleanupHandles.clear();
  }

  private getActiveMap(pool: LaunchPool): Map<string, string> {
    return (this.pools.get(pool) as PoolState).active;
  }

  private getQueue(pool: LaunchPool): QueuedLaunchEntry[] {
    return (this.pools.get(pool) as PoolState).queued;
  }

  private hasLaunchCapacity(pool: LaunchPool): boolean {
    return this.getActiveMap(pool).size < getActiveLimit(pool, this.runtime.env);
  }

  private reserveInternalPermitOrThrow(
    options: Pick<SpawnCliOptions, 'permitGranted' | 'signal' | 'provider'>,
    pool: LaunchPool,
    prefix: string,
  ): string | null {
    const usingReservedPermit =
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR: false must fall through
      options.permitGranted || (options.signal ? this.consumeSignalPermit(options.signal, options.provider) : false);
    if (usingReservedPermit) {
      return null;
    }

    const activeLaunches = this.getActiveMap(pool);
    const queuedLaunches = this.getQueue(pool);
    const globalActive = activeLaunches.size;
    const globalLimit = getActiveLimit(pool, this.runtime.env);
    if (queuedLaunches.length > 0 || globalActive >= globalLimit) {
      throw new CliBusyError({
        error: 'busy',
        provider: options.provider,
        globalActive,
        globalLimit,
      });
    }

    const internalPermitJobId = `${prefix}-${this.runtime.ids.uuid()}`;
    activeLaunches.set(internalPermitJobId, options.provider);
    return internalPermitJobId;
  }

  private queuedHandle(entry: QueuedLaunchEntry, pool: LaunchPool): QueuedHandle {
    const queue = this.getQueue(pool);
    return {
      type: 'queued',
      queuePosition: this.queuePosition(entry.jobId, pool) ?? queue.length,
      waitForPermit: () => entry.promise,
      cancel: () => {
        this.cancelQueued(entry.jobId, pool);
      },
    };
  }

  private findQueuedLaunch(jobId: string, pool: LaunchPool): QueuedLaunchEntry | null {
    for (const entry of this.getQueue(pool)) {
      if (entry.jobId === jobId) return entry;
    }
    return null;
  }

  private admitQueueHead(pool: LaunchPool): void {
    const queue = this.getQueue(pool);
    const head = queue[0];
    if (!head) return;
    if (!this.hasLaunchCapacity(pool)) return;
    queue.shift();
    this.getActiveMap(pool).set(head.jobId, head.provider);
    head.resolve();
  }

  private drainQueuedLaunches(message: string): void {
    for (const state of this.pools.values()) {
      drainQueuedLaunchPool(state.queued, message);
    }
  }

  private consumeSignalPermit(signal: AbortSignal, provider: string): boolean {
    const permit = this.signalLaunchPermits.get(signal);
    if (!permit) return false;
    this.signalLaunchPermits.delete(signal);
    return this.getActiveMap(permit.pool).get(permit.jobId) === provider;
  }

  private async spawnProviderServerAsync(options: SpawnProviderServerOptions): Promise<ProviderServerHandle> {
    const child = this.runtime.process.spawn({
      command: options.command,
      args: options.args,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string is not a valid cwd
      cwd: options.cwd || undefined,
      shell: this.runtime.env.platform() === 'win32',
      envAdditions: options.extraEnv,
      mode: 'piped',
    });
    const { stdin, stdout: childStdout, stderr: childStderr } = requirePipedHandles(child, options.command);

    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`Failed to spawn ${options.command}: child pid is unavailable`);
    }

    const generation = this.nextProviderServerGeneration;
    this.nextProviderServerGeneration += 1;

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
      handleProviderServerLine(entry, line, this.runtime);
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
      gracefulKill(child, this.runtime);
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
          gracefulKill(entry.child, this.runtime);
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
        shutdownProviderServer(entry, 'closed', this.runtime);
        await entry.closePromise;
      },
    };
  }

  private async spawnDurableJobAsync(options: SpawnDurableJobOptions): Promise<CliExecResult> {
    const pool = options.pool ?? 'default';
    let internalPermitJobId: string | null;
    try {
      internalPermitJobId = this.reserveInternalPermitOrThrow(options, pool, 'spawndurable');
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    let abortHandler: (() => void) | null = null;
    let killTimer: ReturnType<Runtime['time']['setTimeout']> | null = null;
    let cleanupKey: symbol | null = null;

    try {
      if (options.signal?.aborted) {
        return { stdout: '', stderr: '', code: null, aborted: true };
      }

      const durable = await this.runtime.process.durable.launch({
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
      this.cleanupHandles.set(cleanupKey, () => {
        this.runtime.process.kill(durable.pid, 'SIGTERM');
        const escalation = this.runtime.time.setTimeout(() => this.runtime.process.kill(durable.pid, 'SIGKILL'), SIGTERM_GRACE_MS);
        escalation.unref?.();
      });

      let abortedBySignal = false;
      let runtimeRecord = durable.runtimeRecord;
      let tailOffset = runtimeRecord.tailWatermark ?? 0;
      const durableState: { exitRecord: JobExitRecord | null; exitError: unknown } = {
        exitRecord: null,
        exitError: null,
      };
      let lastOutputAt = this.runtime.time.now();
      let lastTickAt = this.runtime.time.now();

      void this.runtime.process.durable
        .waitForExit(durable)
        .then((record) => {
          durableState.exitRecord = record;
        })
        .catch((error: unknown) => {
          durableState.exitError = error;
        });

      const drainStdout = (): void => {
        const { lines, newOffset } = readAppendedLines(this.runtime.storage, durable.stdoutPath, tailOffset);
        if (newOffset === tailOffset) {
          return;
        }

        tailOffset = newOffset;
        lastOutputAt = this.runtime.time.now();
        runtimeRecord = { ...runtimeRecord, tailWatermark: newOffset };
        try {
          writeRuntimeRecord(this.runtime.storage, options.jobDir, runtimeRecord);
        } catch {
          /* best effort */
        }

        for (const line of lines) {
          options.onEvent?.(line);
        }
      };

      if (options.signal) {
        abortHandler = () => {
          if (abortedBySignal) return;
          abortedBySignal = true;
          this.runtime.process.kill(durable.pid, 'SIGTERM');
          killTimer = this.runtime.time.setTimeout(() => {
            this.runtime.process.kill(durable.pid, 'SIGKILL');
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
            stdout: readOutputFile(this.runtime.storage, durable.stdoutPath),
            stderr: readOutputFile(this.runtime.storage, durable.stderrPath),
            code: completedExit.exitCode,
            aborted: abortedBySignal,
          };
        }

        if (durableState.exitError) {
          throw durableState.exitError instanceof Error
            ? durableState.exitError
            : new Error(errorMessage(durableState.exitError));
        }

        // Idle timeout — mirrors spawnCli's 10-minute inactivity kill
        const now = this.runtime.time.now();
        const tickGap = now - lastTickAt;
        lastTickAt = now;
        if (tickGap > IDLE_CHECK_INTERVAL * 3) {
          // System likely woke from sleep — reset baseline
          lastOutputAt = now;
        } else if (now - lastOutputAt >= IDLE_TIMEOUT) {
          this.runtime.process.kill(durable.pid, 'SIGTERM');
          throw new Error(
            `Durable process ${durable.pid} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`,
          );
        }

        await this.runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
      }
    } finally {
      if (cleanupKey !== null) {
        this.cleanupHandles.delete(cleanupKey);
      }
      if (killTimer) this.runtime.time.clearTimeout(killTimer);
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (internalPermitJobId) {
        this.releaseLaunch(internalPermitJobId, pool);
      }
    }
  }
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getMaxWorkers(env: Pick<Runtime['env'], 'get'>): number {
  return Math.min(Math.max(parsePositiveInt(env.get('CORAL_MAX_WORKERS'), 10), 1), 10);
}

export function getDiscussMaxWorkers(env: Pick<Runtime['env'], 'get'>): number {
  return Math.min(Math.max(parsePositiveInt(env.get('CORAL_DISCUSS_MAX_WORKERS'), 5), 1), 10);
}

function getActiveLimit(pool: LaunchPool, env: Pick<Runtime['env'], 'get'>): number {
  if (pool === 'discuss') {
    return getDiscussMaxWorkers(env);
  }
  if (pool === 'curate') {
    return CURATE_MAX_WORKERS;
  }
  return getMaxWorkers(env);
}

function drainQueuedLaunchPool(queue: QueuedLaunchEntry[], message: string): void {
  const drained = queue.splice(0, queue.length);
  const error = new Error(message);
  for (const entry of drained) {
    entry.reject(error);
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
};

export type SpawnProviderServerOptions = {
  provider: string;
  command: string;
  args: string[];
  cwd?: string;
  extraEnv?: Record<string, string>;
  /** If set, send this JSON-RPC request immediately after spawn and await the response before returning the handle. */
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
};

const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;
const RUNTIME_FILE = 'runtime.json';

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

function readAppendedLines(storage: StoragePort, path: string, fromOffset: number): { lines: string[]; newOffset: number } {
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

function writeRuntimeRecord(storage: StoragePort, jobDir: string, record: JobRuntimeRecord): void {
  const runtimePath = `${jobDir}/${RUNTIME_FILE}`;
  const tmpPath = `${runtimePath}.tmp`;
  storage.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  storage.renameSync(tmpPath, runtimePath);
}
