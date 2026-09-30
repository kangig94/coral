import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ReconcilerModule from '#src/coordinator/succession/reconciler/index.js';
import type * as MockKbModule from '#tools/testing/kb-daemon-supervisor.js';
import type { KbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor/index.js';

const captured = vi.hoisted(() => ({
  kb: null as KbDaemonSupervisor | null,
  notify: vi.fn(),
}));

vi.mock('#tools/testing/kb-daemon-supervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MockKbModule>();
  return {
    ...actual,
    createMockKbDaemonSupervisor: () => captured.kb ?? actual.createMockKbDaemonSupervisor(),
  };
});

vi.mock('#src/coordinator/succession/reconciler/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReconcilerModule>();
  return {
    ...actual,
    createSuccessionReconciler: (...args: Parameters<typeof actual.createSuccessionReconciler>) => {
      const reconciler = actual.createSuccessionReconciler(...args);
      return {
        ...reconciler,
        notifyObligationChange: () => {
          captured.notify();
          reconciler.notifyObligationChange();
        },
      };
    },
  };
});

import {
  createHandoffCoresHarness,
  type HandoffCoresHarness,
} from '#tests/integration/coordinator/handoff-cores-harness.js';

let harness: HandoffCoresHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
  captured.kb = null;
  captured.notify.mockClear();
});

describe('startup KB succession obligations', () => {
  it.each(['completed', 'failed'] as const)('wakes succession after startup warmup %s', async (outcome) => {
    const mockKb = await vi.importActual<typeof MockKbModule>('#tools/testing/kb-daemon-supervisor.js');
    let pendingRequests = 1;
    let settleWarmup!: () => void;
    const warmupSettled = new Promise<void>((resolve) => {
      settleWarmup = resolve;
    });
    const read = () => mockKb.createOnlineKbDaemonHealth({ pendingRequests });
    const warmup = vi.fn(async () => {
      await warmupSettled;
      pendingRequests = 0;
      if (outcome === 'failed') throw new Error('warmup request failed');
      return read();
    });
    captured.kb = mockKb.createMockKbDaemonSupervisor({ read, warmup });
    harness = createHandoffCoresHarness();
    await harness.bootCore({ instanceId: 'startup-kb-wake' });
    await vi.waitFor(() => expect(warmup).toHaveBeenCalledOnce());
    expect(captured.notify).toHaveBeenCalled();
    captured.notify.mockClear();

    expect(captured.kb.read()).toMatchObject({ phase: 'online', pendingRequests: 1 });
    settleWarmup();

    await vi.waitFor(() => expect(captured.notify).toHaveBeenCalledOnce());
    expect(captured.kb.read()).toMatchObject({ phase: 'online', pendingRequests: 0 });
  });
});
