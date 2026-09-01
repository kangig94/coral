/**
 * Startup ownership may be released while the exact child is live only when the coordinator or sentinel
 * is attributable to that attempt. Two present attempt ids that disagree must override matching build
 * identity; desired-build usability after the exact child terminates is a separate decision.
 *
 * The proof brand prevents callers from constructing `proven-current-attempt` without this module's
 * attribution rules.
 */
export type StartupAttemptIdentity = Readonly<{
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
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

export function startupAttemptIdentityMatches(
  observed: StartupAttemptIdentity | undefined,
  desired: StartupAttemptIdentity,
): boolean {
  return (
    observed !== undefined &&
    observed.version === desired.version &&
    observed.bundleHash === desired.bundleHash &&
    observed.flavor === desired.flavor &&
    typeof desired.namespace === 'string' &&
    desired.namespace.length > 0 &&
    observed.namespace === desired.namespace
  );
}

export function resolveStartupAttemptLineage(evidence: {
  observedAttemptId?: string;
  expectedAttemptId?: string;
  observedIdentity?: StartupAttemptIdentity;
  desiredIdentity: StartupAttemptIdentity;
}): StartupAttemptLineage {
  // Two present ids that disagree must exclude this attempt even when the bundle identities match;
  // a missing id excludes nothing and must not be read as someone else's.
  if (
    evidence.expectedAttemptId !== undefined &&
    evidence.observedAttemptId !== undefined &&
    evidence.observedAttemptId !== evidence.expectedAttemptId
  ) {
    return Object.freeze({ kind: 'proven-other-attempt', proof: 'different-startup-attempt-id' });
  }

  if (evidence.expectedAttemptId !== undefined && evidence.observedAttemptId === evidence.expectedAttemptId) {
    return Object.freeze({
      kind: 'proven-current-attempt',
      proof: 'startup-attempt-id',
      [startupAttemptLineageProof]: true as const,
    });
  }

  if (startupAttemptIdentityMatches(evidence.observedIdentity, evidence.desiredIdentity)) {
    return Object.freeze({
      kind: 'proven-current-attempt',
      proof: 'desired-identity',
      [startupAttemptLineageProof]: true as const,
    });
  }

  return Object.freeze({ kind: 'unknown' });
}
