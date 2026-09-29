import type { JsonValue } from '../../../infra/json-value.js';
import { readJobLaunchOriginNamespace } from '../../../jobs/succession-coverage.js';
import { createDefaultStoreReadContext } from '../../../read-model/read-context.js';
import type { SuccessionOwner } from '../../succession/obligations.js';
import type { SuccessionOwnersInput } from './index.js';

export function createChildPrincipalSuccessionOwner(input: SuccessionOwnersInput): SuccessionOwner {
  const { runtime, world, getProgressStore, readSuccessionJobs } = input;
  return {
    id: 'child-principals',
    recordsGrants: true,
    dischargeGrants: (retained) => world.childPrincipalRegistry.dischargeGrants(retained),
    classify: async (attemptId) => {
      const snapshot = world.childPrincipalRegistry.transferSnapshot(runtime.time.now());
      if (snapshot.entries.length === 0) return { kind: 'completed', reason: 'no live child handle' };
      const transfer = world.childPrincipalRegistry.prepareTransfer(attemptId, runtime.time.now());
      if (transfer?.recoveryGrantId === undefined) {
        return { kind: 'blocking', reason: 'child nonce recovery grant could not be recorded' };
      }
      const liveJobs = new Set(readSuccessionJobs());
      if (transfer.entries.some((entry) => !liveJobs.has(entry.parentJobId))) {
        return { kind: 'blocking', reason: 'child handle has no accepted live parent job' };
      }
      if (
        transfer.entries.some(
          (entry) =>
            readJobLaunchOriginNamespace(
              getProgressStore().getDb(),
              entry.parentJobId,
              createDefaultStoreReadContext(),
            ) !== entry.authorization.namespace,
        )
      )
        return { kind: 'blocking', reason: 'child origin launch evidence is missing or conflicting' };
      return {
        kind: 'transferable',
        reason: 'handles and consumed nonces are recorded for fenced adoption',
        receipt: {
          owner: 'child-principals',
          generation: 1,
          attemptId,
          receiptId: `child-principals:${attemptId}`,
          recoveryGrantId: transfer.recoveryGrantId,
          payload: JSON.parse(JSON.stringify(transfer)) as JsonValue,
        },
      };
    },
  };
}
