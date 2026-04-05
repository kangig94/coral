import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { backendLog } from '../shared/backend-log.js';
import { buildChildEnv } from '../shared/child-env.js';
import { readAppendedLines } from '../shared/file-tail.js';
import { buildJsonRpcError } from '../shared/mcp-utils.js';
import {
  isDurableCliRuntime,
  type DurableCliRuntimeRecord,
  type PersistedExitRecord,
  type PersistedRuntimeRecord,
} from '../shared/types.js';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity
const IDLE_CHECK_INTERVAL = 30_000; // poll interval for idle detection
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const SIGTERM_GRACE_MS = 5_000; // grace period before escalating to SIGKILL

export const MAX_ACTIVE_SESSIONS = Math.min(Math.max(parsePositiveInt(process.env.CORAL_MAX_SESSIONS, 10), 1), 10);
export type LaunchPool = 'default' | 'discuss' | 'curate';
export const DISCUSS_MAX_ACTIVE_SESSIONS = Math.min(
  Math.max(parsePositiveInt(process.env.CORAL_DISCUSS_MAX_SESSIONS, 5), 1),
  10,
);
export const CURATE_MAX_ACTIVE_SESSIONS = 1;
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
  child: ChildProcess;
  generation: number;
  rpc: ProviderServerRpc;
  onNotification: (handler: (message: ProviderServerNotification) => void) => () => void;
  closePromise: Promise<Error | void>;
  markExpectedClose: () => void;
  close: () => Promise<void>;
};

type ActiveChild = {
  provider: string;
  child: ChildProcess;
};

type ProviderServerEntry = {
  provider: string;
  child: ChildProcess;
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
  private readonly activeChildrenSet = new Set<ActiveChild>();
  private readonly activeDurablePidsSet = new Set<number>();
  private nextProviderServerGeneration = 1;
  private readonly activeLaunchesDefault = new Map<string, string>();
  private readonly activeLaunchesDiscuss = new Map<string, string>();
  private readonly activeLaunchesCurate = new Map<string, string>();
  private readonly queuedLaunchesDefault: QueuedLaunchEntry[] = [];
  private readonly queuedLaunchesDiscuss: QueuedLaunchEntry[] = [];
  private readonly queuedLaunchesCurate: QueuedLaunchEntry[] = [];
  private readonly signalLaunchPermits = new WeakMap<AbortSignal, { jobId: string; pool: LaunchPool }>();

  get activeChildren(): ReadonlySet<ActiveChild> {
    return this.activeChildrenSet;
  }

  get activeDurablePids(): ReadonlySet<number> {
    return this.activeDurablePidsSet;
  }

  get activeChildCount(): number {
    return this.activeChildrenSet.size;
  }

  get activeDurablePidCount(): number {
    return this.activeDurablePidsSet.size;
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
    const usingReservedPermit =
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR: false must fall through
      options.permitGranted || (options.signal ? this.consumeSignalPermit(options.signal, options.provider) : false);
    let internalPermitJobId: string | null = null;

    if (!usingReservedPermit) {
      const activeLaunches = this.getActiveMap(pool);
      const queuedLaunches = this.getQueue(pool);
      const globalActive = activeLaunches.size;
      const globalLimit = getActiveLimit(pool);
      if (queuedLaunches.length > 0 || globalActive >= globalLimit) {
        return Promise.reject(
          new CliBusyError({
            error: 'busy',
            provider: options.provider,
            globalActive,
            globalLimit,
          }),
        );
      }
      internalPermitJobId = `spawncli-${randomUUID()}`;
      activeLaunches.set(internalPermitJobId, options.provider);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let abortedBySignal = false;

      const child = spawn(options.command, options.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string is not a valid cwd
        cwd: options.cwd || undefined,
        shell: process.platform === 'win32',
        env: buildChildEnv(options.extraEnv),
      });
      const entry: ActiveChild = { provider: options.provider, child };
      this.activeChildrenSet.add(entry);

      let lastOutputAt = Date.now();
      let lastTickAt = Date.now();
      const idleChecker = setInterval(() => {
        if (settled) return;
        const now = Date.now();
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
          clearInterval(idleChecker);
          gracefulKill(child);
          this.activeChildrenSet.delete(entry);
          if (internalPermitJobId) {
            this.releaseLaunch(internalPermitJobId, pool);
            internalPermitJobId = null;
          }
          reject(new Error(`${options.command} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
        }
      }, IDLE_CHECK_INTERVAL);

      function resetIdle() {
        lastOutputAt = Date.now();
      }

      let abortHandler: (() => void) | null = null;

      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearInterval(idleChecker);
        this.activeChildrenSet.delete(entry);
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
          clearInterval(idleChecker);
          gracefulKill(child);
        };
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      let stdout = '';
      let stderr = '';
      let lineBuffer = '';

      child.stdout.on('data', (data: Buffer) => {
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

      child.stderr.on('data', (data: Buffer) => {
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
        child.stdin.on('error', (err) => {
          if (finish()) {
            child.kill('SIGTERM');
            reject(new Error(`Stdin write error: ${err.message}`));
          }
        });
        child.stdin.write(options.prompt);
      }
      child.stdin.end();
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

  killAllChildren(): void {
    this.drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
    for (const { child } of this.activeChildrenSet) {
      gracefulKill(child);
    }
    this.activeChildrenSet.clear();
    for (const pid of this.activeDurablePidsSet) {
      safeKillPid(pid, 'SIGTERM');
      const escalation = setTimeout(() => safeKillPid(pid, 'SIGKILL'), SIGTERM_GRACE_MS);
      escalation.unref?.();
    }
    this.activeDurablePidsSet.clear();
  }

  private getActiveMap(pool: LaunchPool): Map<string, string> {
    if (pool === 'discuss') {
      return this.activeLaunchesDiscuss;
    }
    if (pool === 'curate') {
      return this.activeLaunchesCurate;
    }
    return this.activeLaunchesDefault;
  }

  private getQueue(pool: LaunchPool): QueuedLaunchEntry[] {
    if (pool === 'discuss') {
      return this.queuedLaunchesDiscuss;
    }
    if (pool === 'curate') {
      return this.queuedLaunchesCurate;
    }
    return this.queuedLaunchesDefault;
  }

  private hasLaunchCapacity(pool: LaunchPool): boolean {
    return this.getActiveMap(pool).size < getActiveLimit(pool);
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
    drainQueuedLaunchPool(this.queuedLaunchesDefault, message);
    drainQueuedLaunchPool(this.queuedLaunchesDiscuss, message);
    drainQueuedLaunchPool(this.queuedLaunchesCurate, message);
  }

  private consumeSignalPermit(signal: AbortSignal, provider: string): boolean {
    const permit = this.signalLaunchPermits.get(signal);
    if (!permit) return false;
    this.signalLaunchPermits.delete(signal);
    return this.getActiveMap(permit.pool).get(permit.jobId) === provider;
  }

  private async spawnProviderServerAsync(options: SpawnProviderServerOptions): Promise<ProviderServerHandle> {
    const child = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string is not a valid cwd
      cwd: options.cwd || undefined,
      shell: process.platform === 'win32',
      env: buildChildEnv(options.extraEnv),
    });

    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`Failed to spawn ${options.command}: child pid is unavailable`);
    }

    const generation = this.nextProviderServerGeneration;
    this.nextProviderServerGeneration += 1;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

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
      readline: createInterface({ input: child.stdout }),
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
      handleProviderServerLine(entry, line);
    });

    child.stderr.on('data', (chunk: string | Buffer) => {
      entry.stderr = appendBuffer(entry.stderr, chunk.toString());
    });

    child.stdin.on('error', (error: Error) => {
      if (entry.closed) return;
      const stdinError = createProviderServerError(entry.provider, `stdin error: ${error.message}`, {
        stderr: entry.stderr,
      });
      backendLog.error(stdinError.message, error);
      detachProviderServer(entry, stdinError);
      gracefulKill(child);
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
          gracefulKill(entry.child);
        }
      },
    };

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
        beginProviderServerShutdown(entry, 'closed');
        await entry.closePromise;
      },
    };
  }

  private async spawnDurableJobAsync(options: SpawnDurableJobOptions): Promise<CliExecResult> {
    const pool = options.pool ?? 'default';
    const usingReservedPermit =
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR: false must fall through
      options.permitGranted || (options.signal ? this.consumeSignalPermit(options.signal, options.provider) : false);
    let internalPermitJobId: string | null = null;

    if (!usingReservedPermit) {
      const activeLaunches = this.getActiveMap(pool);
      const queuedLaunches = this.getQueue(pool);
      const globalActive = activeLaunches.size;
      const globalLimit = getActiveLimit(pool);
      if (queuedLaunches.length > 0 || globalActive >= globalLimit) {
        return Promise.reject(
          new CliBusyError({
            error: 'busy',
            provider: options.provider,
            globalActive,
            globalLimit,
          }),
        );
      }
      internalPermitJobId = `spawndurable-${randomUUID()}`;
      activeLaunches.set(internalPermitJobId, options.provider);
    }

    let abortHandler: (() => void) | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let durablePid: number | null = null;

    try {
      if (options.signal?.aborted) {
        return { stdout: '', stderr: '', code: null, aborted: true };
      }

      const durable = await spawnDurableWrapper({
        provider: options.provider,
        command: options.command,
        args: options.args,
        prompt: options.prompt,
        cwd: options.cwd,
        jobDir: options.jobDir,
        pool,
        env: options.extraEnv,
      });
      durablePid = durable.pid;
      this.activeDurablePidsSet.add(durable.pid);

      let abortedBySignal = false;
      let runtimeRecord = durable.runtimeRecord;
      let tailOffset = runtimeRecord.tailWatermark ?? 0;
      let pidExitedAt: number | null = null;
      let lastOutputAt = Date.now();
      let lastTickAt = Date.now();

      const drainStdout = (): void => {
        const { lines, newOffset } = readAppendedLines(durable.stdoutPath, tailOffset);
        if (newOffset === tailOffset) {
          return;
        }

        tailOffset = newOffset;
        lastOutputAt = Date.now();
        runtimeRecord = { ...runtimeRecord, tailWatermark: newOffset };
        try {
          writeRuntimeRecord(options.jobDir, runtimeRecord);
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
          safeKillPid(durable.pid, 'SIGTERM');
          killTimer = setTimeout(() => {
            safeKillPid(durable.pid, 'SIGKILL');
          }, SIGTERM_GRACE_MS);
          killTimer.unref?.();
        };

        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      while (true) {
        drainStdout();

        const exitRecord = readExitRecord(options.jobDir);
        if (exitRecord) {
          drainStdout();
          return {
            stdout: readOutputFile(durable.stdoutPath),
            stderr: readOutputFile(durable.stderrPath),
            code: exitRecord.exitCode,
            aborted: abortedBySignal,
          };
        }

        if (!isPidAlive(durable.pid)) {
          drainStdout();
          const lateExitRecord = readExitRecord(options.jobDir);
          if (lateExitRecord) {
            return {
              stdout: readOutputFile(durable.stdoutPath),
              stderr: readOutputFile(durable.stderrPath),
              code: lateExitRecord.exitCode,
              aborted: abortedBySignal,
            };
          }
          pidExitedAt ??= Date.now();
          if (Date.now() - pidExitedAt >= DURABLE_EXIT_GRACE_MS) {
            throw new Error(`Durable process ${durable.pid} exited before exit.json was written`);
          }
        } else {
          pidExitedAt = null;
        }

        // Idle timeout — mirrors spawnCli's 10-minute inactivity kill
        const now = Date.now();
        const tickGap = now - lastTickAt;
        lastTickAt = now;
        if (tickGap > IDLE_CHECK_INTERVAL * 3) {
          // System likely woke from sleep — reset baseline
          lastOutputAt = now;
        } else if (now - lastOutputAt >= IDLE_TIMEOUT) {
          safeKillPid(durable.pid, 'SIGTERM');
          throw new Error(
            `Durable process ${durable.pid} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`,
          );
        }

        await new Promise<void>((resolve) => setTimeout(resolve, DURABLE_RUNTIME_POLL_INTERVAL_MS));
      }
    } finally {
      if (durablePid !== null) {
        this.activeDurablePidsSet.delete(durablePid);
      }
      if (killTimer) clearTimeout(killTimer);
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

function getActiveLimit(pool: LaunchPool): number {
  if (pool === 'discuss') {
    return DISCUSS_MAX_ACTIVE_SESSIONS;
  }
  if (pool === 'curate') {
    return CURATE_MAX_ACTIVE_SESSIONS;
  }
  return MAX_ACTIVE_SESSIONS;
}

function drainQueuedLaunchPool(queue: QueuedLaunchEntry[], message: string): void {
  const drained = queue.splice(0, queue.length);
  const error = new Error(message);
  for (const entry of drained) {
    entry.reject(error);
  }
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

function gracefulKill(child: ChildProcess): void {
  safeKill(child, 'SIGTERM');
  const killTimer = setTimeout(() => {
    safeKill(child, 'SIGKILL');
  }, SIGTERM_GRACE_MS);
  child.on('close', () => clearTimeout(killTimer));
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

function handleProviderServerLine(entry: ProviderServerEntry, line: string): void {
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
    gracefulKill(entry.child);
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
      gracefulKill(entry.child);
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
    gracefulKill(entry.child);
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
  gracefulKill(entry.child);
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
};

// ── Durable wrapper spawn ─────────────────────────────────────────────────────

export type DurableSpawnOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  jobDir: string;
  pool?: LaunchPool;
  env?: Record<string, string>;
};

export type DurableSpawnResult = {
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  runtimeRecord: DurableCliRuntimeRecord;
};

const DURABLE_POLL_INTERVAL_MS = 100;
const DURABLE_POLL_TIMEOUT_MS = 5_000;

/**
 * Inline Node.js script executed as a detached wrapper child.
 * Opens file-backed stdout/stderr, writes runtime.json after spawn,
 * and writes exit.json after CLI exit and output flush.
 *
 * Arguments: jobDir, command, argsJson, cwd, prompt
 * Env is read from jobDir/env.json (avoids passing large env in argv → E2BIG).
 */
const WRAPPER_SCRIPT = `
const { spawn } = require('child_process');
const { openSync, closeSync, readFileSync, writeFileSync, renameSync } = require('fs');
const { join } = require('path');

const jobDir = process.argv[1];
const command = process.argv[2];
const args = JSON.parse(process.argv[3]);
const env = JSON.parse(readFileSync(join(jobDir, 'env.json'), 'utf8'));
const cwd = process.argv[4] || undefined;
const prompt = process.argv[5] || '';

const stdoutPath = join(jobDir, 'stdout');
const stderrPath = join(jobDir, 'stderr');

const stdoutFd = openSync(stdoutPath, 'w');
const stderrFd = openSync(stderrPath, 'w');

const child = spawn(command, args, {
  stdio: ['pipe', stdoutFd, stderrFd],
  cwd,
  env,
  shell: process.platform === 'win32',
});

// Write runtime.json atomically after spawn succeeds
const runtimeRecord = {
  pid: child.pid,
  stdoutPath,
  stderrPath,
  startTime: new Date().toISOString(),
};
const tmpPath = join(jobDir, 'runtime.json.tmp');
const finalPath = join(jobDir, 'runtime.json');
writeFileSync(tmpPath, JSON.stringify(runtimeRecord, null, 2));
renameSync(tmpPath, finalPath);

// Write prompt to stdin, then close
if (prompt) child.stdin.write(prompt);
child.stdin.end();

// Write exit.json atomically after CLI exit and output flush
child.on('close', (code, signal) => {
  try { closeSync(stdoutFd); } catch {}
  try { closeSync(stderrFd); } catch {}

  const exitRecord = {
    exitCode: code,
    signal: signal || null,
    endTime: new Date().toISOString(),
  };
  const exitTmp = join(jobDir, 'exit.json.tmp');
  const exitFinal = join(jobDir, 'exit.json');
  writeFileSync(exitTmp, JSON.stringify(exitRecord, null, 2));
  renameSync(exitTmp, exitFinal);

  process.exit(0);
});

child.on('error', (err) => {
  try { closeSync(stdoutFd); } catch {}
  try { closeSync(stderrFd); } catch {}

  const exitRecord = {
    exitCode: null,
    signal: null,
    endTime: new Date().toISOString(),
  };
  const exitTmp = join(jobDir, 'exit.json.tmp');
  const exitFinal = join(jobDir, 'exit.json');
  writeFileSync(exitTmp, JSON.stringify(exitRecord, null, 2));
  renameSync(exitTmp, exitFinal);

  process.exit(1);
});
`.trim();

/**
 * Spawn a durable wrapper child that survives backend exit.
 *
 * The wrapper opens file-backed stdout/stderr, spawns the actual CLI,
 * writes runtime.json, and writes exit.json after CLI exit.
 * The parent polls for runtime.json to confirm spawn success.
 */
export async function spawnDurableWrapper(options: DurableSpawnOptions): Promise<DurableSpawnResult> {
  const { command, args, prompt, cwd, jobDir, env: extraEnv } = options;

  const mergedEnv = buildChildEnv(extraEnv);

  // Write env to file — avoids passing large env as argv (E2BIG).
  // The wrapper reads env.json from jobDir on startup.
  const envTmp = join(jobDir, 'env.json.tmp');
  const envFinal = join(jobDir, 'env.json');
  writeFileSync(envTmp, JSON.stringify(mergedEnv));
  renameSync(envTmp, envFinal);

  const wrapper = spawn(
    process.execPath,
    ['-e', WRAPPER_SCRIPT, jobDir, command, JSON.stringify(args), cwd ?? '', prompt ?? ''],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );

  // Fire-and-forget — wrapper survives backend exit.
  // Not added to activeChildren; the wrapper manages its own lifecycle.
  wrapper.unref();

  // Poll for runtime.json existence with ~100ms intervals, 5s timeout.
  const runtimePath = join(jobDir, 'runtime.json');
  const deadline = Date.now() + DURABLE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      statSync(runtimePath);
      // runtime.json exists — read and return the record
      const data = readFileSync(runtimePath, 'utf-8');
      const record = JSON.parse(data) as PersistedRuntimeRecord;
      // TODO(AC2-AC10): branch on runtime transport instead of assuming durable-cli wrapper output here.
      if (!isDurableCliRuntime(record)) {
        throw new Error(`Durable wrapper wrote unsupported runtime transport: ${record.transport}`);
      }
      return {
        pid: record.pid,
        stdoutPath: record.stdoutPath,
        stderrPath: record.stderrPath,
        runtimeRecord: record,
      };
    } catch {
      // Not yet written — wait and retry
    }

    await new Promise<void>((resolve) => setTimeout(resolve, DURABLE_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Durable wrapper failed to write runtime.json within ${DURABLE_POLL_TIMEOUT_MS}ms (jobDir: ${jobDir})`,
  );
}

const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;
const DURABLE_EXIT_GRACE_MS = 5_000;
const RUNTIME_FILE = 'runtime.json';
const EXIT_FILE = 'exit.json';

function safeKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already dead */
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOutputFile(path: string): string {
  try {
    const stats = statSync(path);
    const bytesToRead = Math.min(stats.size, MAX_BUFFER + 1);
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
      const output = buffer.subarray(0, bytesRead).toString('utf-8');
      if (stats.size > MAX_BUFFER) {
        return output.slice(0, MAX_BUFFER) + '\n[output truncated at 10MB]';
      }
      return output;
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readExitRecord(jobDir: string): PersistedExitRecord | null {
  try {
    const raw = readFileSync(join(jobDir, EXIT_FILE), 'utf-8');
    return JSON.parse(raw) as PersistedExitRecord;
  } catch {
    return null;
  }
}

function writeRuntimeRecord(jobDir: string, record: PersistedRuntimeRecord): void {
  const runtimePath = join(jobDir, RUNTIME_FILE);
  const tmpPath = `${runtimePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2));
  renameSync(tmpPath, runtimePath);
}
