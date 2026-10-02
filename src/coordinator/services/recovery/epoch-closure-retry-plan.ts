import type { Runtime } from '../../../runtime/ports.js';
import type { JobLocationIndex } from '../../../jobs/location-index.js';
import type { RecoverySubject } from '../../../recovery/containment.js';
import type { RecoverySourceFactoryPlan } from '../../../recovery/source-registry.js';
import { settleSupersededEpochClosures, type CloseProxySet, type ClosureCandidate } from './epoch-closure.js';
import { epochClosureRecoverySource } from './epoch-closure-source.js';

export function createEpochClosureRetryPlan(
  runtime: Runtime,
  index: JobLocationIndex,
  subject: RecoverySubject,
  signal: AbortSignal,
  activeEpochKey: string | null,
  closeProxySet?: CloseProxySet,
): RecoverySourceFactoryPlan<ClosureCandidate, ClosureCandidate> {
  return {
    source: epochClosureRecoverySource(runtime, subject, activeEpochKey),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (raw) => raw,
      requiredObligations: () => [],
      settle: async (candidate) => {
        const records = await settleSupersededEpochClosures(
          runtime,
          index,
          signal,
          candidate.epochKey,
          activeEpochKey ?? undefined,
          closeProxySet,
        );
        return records[0]?.disposition === 'closed'
          ? { kind: 'advanced', outcome: 'settled', facts: [], detail: 'Epoch execution discharge certified.' }
          : { kind: 'quarantine', detail: records[0]?.reason ?? 'Epoch closure remains undecidable.' };
      },
      onFault: (fault) => ({ kind: 'quarantine', detail: String(fault.error) }),
    },
  };
}
