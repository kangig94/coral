import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';

import { createIpcClient } from '#src/transport/ipc/client.js';
import { encodeRecoveryQuarantineKey, RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import type { RecoveryQuarantineClearResult } from '#src/recovery/source-registry.js';
import { createSettledUnboundStatusPort } from '#src/coordinator/services/recovery/settled-unbound-status.js';
import { registerBackendCommands } from '#src/cli/commands/backend.js';
import { formatRecoveryQuarantineList } from '#src/cli/format/backend.js';
import { executeRenderedCommand } from '#tests/helpers/rendered-command.js';
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
    await executeRenderedCommand(program, formatRecoveryQuarantineList(quarantine.list()), {
      label: 'clear',
      includes: encodeRecoveryQuarantineKey(subject.key),
    });

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
