import { afterEach, describe, expect, it } from 'vitest';

import { createIpcClient } from '#src/transport/ipc/client.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { repeatableRecoveryBoundaryIds } from '#src/recovery/source-registry.js';
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
    expect(caught).toMatchObject({
      code: 'recovery_quarantine_boundary_not_registered',
      message: 'That recovery boundary is not available for operator retry.',
    });
  });

  it('should report a missing quarantine row as an operator coordinate mistake', async () => {
    harness = createHandoffCoresHarness();
    const coordinator = await harness.bootCore({ instanceId: 'recovery-quarantine-missing-row' });
    const client = createIpcClient(coordinator.serverInfo.socketPath, harness.runtime.time, {
      kind: 'boot',
      token: coordinator.serverInfo.bootToken,
    });

    await expect(
      client.request('coordinator.recovery_quarantine.clear', {
        boundary: 'workflow-recovery',
        key: 'not-retained',
        revision: 'revision-1',
      }),
    ).rejects.toMatchObject({
      code: 'recovery_quarantine_subject_not_found',
      message: 'That recovery quarantine key does not name a retained row.',
    });
  });

  it.each(repeatableRecoveryBoundaryIds)(
    'should clear an absent subject retained for registered production boundary %s',
    async (boundary) => {
      harness = createHandoffCoresHarness();
      const coordinator = await harness.bootCore({ instanceId: `recovery-quarantine-${boundary}` });
      const quarantine = new RecoveryQuarantineStore(harness.db, harness.runtime.time);
      const subject = {
        key: `absent-${boundary}`,
        revision: { kind: 'fingerprint' as const, value: 'revision-1' },
      };
      expect(
        quarantine.upsert({
          boundary,
          subject,
          state: 'active',
          stage: 'hydrate',
          errorMessage: 'retained recovery failure',
          detail: 'operator retry required',
        }),
      ).toBe(true);
      const client = createIpcClient(coordinator.serverInfo.socketPath, harness.runtime.time, {
        kind: 'boot',
        token: coordinator.serverInfo.bootToken,
      });

      await expect(
        client.request('coordinator.recovery_quarantine.clear', {
          boundary,
          key: subject.key,
          revision: subject.revision.value,
        }),
      ).resolves.toEqual({
        boundary,
        key: subject.key,
        revision: subject.revision.value,
        disposition: 'advanced',
      });
      expect(quarantine.read(boundary, subject.key)).toBeNull();
    },
  );
});
