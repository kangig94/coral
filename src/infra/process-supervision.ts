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
      kind: 'escalation-refused';
      pid: number;
      reason: 'signal-authorizing-incarnation-unavailable' | 'expected-incarnation-mismatch';
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

function readSignalAuthorizingIncarnation(runtime: Runtime, pid: number): ProcessIncarnation | null {
  const platform = runtime.env.platform() as NodeJS.Platform;
  if (!incarnationMayAuthorizeSignal(platform)) return null;
  try {
    return runtime.process.readProcessIncarnation(pid, platform);
  } catch {
    return null;
  }
}

/**
 * `expectedIncarnation` is the identity a caller recorded next to `pid` when it captured it (e.g.
 * `durable_cli_process.v1`). Supplying it gates the first SIGTERM on a fresh match, not only the escalation
 * below. Gating is skipped, not refused, wherever `incarnationMayAuthorizeSignal` is false: there the
 * platform's own incarnation already cannot authorize anything (the same limit `docs/todo/darwin-signal-
 * authority.md` documents for containment), so this call keeps sending its first signal unconditionally
 * exactly as a caller that passes no `expectedIncarnation` still does everywhere.
 */
export function gracefulKillByPid(
  runtime: Runtime,
  pid: number,
  expectedIncarnation?: ProcessIncarnation,
): GracefulKillByPidDisposition {
  const platform = runtime.env.platform() as NodeJS.Platform;
  const observedIncarnation = readSignalAuthorizingIncarnation(runtime, pid);
  if (expectedIncarnation !== undefined && incarnationMayAuthorizeSignal(platform)) {
    if (observedIncarnation === null) {
      return { kind: 'escalation-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
    }
    if (observedIncarnation !== expectedIncarnation) {
      return { kind: 'escalation-refused', pid, reason: 'expected-incarnation-mismatch' };
    }
  }
  runtime.process.kill(pid, 'SIGTERM');
  if (observedIncarnation === null) {
    return { kind: 'escalation-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
  }

  const escalation = runtime.time.setTimeout(() => {
    if (readSignalAuthorizingIncarnation(runtime, pid) !== observedIncarnation) return;
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
