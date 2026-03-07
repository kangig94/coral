import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const SIGTERM_GRACE_MS = 5_000; // grace period before escalating to SIGKILL

export const MAX_ACTIVE_CHILDREN = Math.min(Math.max(parsePositiveInt(process.env.CORAL_MAX_CHILDREN, 10), 1), 10);
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

type ActiveChild = {
  provider: string;
  child: ChildProcess;
};

type QueuedLaunchEntry = {
  jobId: string;
  provider: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export const activeChildren = new Set<ActiveChild>();

const activeLaunches = new Map<string, string>();
const queuedLaunches: QueuedLaunchEntry[] = [];
const signalLaunchPermits = new WeakMap<AbortSignal, string>();
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

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function hasLaunchCapacity(): boolean {
  return activeLaunches.size < MAX_ACTIVE_CHILDREN;
}

function queuedHandle(entry: QueuedLaunchEntry): QueuedHandle {
  return {
    type: 'queued',
    queuePosition: queuePosition(entry.jobId) ?? queuedLaunches.length,
    waitForPermit: () => entry.promise,
    cancel: () => {
      cancelQueued(entry.jobId);
    },
  };
}

function findQueuedLaunch(jobId: string): QueuedLaunchEntry | null {
  for (const entry of queuedLaunches) {
    if (entry.jobId === jobId) return entry;
  }
  return null;
}

function admitQueueHead(): void {
  const head = queuedLaunches[0];
  if (!head) return;
  if (!hasLaunchCapacity()) return;
  queuedLaunches.shift();
  activeLaunches.set(head.jobId, head.provider);
  head.resolve();
}

function drainQueuedLaunches(message: string): void {
  const drained = queuedLaunches.splice(0, queuedLaunches.length);
  const error = new Error(message);
  for (const entry of drained) {
    entry.reject(error);
  }
}

function consumeSignalPermit(signal: AbortSignal, provider: string): boolean {
  const jobId = signalLaunchPermits.get(signal);
  if (!jobId) return false;
  signalLaunchPermits.delete(signal);
  return activeLaunches.get(jobId) === provider;
}

export function requestLaunch(jobId: string, provider: string): AdmissionResult {
  if (activeLaunches.has(jobId)) return IMMEDIATE_PERMIT;

  const existingQueued = findQueuedLaunch(jobId);
  if (existingQueued) return queuedHandle(existingQueued);

  if (queuedLaunches.length === 0 && hasLaunchCapacity()) {
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
  return queuedHandle(entry);
}

export function releaseLaunch(jobId: string): void {
  if (!activeLaunches.delete(jobId)) return;
  admitQueueHead();
}

export function cancelQueued(jobId: string): boolean {
  const index = queuedLaunches.findIndex((entry) => entry.jobId === jobId);
  if (index === -1) return false;
  const [entry] = queuedLaunches.splice(index, 1);
  entry.reject(new Error(QUEUE_CANCELED_MESSAGE));
  admitQueueHead();
  return true;
}

export function queueDepth(): number {
  return queuedLaunches.length;
}

export function queuePosition(jobId: string): number | null {
  const index = queuedLaunches.findIndex((entry) => entry.jobId === jobId);
  return index === -1 ? null : index + 1;
}

export function getActiveJobIds(): string[] {
  return [...activeLaunches.keys()];
}

export function bindLaunchPermit(jobId: string, signal: AbortSignal): void {
  signalLaunchPermits.set(signal, jobId);
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

export type SpawnCliOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
  permitGranted?: boolean;
};

export function spawnCli(options: SpawnCliOptions): Promise<CliExecResult> {
  const usingReservedPermit = options.permitGranted || (options.signal ? consumeSignalPermit(options.signal, options.provider) : false);
  let internalPermitJobId: string | null = null;

  if (!usingReservedPermit) {
    const globalActive = activeLaunches.size;
    if (queuedLaunches.length > 0 || globalActive >= MAX_ACTIVE_CHILDREN) {
      return Promise.reject(new CliBusyError({
        error: 'busy',
        provider: options.provider,
        globalActive,
        globalLimit: MAX_ACTIVE_CHILDREN,
      }));
    }
    internalPermitJobId = `spawncli-${randomUUID()}`;
    activeLaunches.set(internalPermitJobId, options.provider);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortedBySignal = false;

    const child = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd || undefined,
      shell: process.platform === 'win32',
    });
    const entry: ActiveChild = { provider: options.provider, child };
    activeChildren.add(entry);

    let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);
    }

    function onIdle() {
      if (settled) return;
      settled = true;
      gracefulKill(child);
      activeChildren.delete(entry);
      if (internalPermitJobId) {
        releaseLaunch(internalPermitJobId);
        internalPermitJobId = null;
      }
      reject(new Error(`${options.command} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
    }

    function finish(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(idleTimer);
      activeChildren.delete(entry);
      if (internalPermitJobId) {
        releaseLaunch(internalPermitJobId);
        internalPermitJobId = null;
      }
      return true;
    }

    if (options.signal) {
      const onAbort = () => {
        if (settled) return;
        abortedBySignal = true;
        clearTimeout(idleTimer);
        gracefulKill(child);
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
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

export function killAllChildren(): void {
  drainQueuedLaunches(QUEUE_DRAINED_MESSAGE);
  for (const { child } of activeChildren) {
    gracefulKill(child);
  }
  activeChildren.clear();
}
