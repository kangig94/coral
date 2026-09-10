import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import type { LaunchPermit } from '#src/jobs/contracts/admission.js';
import type { ProviderOperationStartupOwnership } from '#src/jobs/startup.js';
import type { ExecutionOwner } from '#src/runtime/execution-owner.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import type { ProviderOperationStartupRelease } from '#src/coordinator/services/recovery/index.js';

type StartupLaunch = Readonly<{
  provider: string;
  owner: ExecutionOwner;
  pool: 'default' | 'discuss' | 'curate';
}>;

type StartupOwnershipHarness = Readonly<{
  binding: LaunchCoordinator;
  ownership: ProviderOperationStartupOwnership;
  ownershipFor(records: readonly ProviderOperationRecord[]): ProviderOperationStartupOwnership;
  releaseStartupOwnership(operation: ProviderOperationRecord['operation']): ProviderOperationStartupRelease;
}>;

function operationKey(operation: ProviderOperationRecord['operation']): string {
  return `${operation.jobId}\u0000${operation.operationId}`;
}

function startupBindingDisposition(
  disposition: ReturnType<LaunchCoordinator['prepareProviderOperationBinding']>,
  exit:
    | 'restart-or-operator-repair'
    | 'remote-settlement'
    | 'coral-cli backend recovery-quarantine discard-provider-operation --allow-readable',
): ProviderOperationStartupOwnership['records'][number]['bindingDisposition'] {
  return disposition.kind === 'refused' ? { ...disposition, exit } : disposition;
}

export function createProviderOperationStartupOwnershipHarness(
  options: Readonly<{
    runtime: Runtime;
    records: readonly ProviderOperationRecord[];
    coordinator?: LaunchCoordinator;
    launchFor?: (record: ProviderOperationRecord) => StartupLaunch;
  }>,
): StartupOwnershipHarness {
  const binding = options.coordinator ?? new LaunchCoordinator({ runtime: options.runtime });
  const retainedStartupPermits = new Map<string, LaunchPermit>();
  const permitsByJobId = new Map<string, LaunchPermit>();
  const launchFor =
    options.launchFor ??
    ((record: ProviderOperationRecord): StartupLaunch => ({
      provider: 'codex',
      owner: { kind: 'system-task', id: `startup-${record.operation.jobId}` },
      pool: 'default',
    }));

  const ownershipFor = (sourceRecords: readonly ProviderOperationRecord[]): ProviderOperationStartupOwnership => {
    const records = sourceRecords.map((record): ProviderOperationStartupOwnership['records'][number] => {
      if (record.phase === 'settlement-pending') {
        permitsByJobId.delete(record.operation.jobId);
        return {
          phase: record.phase,
          operation: record.operation,
          restoredPermit: null,
          bindingDisposition: startupBindingDisposition(
            binding.settleProviderOperationBinding(record.operation),
            'remote-settlement',
          ),
        };
      }
      if (record.phase === 'local-recovery-pending') {
        const permit = permitsByJobId.get(record.operation.jobId);
        if (permit !== undefined) {
          binding.cancelProviderOperationBinding(permit, record.operation);
          binding.releaseLaunch(permit);
          permitsByJobId.delete(record.operation.jobId);
        }
        return {
          phase: record.phase,
          operation: record.operation,
          restoredPermit: null,
          bindingDisposition: { kind: 'not-required', owner: 'generic-job-recovery' },
        };
      }

      let permit = permitsByJobId.get(record.operation.jobId);
      if (permit === undefined) {
        const launch = launchFor(record);
        permit = binding.restoreActiveLaunch(record.operation.jobId, launch.provider, launch.owner, launch.pool);
        permitsByJobId.set(record.operation.jobId, permit);
      }
      if (record.phase === 'prestart-cleanup-pending') {
        binding.cancelProviderOperationBinding(permit, record.operation);
        retainedStartupPermits.set(operationKey(record.operation), permit);
        return {
          phase: record.phase,
          operation: record.operation,
          restoredPermit: permit,
          bindingDisposition: { kind: 'not-required', owner: 'prestart-cleanup' },
        };
      }
      return {
        phase: record.phase,
        operation: record.operation,
        restoredPermit: permit,
        bindingDisposition: startupBindingDisposition(
          binding.prepareProviderOperationBinding(permit, record.operation),
          'restart-or-operator-repair',
        ),
      };
    });

    const holds = records.flatMap((record) =>
      record.bindingDisposition.kind === 'refused'
        ? [
            {
              kind: 'operation' as const,
              jobId: record.operation.jobId,
              operationId: record.operation.operationId,
              reason: record.bindingDisposition.reason,
              exit: record.bindingDisposition.exit,
            },
          ]
        : [],
    );
    return {
      completion: holds.length === 0 ? { kind: 'complete' } : { kind: 'held', holds },
      jobIds: [...new Set(records.map((record) => record.operation.jobId))],
      records,
      unreadable: [],
    };
  };

  const ownership = ownershipFor(options.records);

  return {
    binding,
    ownership,
    ownershipFor,
    releaseStartupOwnership: (operation) => {
      const key = operationKey(operation);
      const permit = retainedStartupPermits.get(key);
      if (permit === undefined) return { kind: 'not-owned' };
      retainedStartupPermits.delete(key);
      return binding.releaseLaunch(permit);
    },
  };
}
