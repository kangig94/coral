/**
 * "Is this coordinator, or this sentinel, the result of my startup attempt?" — one question, one answer.
 *
 * `CORAL_STARTUP_ATTEMPT_ID` is minted per spawn and inherited by delegated children, so a coordinator
 * carrying this attempt's id descends from it however many builds the startup was routed through. A
 * bundle-identity match proves the same thing independently; either proof alone is sufficient, and
 * neither is necessary.
 *
 * The proof brand is unforgeable outside this module: a caller cannot construct
 * `proven-current-attempt` from evidence that did not satisfy one of the two proofs.
 */
export type StartupAttemptIdentity = Readonly<{
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace?: string;
}>;

const startupAttemptLineageProof: unique symbol = Symbol('StartupAttemptLineageProof');

export type StartupAttemptLineage =
  | Readonly<{
      kind: 'proven-current-attempt';
      proof: 'startup-attempt-id' | 'desired-identity';
      [startupAttemptLineageProof]: true;
    }>
  | Readonly<{ kind: 'proven-other-attempt'; proof: 'different-startup-attempt-id' }>
  | Readonly<{ kind: 'unknown' }>;

export function resolveStartupAttemptLineage(evidence: {
  observedAttemptId?: string;
  expectedAttemptId?: string;
  observedIdentity?: StartupAttemptIdentity;
  desiredIdentity: StartupAttemptIdentity;
}): StartupAttemptLineage {
  if (evidence.expectedAttemptId !== undefined && evidence.observedAttemptId === evidence.expectedAttemptId) {
    return Object.freeze({
      kind: 'proven-current-attempt',
      proof: 'startup-attempt-id',
      [startupAttemptLineageProof]: true as const,
    });
  }

  const observed = evidence.observedIdentity;
  const desired = evidence.desiredIdentity;
  if (
    observed !== undefined &&
    observed.version === desired.version &&
    observed.bundleHash === desired.bundleHash &&
    observed.flavor === desired.flavor &&
    (desired.namespace === undefined || observed.namespace === desired.namespace)
  ) {
    return Object.freeze({
      kind: 'proven-current-attempt',
      proof: 'desired-identity',
      [startupAttemptLineageProof]: true as const,
    });
  }

  // Two ids that disagree is the only evidence that positively excludes this attempt; a missing id
  // excludes nothing, and must not be read as someone else's.
  if (evidence.expectedAttemptId !== undefined && evidence.observedAttemptId !== undefined) {
    return Object.freeze({ kind: 'proven-other-attempt', proof: 'different-startup-attempt-id' });
  }
  return Object.freeze({ kind: 'unknown' });
}
