import {
  EXEC_MAXBUFFER_CODE,
  EXEC_TIMEOUT_CODE,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../infra/process-constants.js';
import type { ChildProcessLike, ExecResult, TimerHandle } from '../infra/port-types.js';
import { signalOwnedProcessGroup } from '../infra/process-supervision.js';
import type { RuntimeSpawnOptions } from './ports.js';

export interface BuildExecPromiseOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  shell?: boolean;
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
  // Group containment requires an uncollected leader; after collection, its process-group id must
  // not be treated as attributable or signalled. An exec settlement never claims descendant absence,
  // only the command's answer or its absence. A caller requiring an owned tree must retain cleanup
  // authority (see retainSpawnedProcessGroupCleanup in src/infra/process-supervision.ts) or use the
  // durable wrapper.
  const {
    args,
    clearTimeout,
    command,
    cwd,
    encoding,
    env,
    inheritEnv,
    shell,
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
    let escalationTimer: TimerHandle | null = null;
    let settlementDeadlineTimer: TimerHandle | null = null;
    let wrapperKilled: ExecKillReason | null = null;

    const child = spawn({
      command,
      args: [...args],
      cwd,
      env,
      inheritEnv,
      ...(shell === undefined ? {} : { shell }),
      ...(killProcessGroup ? { detached: true } : {}),
    });
    child.stdin?.end();

    const clearTimers = (): void => {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
      clearTimeout(escalationTimer);
      escalationTimer = null;
      clearTimeout(settlementDeadlineTimer);
      settlementDeadlineTimer = null;
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
      if (killProcessGroup) {
        signalOwnedProcessGroup(child, kill, signal);
        return;
      }
      child.kill(signal);
    };

    const killedResult = (heldDetail?: string): ExecResult => {
      const prefix = wrapperKilled === 'maxBuffer' ? 'maxBuffer exceeded' : 'timeout';
      const code = wrapperKilled === 'maxBuffer' ? EXEC_MAXBUFFER_CODE : EXEC_TIMEOUT_CODE;
      const detail = heldDetail === undefined ? '' : `; ${heldDetail}`;
      return {
        stdout,
        stderr,
        status: null,
        error: Object.assign(new Error(`${prefix}: ${command}${detail}`), { code }),
      };
    };

    const scheduleKill = (reason: 'timeout' | 'maxBuffer'): void => {
      if (resolved || wrapperKilled !== null) {
        return;
      }
      wrapperKilled = reason;
      signalChild('SIGTERM');
      escalationTimer = setTimeout(() => {
        if (resolved) {
          return;
        }
        signalChild('SIGKILL');
      }, SIGTERM_GRACE_MS);
      escalationTimer.unref?.();
      settlementDeadlineTimer = setTimeout(() => {
        const childCollected = child.exitCode !== null || child.signalCode !== null;
        if (child.pid === undefined) {
          const signalAttempts = killProcessGroup
            ? 'SIGTERM and SIGKILL delivery were not attempted because no pid or pgid could be attributed'
            : 'SIGTERM and SIGKILL were attempted through the child handle without an identified pid';
          const unobserved = childCollected
            ? 'descendant absence remains unobserved'
            : 'child collection and descendant absence remain unobserved';
          finish(
            killedResult(
              `the command has no identified signal target; ${signalAttempts}; ${unobserved}; exec will not attempt further signals`,
            ),
          );
          return;
        }
        const processId = String(child.pid);
        const leaderIdentity = killProcessGroup ? `leader pid ${processId}` : `child pid ${processId}`;
        const signalSubject = killProcessGroup ? `pgid ${processId}` : `pid ${processId}`;
        const detail = childCollected
          ? `${leaderIdentity} was collected; a process holding this exec's inherited stdio remains running and can no longer be attributed to ${signalSubject}; ${signalSubject} will not be signalled`
          : `collection of ${leaderIdentity} remains unobserved within the escalation grace after SIGTERM and SIGKILL were attempted for ${signalSubject}; exec will not attempt further signals`;
        finish(killedResult(detail));
      }, SIGTERM_GRACE_MS + SIGKILL_GRACE_MS);
      settlementDeadlineTimer.unref?.();
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
      finish(wrapperKilled === null ? { stdout, stderr, status } : killedResult());
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
