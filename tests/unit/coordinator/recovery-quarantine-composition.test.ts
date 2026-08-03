import { afterEach, describe, expect, it } from 'vitest';

import { createIpcClient } from '#src/transport/ipc/client.js';
import {
  createHandoffCoresHarness,
  type HandoffCoresHarness,
} from '#tests/integration/coordinator/handoff-cores-harness.js';

describe('recovery quarantine composition', () => {
  let harness: HandoffCoresHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it('should provide the recovery quarantine port to the real IPC catalog', async () => {
    harness = createHandoffCoresHarness();
    const coordinator = await harness.bootCore({ instanceId: 'recovery-quarantine-composition' });
    const client = createIpcClient(coordinator.serverInfo.socketPath, harness.runtime.time, {
      kind: 'boot',
      token: coordinator.serverInfo.bootToken,
    });

    let caught: unknown;
    try {
      await client.request('coordinator.recovery_quarantine.clear', {
        boundary: 'not-a-registered-boundary',
        key: 'subject-1',
        revision: 'revision-1',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ message: 'Internal error' });
    expect(caught).not.toMatchObject({ code: 'recovery_quarantine_unavailable' });
  });
});
