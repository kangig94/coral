import type { Runtime } from '../../../runtime/ports.js';
import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../../../recovery/containment.js';
import { closureCandidates, currentEpochLineageKey, type ClosureCandidate } from './epoch-closure.js';

export function epochClosureRecoverySource(
  runtime: Runtime,
  subject: RecoverySubject,
  activeEpochKey: string | null,
): RecoverySource<ClosureCandidate> {
  const selectedKey = activeEpochKey ?? currentEpochLineageKey(runtime);
  return defineRecoverySource({
    boundary: 'epoch-closure',
    scanSubject: subject,
    scan: () =>
      closureCandidates(runtime).filter(
        (candidate) => candidate.epochKey === subject.key && candidate.epochKey !== selectedKey,
      ),
    subject: (candidate) => ({ key: candidate.epochKey, revision: { kind: 'until-cleared' } }),
  });
}
