import { createUnreadableProviderOperationDiscardService } from '../services/recovery/unreadable-provider-operation-discard.js';
import { unreadableProviderOperationDiscardResultSchema } from '../../transport/rpc/catalog.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import type { HealthSnapshot } from '../../transport/server-ports.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import { type createRuntimeState } from '../lifecycle.js';
import { type createRecoveryQuarantineRetryService } from '../../recovery/source-registry.js';
import { type createExecutionServices } from './execution-services.js';

export function createRecoveryQuarantinePorts({
  runtime,
  instanceId,
  runtimeState,
  recoveryQuarantineRetry,
  recoveryDb,
  releaseUnreadableProviderOperationStartupOwnership,
  providerOperationAdoptionRefusals,
  notifySuccessionObligationChange,
  maxAdoptionRefusals,
}: {
  runtime: Runtime;
  instanceId: string;
  runtimeState: ReturnType<typeof createRuntimeState>;
  recoveryQuarantineRetry: ReturnType<typeof createRecoveryQuarantineRetryService>;
  recoveryDb: () => Database;
  releaseUnreadableProviderOperationStartupOwnership: ReturnType<
    typeof createExecutionServices
  >['releaseUnreadableProviderOperationStartupOwnership'];
  providerOperationAdoptionRefusals: Map<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['providerOperationAdoptionRefusals']>[number]
  >;
  notifySuccessionObligationChange: () => void;
  maxAdoptionRefusals: number;
}): RpcPorts['recoveryQuarantine'] {
  return {
    clear: async (request, signal) => {
      const result = await recoveryQuarantineRetry.clear(request, signal);
      notifySuccessionObligationChange();
      return result;
    },
    discardProviderOperation: async (request) => {
      if (runtimeState.getLaunchFenceActive()) {
        return unreadableProviderOperationDiscardResultSchema.parse({
          ...request,
          kind: 'recovery-in-progress',
          code: 'backend_recovering',
          message: 'Provider-operation discard is unavailable while startup recovery owns the launch fence.',
          remedy: {
            kind: 'recovery-quarantine-discard',
            command: {
              kind: 'discard-provider-operation',
              key: request.key,
              revision: `fingerprint:${request.revision}`,
              allowReadable: request.allowReadable === true,
            },
          },
        });
      }
      const discard = createUnreadableProviderOperationDiscardService({
        instanceId: instanceId,
        ids: runtime.ids,
        db: recoveryDb(),
        time: runtime.time,
      });
      const result = unreadableProviderOperationDiscardResultSchema.parse(discard.discard(request));
      if (result.kind === 'discarded' || result.kind === 'absent') {
        const ownership = await releaseUnreadableProviderOperationStartupOwnership(result.key);
        if (ownership.kind === 'adoption-refused') {
          const observedAtMs = runtime.time.now();
          for (const refusal of ownership.refusals) {
            providerOperationAdoptionRefusals.delete(refusal.recordKey);
            providerOperationAdoptionRefusals.set(refusal.recordKey, {
              triggerRecordKey: result.key,
              rowDisposition: result.kind,
              releasedLaunchPermits: ownership.releasedLaunchPermits,
              ...refusal,
              observedAtMs,
            });
            if (providerOperationAdoptionRefusals.size > maxAdoptionRefusals) {
              const oldestRecordKey = providerOperationAdoptionRefusals.keys().next().value;
              if (oldestRecordKey !== undefined) providerOperationAdoptionRefusals.delete(oldestRecordKey);
            }
          }
          return unreadableProviderOperationDiscardResultSchema.parse({
            ...result,
            kind: 'adoption-refused',
            rowDisposition: result.kind,
            releasedLaunchPermits: ownership.releasedLaunchPermits,
            refusals: ownership.refusals,
          });
        }
      }
      return result;
    },
  };
}
