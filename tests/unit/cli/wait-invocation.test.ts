import { afterEach, expect, it, vi } from 'vitest';
import {
  CLI_HANDOFF_GUARD_ENV,
  WAIT_INVOCATION_CONTEXT_ENV,
} from '#src/coordinator/handoff-routing/wait-invocation.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it('removes delegated IPC listeners after an abort while retaining the bounded SIGINT guard', () => {
  const baseline = process.listenerCount('message');
  const sigintBaseline = process.listenerCount('SIGINT');
  const send = process.send;
  const inherited = process.env.CORAL_WAIT_INVOCATION_CONTEXT;
  const delegated = process.env.CORAL_CLI_HANDOFF_DELEGATED;
  process.send = (() => true) as typeof process.send;
  process.env.CORAL_WAIT_INVOCATION_CONTEXT = JSON.stringify({ mode: 'bounded', remainingMs: 1000, cleanupMs: 100 });
  process.env.CORAL_CLI_HANDOFF_DELEGATED = '1';
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  try {
    expect(process.listenerCount('message')).toBe(baseline + 1);
    invocation.stop();
    invocation.dispose();
    expect(process.listenerCount('message')).toBe(baseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline + 1);
  } finally {
    invocation.dispose(true);
    process.send = send;
    if (inherited === undefined) delete process.env.CORAL_WAIT_INVOCATION_CONTEXT;
    else process.env.CORAL_WAIT_INVOCATION_CONTEXT = inherited;
    if (delegated === undefined) delete process.env.CORAL_CLI_HANDOFF_DELEGATED;
    else process.env.CORAL_CLI_HANDOFF_DELEGATED = delegated;
  }
});

it('preserves completed delivery when SIGINT arrives during the final output flush', () => {
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  try {
    invocation.saveContinuation('Wait complete; no jobs remain.\n', true);
    process.emit('SIGINT');
    expect(() => invocation.check()).not.toThrow();
    expect(invocation.signal.aborted).toBe(false);
  } finally {
    invocation.dispose(true);
  }
});

it('prints one continuation when cleanup races a pending stdout callback', () => {
  const callbacks: Array<() => void> = [];
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    output += text;
    if (callback) callbacks.push(callback);
    return true;
  }) as never);
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  try {
    invocation.saveContinuation('Run coral-cli wait jobs a --cursor C1\n');
    invocation.flushContinuation();
    invocation.stop();
    invocation.flushContinuation(true);
    for (const callback of callbacks) callback();
    expect(output.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  } finally {
    invocation.dispose(true);
  }
});

it('waits for delegated IPC delivery before flushing a parent continuation', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    output += text;
    callback?.();
    return true;
  }) as never);
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  let end!: () => void;
  invocation.monitorEnding = new Promise<void>((resolve) => {
    end = resolve;
  });
  try {
    invocation.saveContinuation('parent continuation\n');
    invocation.stop();
    invocation.flushContinuation();
    expect(output).toBe('');
    output += 'child continuation\n';
    invocation.saveContinuation('child continuation\n', true);
    end();
    await Promise.resolve();
    await Promise.resolve();
    expect(output).toBe('child continuation\n');
  } finally {
    invocation.dispose(true);
  }
});

it.each(['bounded', 'snapshot'] as const)('a released parent gets a bounded, admitted %s wait', (mode) => {
  const send = process.send;
  const inherited = process.env[WAIT_INVOCATION_CONTEXT_ENV];
  const delegated = process.env[CLI_HANDOFF_GUARD_ENV];
  process.send = undefined;
  delete process.env[WAIT_INVOCATION_CONTEXT_ENV];
  process.env[CLI_HANDOFF_GUARD_ENV] = '1';
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    output += text;
    callback?.();
    return true;
  }) as never);
  const invocation = new WaitInvocation(mode, ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  try {
    expect(invocation.remainingMs()).toBeGreaterThan(mode === 'snapshot' ? 29_000 : 589_000);
    expect(invocation.remainingMs()).toBeLessThanOrEqual(mode === 'snapshot' ? 30_000 : 590_000);
    expect(() => invocation.check()).not.toThrow();
    expect(output).toBe('');
  } finally {
    invocation.dispose(true);
    process.send = send;
    if (inherited === undefined) delete process.env[WAIT_INVOCATION_CONTEXT_ENV];
    else process.env[WAIT_INVOCATION_CONTEXT_ENV] = inherited;
    if (delegated === undefined) delete process.env[CLI_HANDOFF_GUARD_ENV];
    else process.env[CLI_HANDOFF_GUARD_ENV] = delegated;
  }
});

it('keeps confirmed progress during cancellation cleanup while ignoring late admission', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    output += text;
    callback?.();
    return true;
  }) as never);
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  let end!: () => void;
  invocation.monitorEnding = new Promise<void>((resolve) => {
    end = resolve;
  });
  try {
    invocation.saveContinuation('original continuation\n');
    invocation.stop();
    invocation.saveContinuation('late admission\n');
    invocation.saveContinuation('confirmed progress continuation\n', false, true);
    invocation.flushContinuation();
    expect(output).toBe('');
    end();
    await Promise.resolve();
    await Promise.resolve();
    expect(output).toBe('confirmed progress continuation\n');
  } finally {
    invocation.dispose(true);
  }
});

it.each(['bounded', 'snapshot'] as const)('malformed inherited %s context keeps a local admitted budget', (mode) => {
  const send = process.send;
  const context = process.env[WAIT_INVOCATION_CONTEXT_ENV];
  const guard = process.env[CLI_HANDOFF_GUARD_ENV];
  process.send = (() => true) as typeof process.send;
  process.env[WAIT_INVOCATION_CONTEXT_ENV] = '{malformed';
  process.env[CLI_HANDOFF_GUARD_ENV] = '1';
  const invocation = new WaitInvocation(mode, ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  try {
    expect(invocation.remainingMs()).toBeGreaterThan(mode === 'snapshot' ? 29_000 : 589_000);
    expect(() => invocation.check()).not.toThrow();
  } finally {
    invocation.dispose(true);
    process.send = send;
    if (context === undefined) delete process.env[WAIT_INVOCATION_CONTEXT_ENV];
    else process.env[WAIT_INVOCATION_CONTEXT_ENV] = context;
    if (guard === undefined) delete process.env[CLI_HANDOFF_GUARD_ENV];
    else process.env[CLI_HANDOFF_GUARD_ENV] = guard;
  }
});

it('keeps repeated SIGINT cleanup alive until the owned monitor has ended', async () => {
  const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  let end!: () => void;
  invocation.monitorEnding = new Promise<void>((resolve) => {
    end = resolve;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  try {
    process.emit('SIGINT');
    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    end();
    await invocation.monitorEnding;
  } finally {
    invocation.dispose(true);
  }
});
