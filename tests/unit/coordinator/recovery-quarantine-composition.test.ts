import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';

import { createIpcClient } from '#src/transport/ipc/client.js';
import { encodeRecoveryQuarantineKey, RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import {
  repeatableRecoveryBoundaryIds,
  SETTLED_UNBOUND_STATUS_BOUNDARY,
  SETTLED_UNBOUND_STATUS_REMEDIATION,
  type RecoveryQuarantineClearResult,
} from '#src/recovery/source-registry.js';
import {
  createSettledUnboundStatusPort,
  settledUnboundStatusSubject,
} from '#src/coordinator/services/recovery/settled-unbound-status.js';
import { registerBackendCommands } from '#src/cli/commands/backend.js';
import {
  deleteProviderOperation,
  insertProviderOperation,
  readProviderOperation,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
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
      const statusSubject = settledUnboundStatusSubject({ jobId: 'absent-job', operationId: 'absent-operation' });
      const subject =
        boundary === SETTLED_UNBOUND_STATUS_BOUNDARY
          ? {
              key: statusSubject.key,
              revision: { kind: 'fingerprint' as const, value: statusSubject.revision },
            }
          : {
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

  it('rehydrates and clears a settled-unbound status after restart without an in-memory binding', async () => {
    harness = createHandoffCoresHarness();
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(harness.db, record);
    const status = createSettledUnboundStatusPort(() => harness!.db, harness.runtime.time);
    const recorded = status.record(record.operation);
    if (recorded.kind !== 'recorded') throw new Error('expected durable settled-unbound status');
    const [subject] = recorded.ownership.subjects;
    if (subject === undefined) throw new Error('expected durable settled-unbound subject');

    const coordinator = await harness.bootCore({ instanceId: 'settled-unbound-restart-owner' });
    const quarantine = new RecoveryQuarantineStore(harness.db, harness.runtime.time);
    expect(quarantine.read(subject.boundary, subject.key)).not.toBeNull();
    const admission = coordinator.core.launchCoordinator.requestLaunch(
      record.operation.jobId,
      'codex',
      { kind: 'system-task', id: 'settled-unbound-restart-preparation' },
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected caller permit');
    expect(
      coordinator.core.launchCoordinator.prepareProviderOperationBinding(admission.permit, record.operation),
    ).toEqual({ kind: 'already-settled' });
    expect(quarantine.read(subject.boundary, subject.key)).toBeNull();
    expect(coordinator.core.launchCoordinator.reservationFor(record.operation.jobId)).toBeNull();
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({ operation: record.operation });
  });

  it('runs the advertised command after restart to clear durable and rehydrated settled-unbound ownership', async () => {
    harness = createHandoffCoresHarness();
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(harness.db, record);
    const status = createSettledUnboundStatusPort(() => harness!.db, harness.runtime.time);
    const recorded = status.record(record.operation);
    if (recorded.kind !== 'recorded') throw new Error('expected durable settled-unbound status');
    const [subject] = recorded.ownership.subjects;
    if (subject === undefined) throw new Error('expected durable settled-unbound subject');
    expect(deleteProviderOperation(harness.db, record)).toMatchObject({ kind: 'deleted' });

    const coordinator = await harness.bootCore({ instanceId: 'settled-unbound-restart-owner' });
    const quarantine = new RecoveryQuarantineStore(harness.db, harness.runtime.time);
    expect(quarantine.read(subject.boundary, subject.key)).not.toBeNull();
    const client = createIpcClient(coordinator.serverInfo.socketPath, harness.runtime.time, {
      kind: 'boot',
      token: coordinator.serverInfo.bootToken,
    });
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, {
      recoveryQuarantine: {
        list: () => quarantine.list(),
        clear: (request) =>
          client.request<RecoveryQuarantineClearResult>('coordinator.recovery_quarantine.clear', request),
      },
    });
    await program.parseAsync([
      'node',
      ...SETTLED_UNBOUND_STATUS_REMEDIATION.exit.split(' '),
      '--boundary',
      subject.boundary,
      '--key',
      encodeRecoveryQuarantineKey(subject.key),
      '--revision',
      `fingerprint:${subject.revision}`,
    ]);

    expect(quarantine.read(subject.boundary, subject.key)).toBeNull();
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    const admission = coordinator.core.launchCoordinator.requestLaunch(
      record.operation.jobId,
      'codex',
      { kind: 'system-task', id: 'settled-unbound-remediation-verification' },
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected caller permit');
    expect(
      coordinator.core.launchCoordinator.prepareProviderOperationBinding(admission.permit, record.operation),
    ).toEqual({ kind: 'prepared' });
    expect(coordinator.core.launchCoordinator.releaseLaunch(admission.permit)).toMatchObject({ kind: 'released' });
  });
});
