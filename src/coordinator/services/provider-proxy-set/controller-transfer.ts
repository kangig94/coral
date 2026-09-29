import { dirname } from 'node:path';

import { z } from 'zod';

import {
  handoffCapsuleControllerBuildSetId,
  type RedeemableHandoffCapsule,
} from '../../../provider-proxy/handoff-capsule.js';
import { readAddressedHandoffCapsule } from '../../../provider-proxy/handoff-capsule-discovery.js';
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

export const PROVIDER_OPERATIONS_TRANSFER_GENERATION = 1;

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

/** The recovery grant secret must stay in the set capsule, readable only by this user’s coordinators. */
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

/** A verifier must be able to recompute the receipt id from its sets alone. */
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

/** The capsule must still name the incumbent controller and hold the grant the host authorized for this transfer. */
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
 * Before serving, only the incumbent build’s grant is accepted so a failed attempt remains recoverable. After
 * serving, the successor may have taken the grant over.
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
      capsule =
        readAddressedHandoffCapsule(
          {
            generation: 'gen2',
            flavor,
            buildSetId: set.buildSetId,
            hostFingerprint: set.hostFingerprint,
            proxyInstanceId: set.proxyInstanceId,
          },
          { baseDir: dirname(runtime.paths.coral.generation.root) },
          { storage: runtime.storage, uid: process.getuid?.() ?? 0 },
        )?.capsule ?? null;
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
 * Before serving, a missing or moved saga row invalidates the receipt; after serving, the successor may have
 * retired it.
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
