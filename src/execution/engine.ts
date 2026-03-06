import { spawn, type ChildProcess } from 'node:child_process';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const SIGTERM_GRACE_MS = 5_000; // grace period before escalating to SIGKILL

export const MAX_ACTIVE_CHILDREN = parsePositiveInt(process.env.CORAL_MAX_CHILDREN, 10);
export const MAX_ACTIVE_CHILDREN_PER_PROVIDER = parsePositiveInt(process.env.CORAL_MAX_CHILDREN_PER_PROVIDER, 6);

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

export const activeChildren = new Set<ActiveChild>();

export type CliBusyErrorDetail = {
  error: 'busy';
  provider: string;
  globalActive: number;
  providerActive: number;
  globalLimit: number;
  providerLimit: number;
};

export class CliBusyError extends Error {
  readonly detail: CliBusyErrorDetail;

  constructor(detail: CliBusyErrorDetail) {
    const message = `Runner is busy (${detail.globalActive}/${detail.globalLimit} total, ${detail.providerActive}/${detail.providerLimit} for ${detail.provider})`;
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

function countActiveByProvider(provider: string): number {
  let count = 0;
  for (const entry of activeChildren) {
    if (entry.provider === provider) count += 1;
  }
  return count;
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
};

export function spawnCli(options: SpawnCliOptions): Promise<CliExecResult> {
  const globalActive = activeChildren.size;
  const providerActive = countActiveByProvider(options.provider);
  if (globalActive >= MAX_ACTIVE_CHILDREN || providerActive >= MAX_ACTIVE_CHILDREN_PER_PROVIDER) {
    return Promise.reject(new CliBusyError({
      error: 'busy',
      provider: options.provider,
      globalActive,
      providerActive,
      globalLimit: MAX_ACTIVE_CHILDREN,
      providerLimit: MAX_ACTIVE_CHILDREN_PER_PROVIDER,
    }));
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
      reject(new Error(`${options.command} killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
    }

    function finish(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(idleTimer);
      activeChildren.delete(entry);
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
  for (const { child } of activeChildren) {
    gracefulKill(child);
  }
  activeChildren.clear();
}
