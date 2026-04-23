import { SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type {
  ChildProcessLike,
  ExecResult,
  RuntimeSpawnOptions,
  RuntimeTimerHandle,
} from './ports.js';

export interface BuildExecPromiseOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxBuffer: number;
  encoding: 'utf-8';
  spawn: (options: RuntimeSpawnOptions) => ChildProcessLike;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  setTimeout: (fn: () => void, ms: number) => RuntimeTimerHandle;
  clearTimeout: (handle: RuntimeTimerHandle | null) => void;
}

function appendOutput(
  current: string,
  chunk: string | Buffer,
  encoding: 'utf-8',
  maxBuffer: number,
  wrapperKilled: 'timeout' | 'maxBuffer' | null,
): { next: string; overflowed: boolean } {
  if (wrapperKilled !== null) {
    return { next: current, overflowed: false };
  }

  const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
  const currentBytes = Buffer.byteLength(current, encoding);
  const chunkBytes = Buffer.byteLength(text, encoding);
  if (currentBytes + chunkBytes <= maxBuffer) {
    return { next: current + text, overflowed: false };
  }

  let next = current;
  let remainingBytes = maxBuffer - currentBytes;
  if (remainingBytes > 0) {
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, encoding);
      if (characterBytes > remainingBytes) {
        break;
      }
      next += character;
      remainingBytes -= characterBytes;
    }
  }

  return { next, overflowed: true };
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
    maxBuffer,
    setTimeout,
    spawn,
    timeoutMs,
  } = options;

  return new Promise<ExecResult>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timeoutHandle: RuntimeTimerHandle | null = null;
    let killTimer: RuntimeTimerHandle | null = null;
    let wrapperKilled: 'timeout' | 'maxBuffer' | null = null;

    const child = spawn({
      command,
      args: [...args],
      cwd,
      env,
      inheritEnv,
      mode: 'piped',
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

    const scheduleKill = (reason: 'timeout' | 'maxBuffer'): void => {
      if (resolved || wrapperKilled !== null || child.pid === undefined) {
        return;
      }
      wrapperKilled = reason;
      kill(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (resolved || child.pid === undefined) {
          return;
        }
        kill(child.pid, 'SIGKILL');
      }, SIGTERM_GRACE_MS);
      killTimer.unref?.();
    };

    if (child.stdout) {
      child.stdout.setEncoding(encoding);
      child.stdout.on('data', (chunk) => {
        const result = appendOutput(stdout, chunk, encoding, maxBuffer, wrapperKilled);
        stdout = result.next;
        if (result.overflowed) {
          scheduleKill('maxBuffer');
        }
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding(encoding);
      child.stderr.on('data', (chunk) => {
        const result = appendOutput(stderr, chunk, encoding, maxBuffer, wrapperKilled);
        stderr = result.next;
        if (result.overflowed) {
          scheduleKill('maxBuffer');
        }
      });
    }

    child.on('close', (status) => {
      const error =
        wrapperKilled === 'timeout'
          ? new Error(`timeout: ${command}`)
          : wrapperKilled === 'maxBuffer'
            ? new Error(`maxBuffer exceeded: ${command}`)
            : undefined;
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
