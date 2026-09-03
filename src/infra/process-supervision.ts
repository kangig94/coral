import { MAX_BUFFER, SIGTERM_GRACE_MS } from './process-constants.js';
import { incarnationMayAuthorizeSignal, type ProcessIncarnation, type ProcessLiveness } from './node-process.js';
import type { ChildProcessLike, TimePort } from './port-types.js';
import type { Runtime } from '../runtime/ports.js';

type GracefulKillRuntime = Readonly<{
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
}>;

export type GracefulKillByPidDisposition =
  | Readonly<{ kind: 'escalation-scheduled'; pid: number }>
  | Readonly<{
      kind: 'signal-refused';
      pid: number;
      reason:
        | 'recorded-incarnation-unavailable'
        | 'platform-incarnation-cannot-authorize-signal'
        | 'signal-authorizing-incarnation-unavailable'
        | 'expected-incarnation-mismatch';
    }>;

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

function readSignalAuthorizingIncarnation(
  runtime: Runtime,
  pid: number,
  platform: NodeJS.Platform,
): ProcessIncarnation | null {
  try {
    return runtime.process.readProcessIncarnation(pid, platform);
  } catch {
    return null;
  }
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
  const observedIncarnation = readSignalAuthorizingIncarnation(runtime, pid, platform);
  if (observedIncarnation === null) {
    return { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
  }
  if (observedIncarnation !== expectedIncarnation) {
    return { kind: 'signal-refused', pid, reason: 'expected-incarnation-mismatch' };
  }
  runtime.process.kill(pid, 'SIGTERM');

  const escalation = runtime.time.setTimeout(() => {
    if (readSignalAuthorizingIncarnation(runtime, pid, platform) !== observedIncarnation) return;
    try {
      if (runtime.process.observeLiveness(pid) !== 'alive') return;
    } catch {
      return;
    }
    runtime.process.kill(pid, 'SIGKILL');
  }, SIGTERM_GRACE_MS);
  escalation.unref?.();
  return { kind: 'escalation-scheduled', pid };
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
