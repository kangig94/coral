import { SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { ChildProcessLike, TimerHandle } from '../infra/port-types.js';
import type { ExecResult, RuntimeSpawnOptions } from './ports.js';

export interface BuildExecPromiseOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxBuffer: number;
  encoding: 'utf-8';
  killProcessGroup?: boolean;
  spawn: (options: RuntimeSpawnOptions) => ChildProcessLike;
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle | null) => void;
}

type ExecKillReason = 'timeout' | 'maxBuffer';

function appendOutput(
  current: string,
  currentBytes: number,
  chunk: string | Buffer,
  encoding: 'utf-8',
  maxBuffer: number,
  wrapperKilled: ExecKillReason | null,
): { next: string; nextBytes: number; overflowed: boolean } {
  if (wrapperKilled !== null) {
    return { next: current, nextBytes: currentBytes, overflowed: false };
  }

  const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
  const chunkBytes = Buffer.byteLength(text, encoding);
  if (currentBytes + chunkBytes <= maxBuffer) {
    return { next: current + text, nextBytes: currentBytes + chunkBytes, overflowed: false };
  }

  let next = current;
  let nextBytes = currentBytes;
  let remainingBytes = maxBuffer - currentBytes;
  if (remainingBytes > 0) {
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, encoding);
      if (characterBytes > remainingBytes) {
        break;
      }
      next += character;
      nextBytes += characterBytes;
      remainingBytes -= characterBytes;
    }
  }

  return { next, nextBytes, overflowed: true };
}

export function buildExecPromise(options: BuildExecPromiseOptions): Promise<ExecResult> {
  const {
    args,
    clearTimeout,
    command,
    cwd,
    encoding,
    env,
    inheritEnv,
    kill,
    killProcessGroup = false,
    maxBuffer,
    setTimeout,
    spawn,
    timeoutMs,
  } = options;

  return new Promise<ExecResult>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resolved = false;
    let timeoutHandle: TimerHandle | null = null;
    let killTimer: TimerHandle | null = null;
    let wrapperKilled: ExecKillReason | null = null;

    const child = spawn({
      command,
      args: [...args],
      cwd,
      env,
      inheritEnv,
      ...(killProcessGroup ? { detached: true } : {}),
    });

    child.stdin?.end();

    const clearTimers = (): void => {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
      clearTimeout(killTimer);
      killTimer = null;
    };

    const finish = (result: ExecResult): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimers();
      resolveResult(result);
    };

    const signalChild = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      const groupSignaled = killProcessGroup ? kill(-child.pid, signal) : false;
      if (!groupSignaled) {
        kill(child.pid, signal);
      }
    };

    const scheduleKill = (reason: 'timeout' | 'maxBuffer'): void => {
      if (resolved || wrapperKilled !== null || child.pid === undefined) {
        return;
      }
      wrapperKilled = reason;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => {
        if (resolved || child.pid === undefined) {
          return;
        }
        signalChild('SIGKILL');
      }, SIGTERM_GRACE_MS);
      killTimer.unref?.();
    };

    if (child.stdout) {
      child.stdout.setEncoding(encoding);
      child.stdout.on('data', (chunk) => {
        const result = appendOutput(stdout, stdoutBytes, chunk, encoding, maxBuffer, wrapperKilled);
        stdout = result.next;
        stdoutBytes = result.nextBytes;
        if (result.overflowed) {
          scheduleKill('maxBuffer');
        }
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding(encoding);
      child.stderr.on('data', (chunk) => {
        const result = appendOutput(stderr, stderrBytes, chunk, encoding, maxBuffer, wrapperKilled);
        stderr = result.next;
        stderrBytes = result.nextBytes;
        if (result.overflowed) {
          scheduleKill('maxBuffer');
        }
      });
    }

    child.on('close', (status) => {
      let error: Error | undefined;
      if (wrapperKilled === 'timeout') {
        error = new Error(`timeout: ${command}`);
      } else if (wrapperKilled === 'maxBuffer') {
        error = new Error(`maxBuffer exceeded: ${command}`);
      }
      finish({
        stdout,
        stderr,
        status: error ? null : status,
        ...(error ? { error } : {}),
      });
    });

    child.on('error', (error) => {
      finish({
        stdout: '',
        stderr: '',
        status: null,
        error,
      });
    });

    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        scheduleKill('timeout');
      }, timeoutMs);
      timeoutHandle.unref?.();
    }
  });
}
