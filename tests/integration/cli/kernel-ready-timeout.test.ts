import { describe, expect, it } from 'vitest';

import { HANDOFF_DRAIN_TIMEOUT_MS, KERNEL_READY_DEADLINE_MS } from '#src/transport/ipc/ensure.js';

describe('kernel-ready timeout constants', () => {
  it('ready deadline is 15s', () => {
    expect(KERNEL_READY_DEADLINE_MS).toBe(15_000);
  });

  it('handoff drain timeout is 30s', () => {
    expect(HANDOFF_DRAIN_TIMEOUT_MS).toBe(30_000);
  });
});
