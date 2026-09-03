import { MAX_BUFFER, SIGTERM_GRACE_MS } from './process-constants.js';
import { incarnationMayAuthorizeSignal, type ProcessIncarnation, type ProcessLiveness } from './node-process.js';
import type { ChildProcessLike, TimePort } from './port-types.js';
import type { Runtime } from '../runtime/ports.js';

type GracefulKillRuntime = Readonly<{
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
}>;

type GracefulKillByPidSignalRefusal = Readonly<{
  kind: 'signal-refused';
  pid: number;
  reason:
    | 'recorded-incarnation-unavailable'
    | 'platform-incarnation-cannot-authorize-signal'
    | 'signal-authorizing-incarnation-unavailable'
    | 'expected-incarnation-mismatch';
}>;

type GracefulKillByPidSignalFailure = Readonly<{
  kind: 'signal-failed';
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
  reason: 'kill-port-returned-false';
}>;

export type GracefulKillByPidOutcome =
  | GracefulKillByPidSignalRefusal
  | GracefulKillByPidSignalFailure
  | Readonly<{ kind: 'observed-absent'; pid: number }>
  | Readonly<{ kind: 'target-unobservable'; pid: number; stage: 'after-sigterm' | 'after-sigkill' }>
  | Readonly<{ kind: 'target-alive'; pid: number; stage: 'after-sigkill' }>;

export type GracefulKillByPidDisposition =
  | Readonly<{ kind: 'escalation-scheduled'; pid: number; settlement: Promise<GracefulKillByPidOutcome> }>
  | GracefulKillByPidSignalRefusal
  | GracefulKillByPidSignalFailure;

export function safeKill(child: ChildProcessLike, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

export function gracefulKill(
  child: ChildProcessLike,
  runtime: GracefulKillRuntime,
  observeLiveness: (pid: number) => ProcessLiveness,
): void {
  safeKill(child, 'SIGTERM');
  const killTimer = runtime.time.setTimeout(() => {
    if (child.pid === undefined) return;
    try {
      if (observeLiveness(child.pid) !== 'alive') return;
    } catch {
      return;
    }
    safeKill(child, 'SIGKILL');
  }, SIGTERM_GRACE_MS);
  killTimer.unref?.();
  child.on('close', () => runtime.time.clearTimeout(killTimer));
}

function observeRecordedTarget(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
  expectedIncarnation: ProcessIncarnation,
): 'alive' | 'absent' | 'unobservable' {
  try {
    const observedIncarnation = runtime.process.readProcessIncarnation(pid, platform);
    if (observedIncarnation !== null) {
      if (observedIncarnation !== expectedIncarnation) return 'absent';
      const liveness = runtime.process.observeLiveness(pid);
      return liveness === 'unknown' ? 'unobservable' : liveness;
    }
    return runtime.process.observeLiveness(pid) === 'absent' ? 'absent' : 'unobservable';
  } catch {
    return 'unobservable';
  }
}

function settleAfterSigkill(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
  expectedIncarnation: ProcessIncarnation,
): GracefulKillByPidOutcome {
  const observation = observeRecordedTarget(runtime, pid, platform, expectedIncarnation);
  if (observation === 'absent') return { kind: 'observed-absent', pid };
  if (observation === 'unobservable') return { kind: 'target-unobservable', pid, stage: 'after-sigkill' };
  return { kind: 'target-alive', pid, stage: 'after-sigkill' };
}

function settleGracefulKillByPid(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
  expectedIncarnation: ProcessIncarnation,
): Promise<GracefulKillByPidOutcome> {
  try {
    const immediateLiveness = runtime.process.observeLiveness(pid);
    if (immediateLiveness === 'absent') return Promise.resolve({ kind: 'observed-absent', pid });
    if (immediateLiveness === 'unknown') {
      return Promise.resolve({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
    }
  } catch {
    return Promise.resolve({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
  }

  return new Promise<GracefulKillByPidOutcome>((resolve, reject) => {
    const escalation = runtime.time.setTimeout(() => {
      try {
        const observation = observeRecordedTarget(runtime, pid, platform, expectedIncarnation);
        if (observation === 'absent') {
          resolve({ kind: 'observed-absent', pid });
          return;
        }
        if (observation === 'unobservable') {
          resolve({ kind: 'target-unobservable', pid, stage: 'after-sigterm' });
          return;
        }
        if (!runtime.process.kill(pid, 'SIGKILL')) {
          resolve({ kind: 'signal-failed', pid, signal: 'SIGKILL', reason: 'kill-port-returned-false' });
          return;
        }
        resolve(settleAfterSigkill(runtime, pid, platform, expectedIncarnation));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, SIGTERM_GRACE_MS);
    escalation.unref?.();
  });
}

export function gracefulKillByPid(
  runtime: Runtime,
  pid: number,
  expectedIncarnation: ProcessIncarnation | null,
): GracefulKillByPidDisposition {
  const platform = runtime.env.platform() as NodeJS.Platform;
  if (expectedIncarnation === null) {
    return { kind: 'signal-refused', pid, reason: 'recorded-incarnation-unavailable' };
  }
  if (!incarnationMayAuthorizeSignal(platform)) {
    return { kind: 'signal-refused', pid, reason: 'platform-incarnation-cannot-authorize-signal' };
  }
  let observedIncarnation: ProcessIncarnation | null;
  try {
    observedIncarnation = runtime.process.readProcessIncarnation(pid, platform);
  } catch {
    observedIncarnation = null;
  }
  if (observedIncarnation === null) {
    return { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
  }
  if (observedIncarnation !== expectedIncarnation) {
    return { kind: 'signal-refused', pid, reason: 'expected-incarnation-mismatch' };
  }
  if (!runtime.process.kill(pid, 'SIGTERM')) {
    return { kind: 'signal-failed', pid, signal: 'SIGTERM', reason: 'kill-port-returned-false' };
  }

  return {
    kind: 'escalation-scheduled',
    pid,
    settlement: settleGracefulKillByPid(runtime, pid, platform, observedIncarnation),
  };
}

export function requirePipedHandles(
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

export function appendBuffer(current: string, chunk: string): string {
  if (current.length >= MAX_BUFFER) return current;
  const combined = current + chunk;
  if (combined.length > MAX_BUFFER) {
    return `${combined.slice(0, MAX_BUFFER)}\n[output truncated at 10MB]`;
  }
  return combined;
}
