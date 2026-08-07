import { MAX_BUFFER, SIGTERM_GRACE_MS } from './process-constants.js';
import type { ChildProcessLike } from './port-types.js';
import type { Runtime } from '../runtime/ports.js';

export function safeKill(child: ChildProcessLike, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

export function gracefulKill(child: ChildProcessLike, runtime: Runtime): void {
  safeKill(child, 'SIGTERM');
  const killTimer = runtime.time.setTimeout(() => {
    safeKill(child, 'SIGKILL');
  }, SIGTERM_GRACE_MS);
  // Unref so a caller that fires gracefulKill on an already-closed child (whose
  // 'close' won't fire again to clear the timer) can't pin the event loop for
  // the SIGTERM grace window. Matches gracefulKillByPid's escalation timer.
  killTimer.unref?.();
  child.on('close', () => runtime.time.clearTimeout(killTimer));
}

/**
 * PID-based variant of {@link gracefulKill} for callers that detached the
 * child handle (e.g., durable transports that hand the spawned PID off to a
 * background watcher). Fires-and-forgets the SIGKILL escalation; the returned
 * timer is unref'd so it never holds the event loop alive on its own.
 */
export function gracefulKillByPid(runtime: Runtime, pid: number): void {
  runtime.process.kill(pid, 'SIGTERM');
  const escalation = runtime.time.setTimeout(() => runtime.process.kill(pid, 'SIGKILL'), SIGTERM_GRACE_MS);
  escalation.unref?.();
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
