import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity
const IDLE_CHECK_INTERVAL = 30_000; // poll interval for idle detection
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const SIGTERM_GRACE_MS = 5_000; // grace period before escalating to SIGKILL

export const MAX_ACTIVE_SESSIONS = Math.min(Math.max(parsePositiveInt(process.env.CORAL_MAX_SESSIONS, 10), 1), 10);
export type LaunchPool = 'default' | 'discuss' | 'curate';
export const DISCUSS_MAX_ACTIVE_SESSIONS = Math.min(Math.max(parsePositiveInt(process.env.CORAL_DISCUSS_MAX_SESSIONS, 5), 1), 10);
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

const activeLaunchesDefault = new Map<string, string>();
const activeLaunchesDiscuss = new Map<string, string>();
const activeLaunchesCurate = new Map<string, string>();
const queuedLaunchesDefault: QueuedLaunchEntry[] = [];
const queuedLaunchesDiscuss: QueuedLaunchEntry[] = [];
const queuedLaunchesCurate: QueuedLaunchEntry[] = [];
const signalLaunchPermits = new WeakMap<AbortSignal, { jobId: string; pool: LaunchPool }>();
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

function getActiveMap(pool: LaunchPool): Map<string, string> {
  if (pool === 'discuss') {
    return activeLaunchesDiscuss;
  }
  if (pool === 'curate') {
    return activeLaunchesCurate;
  }
  return activeLaunchesDefault;
}

function getQueue(pool: LaunchPool): QueuedLaunchEntry[] {
  if (pool === 'discuss') {
    return queuedLaunchesDiscuss;
  }
  if (pool === 'curate') {
    return queuedLaunchesCurate;
  }
  return queuedLaunchesDefault;
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

function hasLaunchCapacity(pool: LaunchPool): boolean {
  return getActiveMap(pool).size < getActiveLimit(pool);
}

function queuedHandle(entry: QueuedLaunchEntry, pool: LaunchPool): QueuedHandle {
  const queue = getQueue(pool);
  return {
    type: 'queued',
    queuePosition: queuePosition(entry.jobId, pool) ?? queue.length,
    waitForPermit: () => entry.promise,
    cancel: () => {
      cancelQueued(entry.jobId, pool);
    },
  };
}

function findQueuedLaunch(jobId: string, pool: LaunchPool): QueuedLaunchEntry | null {
  for (const entry of getQueue(pool)) {
    if (entry.jobId === jobId) return entry;
  }
  return null;
}

function admitQueueHead(pool: LaunchPool): void {
  const queue = getQueue(pool);
  const head = queue[0];
  if (!head) return;
  if (!hasLaunchCapacity(pool)) return;
  queue.shift();
  getActiveMap(pool).set(head.jobId, head.provider);
  head.resolve();
}

function drainQueuedLaunchPool(queue: QueuedLaunchEntry[], message: string): void {
  const drained = queue.splice(0, queue.length);
  const error = new Error(message);
  for (const entry of drained) {
    entry.reject(error);
  }
}

function drainQueuedLaunches(message: string): void {
  drainQueuedLaunchPool(queuedLaunchesDefault, message);
  drainQueuedLaunchPool(queuedLaunchesDiscuss, message);
  drainQueuedLaunchPool(queuedLaunchesCurate, message);
}

function consumeSignalPermit(signal: AbortSignal, provider: string): boolean {
  const permit = signalLaunchPermits.get(signal);
  if (!permit) return false;
  signalLaunchPermits.delete(signal);
  return getActiveMap(permit.pool).get(permit.jobId) === provider;
}

export function requestLaunch(jobId: string, provider: string, pool: LaunchPool = 'default'): AdmissionResult {
  const activeLaunches = getActiveMap(pool);
  const queuedLaunches = getQueue(pool);
  if (activeLaunches.has(jobId)) return IMMEDIATE_PERMIT;

  const existingQueued = findQueuedLaunch(jobId, pool);
  if (existingQueued) return queuedHandle(existingQueued, pool);

  if (queuedLaunches.length === 0 && hasLaunchCapacity(pool)) {
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
  return queuedHandle(entry, pool);
}

export function releaseLaunch(jobId: string, pool: LaunchPool = 'default'): void {
  const activeLaunches = getActiveMap(pool);
  if (!activeLaunches.delete(jobId)) return;
  admitQueueHead(pool);
}

export function cancelQueued(jobId: string, pool: LaunchPool = 'default'): boolean {
  const queuedLaunches = getQueue(pool);
  const index = queuedLaunches.findIndex((entry) => entry.jobId === jobId);
  if (index === -1) return false;
  const [entry] = queuedLaunches.splice(index, 1);
  entry.reject(new Error(QUEUE_CANCELED_MESSAGE));
  admitQueueHead(pool);
  return true;
}

export function queueDepth(pool: LaunchPool = 'default'): number {
  return getQueue(pool).length;
}

export function queuePosition(jobId: string, pool: LaunchPool = 'default'): number | null {
  const index = getQueue(pool).findIndex((entry) => entry.jobId === jobId);
  return index === -1 ? null : index + 1;
}

export function getActiveJobIds(pool: LaunchPool = 'default'): string[] {
  return [...getActiveMap(pool).keys()];
}

export function bindLaunchPermit(jobId: string, signal: AbortSignal, pool: LaunchPool = 'default'): void {
  signalLaunchPermits.set(signal, { jobId, pool });
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
  pool?: LaunchPool;
};

export function spawnCli(options: SpawnCliOptions): Promise<CliExecResult> {
  const pool = options.pool ?? 'default';
  const usingReservedPermit = options.permitGranted || (options.signal ? consumeSignalPermit(options.signal, options.provider) : false);
  let internalPermitJobId: string | null = null;

  if (!usingReservedPermit) {
    const activeLaunches = getActiveMap(pool);
    const queuedLaunches = getQueue(pool);
    const globalActive = activeLaunches.size;
    const globalLimit = getActiveLimit(pool);
    if (queuedLaunches.length > 0 || globalActive >= globalLimit) {
      return Promise.reject(new CliBusyError({
        error: 'busy',
        provider: options.provider,
        globalActive,
        globalLimit,
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
        activeChildren.delete(entry);
        if (internalPermitJobId) {
          releaseLaunch(internalPermitJobId, pool);
          internalPermitJobId = null;
        }
        reject(new Error(`${options.command} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
      }
    }, IDLE_CHECK_INTERVAL);

    function resetIdle() {
      lastOutputAt = Date.now();
    }

    function finish(): boolean {
      if (settled) return false;
      settled = true;
      clearInterval(idleChecker);
      activeChildren.delete(entry);
      if (internalPermitJobId) {
        releaseLaunch(internalPermitJobId, pool);
        internalPermitJobId = null;
      }
      return true;
    }

    if (options.signal) {
      const onAbort = () => {
        if (settled) return;
        abortedBySignal = true;
        clearInterval(idleChecker);
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
