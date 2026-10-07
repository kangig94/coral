import { afterEach, expect, it, vi } from 'vitest';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import {
  CLI_HANDOFF_GUARD_ENV,
  WAIT_INVOCATION_CONTEXT_ENV,
} from '#src/coordinator/handoff-routing/wait-invocation.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

it('preserves a failed snapshot exit when the watchdog fires during the final write', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  vi.spyOn(process.stdout, 'write').mockImplementation(((_text: unknown, callback?: () => void) => {
    if (callback) finish = callback;
    return true;
  }) as typeof process.stdout.write);
  const invocation = new WaitInvocation('snapshot', ['node', 'coral-cli', 'wait', 'jobs', 'a', '--now'], {
    now: () => Date.now(),
  });
  try {
    const write = invocation.writeSnapshotOutput('delivered snapshot', 'continuation', 42).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30000);
    finish();
    expect(await write).toBeNull();
    expect(invocation.completedExitCode).toBe(42);
  } finally {
    invocation.dispose(true);
    vi.useRealTimers();
  }
});

it('prints its own continuation once the parent it was delegated by disconnects', () => {
  vi.stubEnv(WAIT_INVOCATION_CONTEXT_ENV, JSON.stringify({ mode: 'bounded', remainingMs: 60_000, cleanupMs: 1_000 }));
  vi.stubEnv(CLI_HANDOFF_GUARD_ENV, '1');
  const send = process.send;
  process.send = vi.fn() as typeof process.send;
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    out += text;
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  const continuation = 'Still waiting on 1 job. Run coral-cli wait jobs a to continue waiting.\n';
  try {
    invocation.saveContinuation(continuation);
    invocation.stop();
    invocation.flushContinuation(true);
    expect(out).toBe('');
    process.emit('disconnect');
    invocation.flushContinuation(true);
    expect(out).toBe(continuation);
  } finally {
    invocation.dispose(true);
    process.send = send;
  }
});
