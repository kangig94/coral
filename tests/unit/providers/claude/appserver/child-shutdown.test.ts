import { describe, expect, it, vi } from 'vitest';

import {
  heldChildShutdown,
  joinChildShutdownAttempt,
  observedChildShutdown,
  type JoinableChildShutdown,
} from '#src/providers/claude/appserver/child-shutdown.js';
import type {
  ClaudeChildShutdownSubject,
  ControllerShutdownDisposition,
  ControllerShutdownObservedAbsent,
} from '#src/providers/claude/appserver/session-contract.js';

const SUBJECT: ClaudeChildShutdownSubject = { kind: 'claude-child', controller: 'tui', generation: 1 };

describe('joinChildShutdownAttempt', () => {
  it('single-flights concurrent signal and wait attempts', async () => {
    const owner: JoinableChildShutdown = { shutdownAttempt: null };
    let settleAttempt!: (disposition: ControllerShutdownDisposition) => void;
    const pending = new Promise<ControllerShutdownDisposition>((resolve) => {
      settleAttempt = resolve;
    });
    const task = vi.fn(() => pending);

    const first = joinChildShutdownAttempt(owner, task);
    const concurrent = joinChildShutdownAttempt(owner, task);

    expect(concurrent).toBe(first);
    expect(task).toHaveBeenCalledOnce();
    settleAttempt(observedChildShutdown([SUBJECT]));
    await expect(first).resolves.toEqual(observedChildShutdown([SUBJECT]));
  });

  it('starts a fresh attempt when retrying a completed attempt that returned a hold', async () => {
    const owner: JoinableChildShutdown = { shutdownAttempt: null };
    let settleAttempt!: (disposition: ControllerShutdownDisposition) => void;
    const pending = new Promise<ControllerShutdownDisposition>((resolve) => {
      settleAttempt = resolve;
    });
    const unsettledClose = new Promise<ControllerShutdownObservedAbsent>(() => undefined);
    const observed = observedChildShutdown([SUBJECT]);
    const task = vi.fn<() => Promise<ControllerShutdownDisposition>>();
    task.mockImplementationOnce(() => pending).mockResolvedValueOnce(observed);
    const hold = heldChildShutdown({
      kind: 'held-unobservable',
      subjects: [SUBJECT],
      settled: unsettledClose,
      retry: () => joinChildShutdownAttempt(owner, task),
    });

    const first = joinChildShutdownAttempt(owner, task);
    settleAttempt(hold);
    await expect(first).resolves.toBe(hold);

    await expect(hold.retry()).resolves.toBe(observed);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
