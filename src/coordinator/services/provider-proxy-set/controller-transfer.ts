import { dirname } from 'node:path';

import { z } from 'zod';

import {
  currentHandoffCapsulePath,
  handoffCapsuleControllerBuildSetId,
  readHandoffCapsuleFile,
  type RedeemableHandoffCapsule,
} from '../../../provider-proxy/handoff-capsule.js';
import {
  canonicalUuidSchema,
  hostFingerprintSchema,
  operationIdentitySchema,
  type OperationIdentity,
} from '../../../provider-proxy/protocol.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { Database } from '../../../store/db.js';
import { readProviderOperation } from '../../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import type { ProviderProxySetIdentity } from './identity.js';

/** The contract generation of the `provider-operations` succession owner. */
export const PROVIDER_OPERATIONS_TRANSFER_GENERATION = 1;

/** A saga phase whose execution already runs in the host and whose next step belongs to whoever controls it. */
const TRANSFERABLE_OPERATION_PHASES = new Set<ProviderOperationRecord['phase']>(['executing', 'settlement-pending']);

export function providerOperationPhaseTransfers(phase: ProviderOperationRecord['phase']): boolean {
  return TRANSFERABLE_OPERATION_PHASES.has(phase);
}

const transferredSetSchema = z
  .object({
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    proxyInstanceId: canonicalUuidSchema,
    guardianInstanceId: canonicalUuidSchema,
    reaperInstanceId: canonicalUuidSchema,
    recoveryGrantId: canonicalUuidSchema,
  })
  .passthrough();

export type TransferredProviderProxySet = z.infer<typeof transferredSetSchema>;

/**
 * The `provider-proxy-sets` receipt payload. Each set names the recovery grant its host holds for the
 * attempt; the secret stays in the set's capsule, which only this user's coordinators can read.
 */
const providerProxyControllerTransferSchema = z
  .object({
    version: z.literal(1),
    controlGeneration: z.number().int().positive(),
    incumbentBuildSetId: canonicalUuidSchema,
    successorBuildSetId: canonicalUuidSchema,
    sets: z.array(transferredSetSchema),
  })
  .passthrough();

export type ProviderProxyControllerTransfer = z.infer<typeof providerProxyControllerTransferSchema>;

/** The `provider-operations` receipt payload: the saga rows whose control travels with their sets. */
const providerOperationTransferSchema = z
  .object({
    version: z.literal(1),
    operations: z.array(
      z.object({ operation: operationIdentitySchema, hostFingerprint: hostFingerprintSchema }).passthrough(),
    ),
  })
  .passthrough();

export type ProviderOperationTransfer = z.infer<typeof providerOperationTransferSchema>;

export function encodeProviderProxyControllerTransfer(
  transfer: ProviderProxyControllerTransfer,
): ProviderProxyControllerTransfer {
  return providerProxyControllerTransferSchema.parse(transfer);
}

export function decodeProviderProxyControllerTransfer(payload: unknown): ProviderProxyControllerTransfer | null {
  const parsed = providerProxyControllerTransferSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function encodeProviderOperationTransfer(transfer: ProviderOperationTransfer): ProviderOperationTransfer {
  return providerOperationTransferSchema.parse(transfer);
}

export function decodeProviderOperationTransfer(payload: unknown): ProviderOperationTransfer | null {
  const parsed = providerOperationTransferSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function transferredSetOf(
  identity: Pick<
    ProviderProxySetIdentity,
    'buildSetId' | 'hostFingerprint' | 'proxyInstanceId' | 'guardianInstanceId' | 'reaperInstanceId'
  >,
  recoveryGrantId: string,
): TransferredProviderProxySet {
  return {
    buildSetId: identity.buildSetId,
    hostFingerprint: identity.hostFingerprint,
    proxyInstanceId: identity.proxyInstanceId,
    guardianInstanceId: identity.guardianInstanceId,
    reaperInstanceId: identity.reaperInstanceId,
    recoveryGrantId,
  };
}

/** One id for the whole receipt, recomputable from its sets, so a verifier needs nothing the receipt omits. */
export function controllerTransferRecoveryGrantId(
  sets: readonly TransferredProviderProxySet[],
  sha256: (value: string) => string,
): string {
  const members = sets
    .map((set) => `${set.buildSetId}/${set.hostFingerprint}/${set.proxyInstanceId}:${set.recoveryGrantId}`)
    .sort();
  return `provider-proxy-sets:${sha256(JSON.stringify(members))}`;
}

function capsuleNamesTransferredSet(capsule: RedeemableHandoffCapsule, set: TransferredProviderProxySet): boolean {
  return (
    capsule.buildSetId === set.buildSetId &&
    capsule.hostFingerprint === set.hostFingerprint &&
    capsule.proxyInstanceId === set.proxyInstanceId &&
    capsule.guardianInstanceId === set.guardianInstanceId &&
    capsule.reaperInstanceId === set.reaperInstanceId &&
    capsule.grantId === set.recoveryGrantId
  );
}

/**
 * Whether `transfer` hands the set this capsule describes to `ownBuildSetId`. The capsule must still name the
 * incumbent as controller and hold the very grant the host authorized the transfer on: a capsule a later
 * controller rewrote is that controller's, and nothing the old receipt says can hand it on again.
 */
export function controllerTransferHandsCapsuleTo(
  transfer: ProviderProxyControllerTransfer,
  capsule: RedeemableHandoffCapsule,
  ownBuildSetId: string,
): boolean {
  return (
    transfer.successorBuildSetId === ownBuildSetId &&
    handoffCapsuleControllerBuildSetId(capsule) === transfer.incumbentBuildSetId &&
    transfer.sets.some((set) => capsuleNamesTransferredSet(capsule, set))
  );
}

/**
 * Reads the capsule of every transferred set and requires it to hold the recorded recovery grant under an
 * accepted controller build. Before the successor serves only the incumbent's build is accepted: that is the
 * grant a failed attempt's recovery redeems, so without it the transfer has no exit back. Once the successor
 * serves, its own build may already have taken the grant over.
 */
export function controllerTransferRecoveryGrantsVerify(
  runtime: Pick<Runtime, 'storage' | 'ids' | 'paths'>,
  flavor: 'prod' | 'dev',
  transfer: ProviderProxyControllerTransfer,
  recoveryGrantId: string,
  successorServes: boolean,
): boolean {
  const acceptedControllers = successorServes
    ? [transfer.incumbentBuildSetId, transfer.successorBuildSetId]
    : [transfer.incumbentBuildSetId];
  if (controllerTransferRecoveryGrantId(transfer.sets, (value) => runtime.ids.sha256(value)) !== recoveryGrantId) {
    return false;
  }
  return transfer.sets.every((set) => {
    let capsule;
    try {
      capsule = readHandoffCapsuleFile(
        currentHandoffCapsulePath(
          {
            generation: 'gen2',
            flavor,
            buildSetId: set.buildSetId,
            hostFingerprint: set.hostFingerprint,
            proxyInstanceId: set.proxyInstanceId,
          },
          { baseDir: dirname(runtime.paths.coral.generation.root) },
        ),
        { storage: runtime.storage, uid: process.getuid?.() ?? 0 },
      );
    } catch {
      return false;
    }
    return (
      capsule !== null &&
      (capsule.version === 3 || capsule.version === 4) &&
      acceptedControllers.includes(handoffCapsuleControllerBuildSetId(capsule)) &&
      capsuleNamesTransferredSet(capsule, set)
    );
  });
}

/**
 * The jobs a `provider-operations` receipt hands over, each still a transferable saga row on a set the
 * matching `provider-proxy-sets` receipt names. Before the successor serves nothing may have moved — the
 * incumbent's writers are parked — so a row that disappeared or moved on means the receipt no longer describes
 * the custody it hands over, and the answer is null. Once the successor serves, its own settlement may have
 * retired a row, and that job is no longer the receipt's to hand over.
 */
export function verifyProviderOperationTransfer(
  db: Database,
  operations: ProviderOperationTransfer,
  sets: ProviderProxyControllerTransfer,
  successorServes: boolean,
): readonly string[] | null {
  const jobIds: string[] = [];
  for (const entry of operations.operations) {
    const record = readProviderOperation(db, entry.operation);
    if (successorServes && (record === null || !providerOperationPhaseTransfers(record.phase))) continue;
    if (
      record === null ||
      !providerOperationPhaseTransfers(record.phase) ||
      record.locator.hostFingerprint !== entry.hostFingerprint ||
      !sets.sets.some(
        (set) =>
          set.proxyInstanceId === entry.operation.proxyInstanceId &&
          set.buildSetId === entry.operation.buildSetId &&
          set.hostFingerprint === entry.hostFingerprint,
      )
    ) {
      return null;
    }
    jobIds.push(entry.operation.jobId);
  }
  return jobIds;
}

export function transferredOperation(
  operation: OperationIdentity,
  hostFingerprint: string,
): ProviderOperationTransfer['operations'][number] {
  return { operation, hostFingerprint };
}
