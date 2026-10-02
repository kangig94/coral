import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../recovery/containment.js';

export function jobLocationRecoverySource(
  epochKey: string,
  subject: RecoverySubject,
): RecoverySource<{ epochKey: string }> {
  return defineRecoverySource({
    boundary: 'job-location-write-through',
    scanSubject: subject,
    scan: () => (subject.key === epochKey ? [{ epochKey }] : []),
    subject: (item) => ({ key: item.epochKey, revision: { kind: 'until-cleared' } }),
  });
}
