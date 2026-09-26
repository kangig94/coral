import type { Runtime } from '../../../runtime/ports.js';
import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../../../recovery/containment.js';
import { closureCandidates, uncertifiableEpochKeys, type ClosureCandidate } from './epoch-closure.js';

export function epochClosureRecoverySource(
  runtime: Runtime,
  subject: RecoverySubject,
  activeEpochKey: string | null,
): RecoverySource<ClosureCandidate> {
  return defineRecoverySource({
    boundary: 'epoch-closure',
    scanSubject: subject,
    scan: () => {
      const uncertifiable = uncertifiableEpochKeys(runtime, activeEpochKey ?? undefined);
      return closureCandidates(runtime).filter(
        (candidate) => candidate.epochKey === subject.key && uncertifiable?.has(candidate.epochKey) === false,
      );
    },
    subject: (candidate) => ({ key: candidate.epochKey, revision: { kind: 'until-cleared' } }),
  });
}
