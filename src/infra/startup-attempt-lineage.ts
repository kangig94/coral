/**
 * Startup ownership may be released while the exact child is live only when the coordinator or sentinel
 * is attributable to that attempt. Two attempt identifiers that disagree must override matching build
 * identity; desired-build usability after the exact child terminates is a separate decision.
 *
 * An attempt id that is not an identifier proves nothing in either direction: it is neither this attempt
 * nor demonstrably another.
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

/**
 * An empty or whitespace-only value is not an identifier. An exported-but-empty variable and a health
 * payload carrying the same are both strings, and two of them compare equal.
 */
export function startupAttemptIdentifier(raw: string | undefined): string | null {
  return raw !== undefined && raw.trim().length > 0 ? raw : null;
}

export function resolveStartupAttemptLineage(evidence: {
  observedAttemptId?: string;
  expectedAttemptId?: string;
  observedIdentity?: StartupAttemptIdentity;
  desiredIdentity: StartupAttemptIdentity;
}): StartupAttemptLineage {
  const observedAttemptId = startupAttemptIdentifier(evidence.observedAttemptId);
  const expectedAttemptId = startupAttemptIdentifier(evidence.expectedAttemptId);

  // Two identifiers that disagree must exclude this attempt even when the bundle identities match; anything
  // that is not an identifier excludes nothing and must not be read as someone else's.
  if (observedAttemptId !== null && expectedAttemptId !== null) {
    if (observedAttemptId !== expectedAttemptId) {
      return Object.freeze({ kind: 'proven-other-attempt', proof: 'different-startup-attempt-id' });
    }
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
