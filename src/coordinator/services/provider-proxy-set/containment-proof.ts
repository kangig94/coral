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
  collectContainmentProof(
    authorization: ProviderProxySetContainmentProofAuthorization,
    db: Database,
    signal: AbortSignal,
  ): Promise<ProviderProxySetContainmentProof>;
}

declare const providerProxySetContainmentProofAuthorizationBrand: unique symbol;
declare const providerProxySetContainmentProofBrand: unique symbol;

/** An exact-set authorization that only the containment prover may turn into process evidence. */
export type ProviderProxySetContainmentProofAuthorization = Readonly<{
  [providerProxySetContainmentProofAuthorizationBrand]: true;
}>;

/** Opaque store and process evidence bound to one complete provider-proxy set identity. */
export type ProviderProxySetContainmentProof = Readonly<{
  [providerProxySetContainmentProofBrand]: true;
}>;

type ContainmentProofRecord = Readonly<{
  authorization: ProviderProxySetContainmentProofAuthorization;
  identity: ProviderProxySetIdentity;
  evidence: ProviderProxySetContainmentEvidence;
}>;

const authorizedIdentities = new WeakMap<ProviderProxySetContainmentProofAuthorization, ProviderProxySetIdentity>();
const containmentProofRecords = new WeakMap<ProviderProxySetContainmentProof, ContainmentProofRecord>();

/** Reads an opaque proof for policy classification without granting signal authority. */
export function inspectProviderProxySetContainmentProof(
  value: unknown,
): Readonly<{ identity: ProviderProxySetIdentity; evidence: ProviderProxySetContainmentEvidence }> | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = containmentProofRecords.get(value as ProviderProxySetContainmentProof);
  return record === undefined ? null : { identity: record.identity, evidence: record.evidence };
}

/** Mints the only input from which the prover may derive an exact-set proof. */
export function authorizeProviderProxySetContainmentProof(
  identity: ProviderProxySetIdentity,
): ProviderProxySetContainmentProofAuthorization {
  const authorization = Object.freeze({}) as ProviderProxySetContainmentProofAuthorization;
  authorizedIdentities.set(authorization, Object.freeze(providerProxySetIdentitySchema.parse(identity)));
  return authorization;
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
  const hidesARootOfThisSet = attributeUnreadableProviderOperations(db, operationScan.unreadableKeys).some(
    ({ sets }) =>
      sets.kind === 'indeterminate' ||
      sets.values.some(
        (address) => address.proxyInstanceId === identity.proxyInstanceId && address.buildSetId === identity.buildSetId,
      ),
  );
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
  const recordedRoots = [...roots.values()];
  const containment = {
    pid: identity.proxyPid,
    incarnation: identity.proxyIncarnation,
    processGroupId: identity.proxyProcessGroupId,
  };
  signal.throwIfAborted();
  return providerProxySetContainmentEvidenceSchema.parse({ kind: 'reap-required', containment, recordedRoots });
}

/** Collects read-only evidence and seals it only for a minted exact-set authorization. */
export function createProviderProxySetContainmentProver(runtime: Runtime): ProviderProxySetContainmentProver {
  return {
    async collectContainmentProof(authorization, db, signal) {
      const identity = authorizedIdentities.get(authorization);
      if (identity === undefined) throw new Error('provider_proxy_set_containment_proof_authorization_invalid');
      const proof = Object.freeze({}) as ProviderProxySetContainmentProof;
      containmentProofRecords.set(proof, {
        authorization,
        identity,
        evidence: await collectProviderProxySetContainmentEvidence(identity, db, runtime, signal),
      });
      return proof;
    },
  };
}
