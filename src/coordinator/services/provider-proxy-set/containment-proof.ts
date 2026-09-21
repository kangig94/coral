import { createRecordedProcessObserver, type ProcessIncarnation } from '../../../infra/node-process.js';
import {
  providerProxySetContainmentEvidenceSchema,
  type ProviderProxySetContainmentEvidence,
  type ProviderProxySetEnforcerObservations,
} from '../../../provider-proxy/containment-proof-contract.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { Database } from '../../../store/db.js';
import {
  attributeUnreadableProviderOperations,
  type ProviderOperationMutationSetFence,
  readProviderOperations,
} from '../../../store/provider-operation-journal.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentitySchema,
  providerProxySetIdentityFromRecord,
  type ProviderProxySetIdentity,
} from './identity.js';

/**
 * Observes the dual recorded enforcers and gathers the exact recorded targets without signalling any process.
 */
export interface ProviderProxySetContainmentProver {
  collectContainmentProof<Authorization extends ProviderProxySetContainmentProofAuthorization>(
    authorization: Authorization,
    db: Database,
    signal: AbortSignal,
  ): Promise<ProviderProxySetContainmentProofForAuthorization<Authorization>>;
}

declare const providerProxySetContainmentProofAuthorizationBrand: unique symbol;
declare const providerProxySetContainmentProofBrand: unique symbol;
declare const providerProxySetContainmentProofFenceBrand: unique symbol;

/** An exact-set authorization that only the containment prover may turn into process evidence. */
export type ProviderProxySetContainmentProofAuthorization = Readonly<{
  [providerProxySetContainmentProofAuthorizationBrand]: true;
}>;

/** Opaque store and process evidence bound to one complete provider-proxy set identity. */
export type ProviderProxySetContainmentProof = Readonly<{
  [providerProxySetContainmentProofBrand]: true;
}>;

export type ProviderProxySetFencedContainmentProofAuthorization = ProviderProxySetContainmentProofAuthorization &
  Readonly<{ [providerProxySetContainmentProofFenceBrand]: 'authorization' }>;

export type ProviderProxySetFencedContainmentProof = ProviderProxySetContainmentProof &
  Readonly<{ [providerProxySetContainmentProofFenceBrand]: 'proof' }>;

export type ProviderProxySetContainmentProofForAuthorization<
  Authorization extends ProviderProxySetContainmentProofAuthorization,
> = Authorization extends ProviderProxySetFencedContainmentProofAuthorization
  ? ProviderProxySetFencedContainmentProof
  : ProviderProxySetContainmentProof;

type ContainmentProofRecord = Readonly<{
  authorization: ProviderProxySetContainmentProofAuthorization;
  identity: ProviderProxySetIdentity;
  evidence: ProviderProxySetContainmentEvidence;
  currentness: ContainmentProofCurrentness | null;
}>;

type ContainmentProofCurrentness = Readonly<{
  db: Database;
  fence: ProviderOperationMutationSetFence;
  generation: number;
}>;

type ContainmentProofAuthorizationRecord = Readonly<{
  identity: ProviderProxySetIdentity;
  fence: ProviderOperationMutationSetFence | null;
  closeAdmission: (() => Promise<void>) | null;
}>;

export type ProviderProxySetContainmentProofFence = Readonly<{
  mutationFence: ProviderOperationMutationSetFence;
  closeAdmission(): Promise<void>;
}>;

export type ProviderProxySetContainmentProofCurrentness =
  | Readonly<{ kind: 'current' }>
  | Readonly<{ kind: 'authorization-missing' }>
  | Readonly<{ kind: 'authorization-stale' }>
  | Readonly<{ kind: 'store-unreadable' }>;

export type ProviderProxySetContainmentProofFenceRelease =
  | Readonly<{ kind: 'released' | 'already-released' }>
  | Readonly<{ kind: 'held'; error: unknown }>;

export type ProviderProxySetContainmentProofFenceHandback = Readonly<{
  rearm: Readonly<{ kind: 'completed' }> | Readonly<{ kind: 'failed'; error: unknown }>;
  release: ProviderProxySetContainmentProofFenceRelease;
}>;

const authorizationRecords = new WeakMap<
  ProviderProxySetContainmentProofAuthorization,
  ContainmentProofAuthorizationRecord
>();
const containmentProofRecords = new WeakMap<ProviderProxySetContainmentProof, ContainmentProofRecord>();

/** Reads an opaque proof for policy classification without granting signal authority. */
export function inspectProviderProxySetContainmentProof(value: unknown): Readonly<{
  identity: ProviderProxySetIdentity;
  evidence: ProviderProxySetContainmentEvidence;
  authorization: 'fenced' | 'unfenced';
}> | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = containmentProofRecords.get(value as ProviderProxySetContainmentProof);
  return record === undefined
    ? null
    : {
        identity: record.identity,
        evidence: record.evidence,
        authorization: record.currentness === null ? 'unfenced' : 'fenced',
      };
}

/** Mints the only input from which the prover may derive an exact-set proof. */
export function authorizeProviderProxySetContainmentProof(
  identity: ProviderProxySetIdentity,
  fence: ProviderProxySetContainmentProofFence,
): ProviderProxySetFencedContainmentProofAuthorization;
export function authorizeProviderProxySetContainmentProof(
  identity: ProviderProxySetIdentity,
): ProviderProxySetContainmentProofAuthorization;
export function authorizeProviderProxySetContainmentProof(
  identity: ProviderProxySetIdentity,
  fence?: ProviderProxySetContainmentProofFence,
): ProviderProxySetContainmentProofAuthorization {
  const authorization = Object.freeze({}) as ProviderProxySetContainmentProofAuthorization;
  authorizationRecords.set(authorization, {
    identity: Object.freeze(providerProxySetIdentitySchema.parse(identity)),
    fence: fence?.mutationFence ?? null,
    closeAdmission: fence?.closeAdmission ?? null,
  });
  return authorization;
}

/** Only the authorization that owns a fence lease may release that lease. */
export function releaseProviderProxySetContainmentProofFence(
  owner: ProviderProxySetContainmentProofAuthorization | ProviderProxySetContainmentProof,
): ProviderProxySetContainmentProofFenceRelease {
  const authorization = containmentProofRecords.get(owner as ProviderProxySetContainmentProof)?.authorization ?? owner;
  const fence = authorizationRecords.get(authorization as ProviderProxySetContainmentProofAuthorization)?.fence;
  if (fence === null || fence === undefined) return { kind: 'already-released' };
  try {
    if (!fence.isHeld()) return { kind: 'already-released' };
  } catch (error: unknown) {
    return { kind: 'held', error };
  }
  try {
    fence.release();
  } catch (error: unknown) {
    try {
      return fence.isHeld() ? { kind: 'held', error } : { kind: 'released' };
    } catch {
      return { kind: 'held', error };
    }
  }
  try {
    return fence.isHeld()
      ? { kind: 'held', error: new Error('provider_proxy_set_containment_proof_fence_release_incomplete') }
      : { kind: 'released' };
  } catch (error: unknown) {
    return { kind: 'held', error };
  }
}

export function handbackProviderProxySetContainmentProofFence(
  owner: ProviderProxySetContainmentProofAuthorization | ProviderProxySetContainmentProof,
  rearm: () => void,
): ProviderProxySetContainmentProofFenceHandback {
  let rearmDisposition: ProviderProxySetContainmentProofFenceHandback['rearm'];
  try {
    rearm();
    rearmDisposition = { kind: 'completed' };
  } catch (error: unknown) {
    rearmDisposition = { kind: 'failed', error };
  }
  return {
    rearm: rearmDisposition,
    release: releaseProviderProxySetContainmentProofFence(owner),
  };
}

/** A post-proof mutation remains confined to the exact set and the proof's still-held lease. */
export function runProviderProxySetContainmentProofMutation<Result>(
  proof: ProviderProxySetFencedContainmentProof,
  expectedIdentity: ProviderProxySetIdentity,
  label: string,
  mutation: () => Result | Promise<Result>,
): Promise<Result> {
  const record = containmentProofRecords.get(proof);
  if (record === undefined) return Promise.reject(new Error('provider_proxy_set_containment_proof_invalid'));
  if (!providerProxySetIdentitiesEqual(record.identity, expectedIdentity)) {
    return Promise.reject(new Error('provider_proxy_set_containment_proof_identity_mismatch'));
  }
  if (record.currentness === null) {
    return Promise.reject(new Error('provider_proxy_set_containment_proof_authorization_missing'));
  }
  if (!record.currentness.fence.isHeld()) {
    return Promise.reject(new Error('provider_proxy_set_containment_proof_authorization_stale'));
  }
  return record.currentness.fence.run(label, mutation);
}

/**
 * Returns the raw evidence only when the opaque proof names the complete expected identity and, when supplied,
 * the same authorization that initiated collection.
 */
export function providerProxySetContainmentEvidenceFor(
  proof: ProviderProxySetContainmentProof,
  expectedIdentity: ProviderProxySetIdentity,
  expectedAuthorization?: ProviderProxySetContainmentProofAuthorization,
): ProviderProxySetContainmentEvidence {
  const record = containmentProofRecords.get(proof);
  if (record === undefined) throw new Error('provider_proxy_set_containment_proof_invalid');
  if (!providerProxySetIdentitiesEqual(record.identity, expectedIdentity)) {
    throw new Error('provider_proxy_set_containment_proof_identity_mismatch');
  }
  if (expectedAuthorization !== undefined && record.authorization !== expectedAuthorization) {
    throw new Error('provider_proxy_set_containment_proof_authorization_mismatch');
  }
  return record.evidence;
}

async function collectProviderProxySetContainmentEvidence(
  identity: ProviderProxySetIdentity,
  db: Database,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<ProviderProxySetContainmentEvidence> {
  const platform = runtime.env.platform() as NodeJS.Platform;
  const operationScan = readProviderOperations(db);
  // An unreadable row may name another provider root for *this* set, and acting on the decoded subset would
  // let that root survive outside the process group while this function minted a disappearance receipt. So the
  // evidence stays fenced — but only for the sets the row could belong to, which is asked of both its key and
  // its bytes. Those disagree exactly when the decode failed *because* they disagree, and a row attributable
  // from neither side could belong to any set, so it fences all of them.
  const hidesARootOfThisSet = scanHidesRoot(identity, db, operationScan.unreadableKeys);
  if (hidesARootOfThisSet) return { kind: 'store-unreadable' };

  const observeEnforcer = createRecordedProcessObserver({
    readIncarnation: (pid) => runtime.process.readProcessIncarnation(pid, platform),
    observeLiveness: (pid) => runtime.process.observeLiveness(pid),
  });
  // These identities were recorded by the enforcers. A different fresh incarnation proves that the pid now
  // belongs to someone else; only an absent observation discounts an enforcer before process-group reaping.
  const observations: ProviderProxySetEnforcerObservations = [
    {
      role: 'guardian',
      observation: observeEnforcer({
        pid: identity.guardianPid,
        incarnation: identity.guardianIncarnation,
      }),
    },
    {
      role: 'reaper',
      observation: observeEnforcer({
        pid: identity.reaperPid,
        incarnation: identity.reaperIncarnation,
      }),
    },
  ];
  if (observations.some(({ observation }) => observation !== 'absent')) {
    return providerProxySetContainmentEvidenceSchema.parse({ kind: 'enforcers-observed', observations });
  }
  signal.throwIfAborted();

  const recordedRoots = recordedRootsFromScan(identity, operationScan);
  const containment = {
    pid: identity.proxyPid,
    incarnation: identity.proxyIncarnation,
    processGroupId: identity.proxyProcessGroupId,
  };
  signal.throwIfAborted();
  return providerProxySetContainmentEvidenceSchema.parse({ kind: 'reap-required', containment, recordedRoots });
}

function recordedRootsFromScan(
  identity: ProviderProxySetIdentity,
  operationScan: ReturnType<typeof readProviderOperations>,
): readonly Readonly<{ pid: number; incarnation: ProcessIncarnation }>[] {
  const roots = new Map<string, Readonly<{ pid: number; incarnation: ProcessIncarnation }>>();
  for (const record of operationScan.records) {
    if (
      !('providerRoot' in record) ||
      !providerProxySetIdentitiesEqual(providerProxySetIdentityFromRecord(record), identity)
    ) {
      continue;
    }
    roots.set(`${record.providerRoot.pid}@${record.providerRoot.incarnation}`, record.providerRoot);
  }
  return [...roots.values()];
}

function scanHidesRoot(identity: ProviderProxySetIdentity, db: Database, unreadableKeys: readonly string[]): boolean {
  return attributeUnreadableProviderOperations(db, unreadableKeys).some(
    ({ sets }) =>
      sets.kind === 'indeterminate' ||
      sets.values.some(
        (address) => address.proxyInstanceId === identity.proxyInstanceId && address.buildSetId === identity.buildSetId,
      ),
  );
}

/** A fenced proof stays current only while its lease, journal generation, and attributed roots match its scan. */
export function verifyProviderProxySetContainmentProofCurrent(
  proof: ProviderProxySetContainmentProof,
  expectedIdentity: ProviderProxySetIdentity,
): ProviderProxySetContainmentProofCurrentness {
  const record = containmentProofRecords.get(proof);
  if (record === undefined) throw new Error('provider_proxy_set_containment_proof_invalid');
  if (!providerProxySetIdentitiesEqual(record.identity, expectedIdentity)) {
    throw new Error('provider_proxy_set_containment_proof_identity_mismatch');
  }
  if (record.currentness === null) return { kind: 'authorization-missing' };
  if (!record.currentness.fence.isHeld()) return { kind: 'authorization-stale' };

  const generationBefore = record.currentness.fence.currentGeneration();
  const operationScan = readProviderOperations(record.currentness.db);
  const generationAfter = record.currentness.fence.currentGeneration();
  if (
    !record.currentness.fence.isHeld() ||
    generationBefore !== record.currentness.generation ||
    generationAfter !== record.currentness.generation
  ) {
    return { kind: 'authorization-stale' };
  }
  if (scanHidesRoot(record.identity, record.currentness.db, operationScan.unreadableKeys)) {
    return { kind: 'store-unreadable' };
  }
  if (record.evidence.kind === 'reap-required') {
    const roots = recordedRootsFromScan(record.identity, operationScan);
    const expectedRoots = new Set(record.evidence.recordedRoots.map((root) => `${root.pid}@${root.incarnation}`));
    if (
      roots.length !== expectedRoots.size ||
      roots.some((root) => !expectedRoots.has(`${root.pid}@${root.incarnation}`))
    ) {
      return { kind: 'authorization-stale' };
    }
  }
  return { kind: 'current' };
}

/** Admission closure must settle before observation, and a failed collection must release its fence lease. */
export function createProviderProxySetContainmentProver(runtime: Runtime): ProviderProxySetContainmentProver {
  return {
    async collectContainmentProof<Authorization extends ProviderProxySetContainmentProofAuthorization>(
      authorization: Authorization,
      db: Database,
      signal: AbortSignal,
    ): Promise<ProviderProxySetContainmentProofForAuthorization<Authorization>> {
      const authorizationRecord = authorizationRecords.get(authorization);
      if (authorizationRecord === undefined) {
        throw new Error('provider_proxy_set_containment_proof_authorization_invalid');
      }
      try {
        await authorizationRecord.closeAdmission?.();
        signal.throwIfAborted();
        const generation = authorizationRecord.fence?.currentGeneration() ?? null;
        const proof = Object.freeze({}) as ProviderProxySetContainmentProof;
        containmentProofRecords.set(proof, {
          authorization,
          identity: authorizationRecord.identity,
          evidence: await collectProviderProxySetContainmentEvidence(authorizationRecord.identity, db, runtime, signal),
          currentness:
            authorizationRecord.fence === null || generation === null
              ? null
              : { db, fence: authorizationRecord.fence, generation },
        });
        return proof as ProviderProxySetContainmentProofForAuthorization<Authorization>;
      } catch (error: unknown) {
        authorizationRecord.fence?.release();
        throw error;
      }
    },
  };
}
