import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../../infra/process-constants.js';
import type { ChildProcessLike, Runtime } from '../../runtime/ports.js';

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
  child.on('close', () => runtime.time.clearTimeout(killTimer));
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
