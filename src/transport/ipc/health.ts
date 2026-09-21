import type { CoordinatorDiscoveryRecord } from '../../infra/backend-discovery.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { TimePort } from '../../infra/port-types.js';
import { HEALTH_TIMEOUT_MS } from '../http/sse.js';
import { createIpcClient } from './client.js';

export type CoordinatorHealthIdentity = Readonly<{
  instanceId: string;
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  pid?: number;
  incarnation?: ProcessIncarnation;
}>;

export type AuthenticatedHealthObservation<THealth> =
  | Readonly<{ kind: 'health'; health: THealth }>
  | Readonly<{
      kind: 'unavailable';
      cause:
        | 'discovery-identity-incomplete'
        | 'socket-mismatch'
        | 'identity-mismatch'
        | 'transport-failure'
        | 'health-shape-rejected';
    }>;

type DecodedHealth<THealth> = Readonly<{
  health: THealth;
  identity: CoordinatorHealthIdentity;
}>;

export function discoveryRecordIdentity(record: CoordinatorDiscoveryRecord): CoordinatorHealthIdentity | null {
  if (record.instanceId === undefined || record.version === undefined) return null;
  return {
    instanceId: record.instanceId,
    version: record.version,
    bundleHash: record.bundleHash,
    flavor: record.flavor,
    namespace: record.namespace,
    pid: record.pid,
    ...(record.incarnation === undefined ? {} : { incarnation: record.incarnation }),
  };
}

function optionalIdentityMatches<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || actual === undefined || expected === actual;
}

export function identityMatchesExistingIncumbent(
  candidate: CoordinatorHealthIdentity,
  incumbent: CoordinatorHealthIdentity,
): boolean {
  return (
    candidate.instanceId === incumbent.instanceId &&
    candidate.version === incumbent.version &&
    candidate.bundleHash === incumbent.bundleHash &&
    candidate.flavor === incumbent.flavor &&
    candidate.namespace === incumbent.namespace &&
    optionalIdentityMatches(incumbent.pid, candidate.pid) &&
    optionalIdentityMatches(incumbent.incarnation, candidate.incarnation)
  );
}

export function discoveryMatchesExistingIncumbent(
  record: CoordinatorDiscoveryRecord,
  expectedSocketPath: string,
  incumbent: CoordinatorHealthIdentity,
): boolean {
  const identity = discoveryRecordIdentity(record);
  return (
    record.socketPath === expectedSocketPath &&
    identity !== null &&
    identityMatchesExistingIncumbent(identity, incumbent)
  );
}

export async function readIdentityCheckedAuthenticatedHealth<THealth>(
  record: CoordinatorDiscoveryRecord,
  expectedSocketPath: string,
  expectedIdentity: CoordinatorHealthIdentity | null,
  timePort: TimePort,
  decode: (value: unknown) => DecodedHealth<THealth> | null,
): Promise<AuthenticatedHealthObservation<THealth>> {
  const discoveryIdentity = discoveryRecordIdentity(record);
  if (expectedIdentity === null || discoveryIdentity === null) {
    return { kind: 'unavailable', cause: 'discovery-identity-incomplete' };
  }
  if (record.socketPath !== expectedSocketPath) {
    return { kind: 'unavailable', cause: 'socket-mismatch' };
  }
  if (!identityMatchesExistingIncumbent(discoveryIdentity, expectedIdentity)) {
    return { kind: 'unavailable', cause: 'identity-mismatch' };
  }

  let reply: unknown;
  try {
    const client = createIpcClient(record.socketPath, timePort, { kind: 'boot', token: record.bootToken });
    reply = await client.health<unknown>({ timeoutMs: HEALTH_TIMEOUT_MS });
  } catch {
    return { kind: 'unavailable', cause: 'transport-failure' };
  }

  const decoded = decode(reply);
  if (decoded === null) {
    return { kind: 'unavailable', cause: 'health-shape-rejected' };
  }
  if (
    !identityMatchesExistingIncumbent(decoded.identity, expectedIdentity) ||
    !discoveryMatchesExistingIncumbent(record, expectedSocketPath, decoded.identity)
  ) {
    return { kind: 'unavailable', cause: 'identity-mismatch' };
  }
  return { kind: 'health', health: decoded.health };
}
