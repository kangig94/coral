import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  canonicalEndpointSchema,
  canonicalUuidSchema,
  flavorSchema,
  generationSchema,
  hostFingerprintSchema,
  proxyHandoffOperationSchema,
} from './protocol.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '../infra/process-constants.js';

/** Read cap applied before parsing, so an oversize file is refused without being decoded. */
export const MAX_HANDOFF_CAPSULE_BYTES = 64 * 1024;
/** Discovery fails closed on the candidate after this many, rather than truncating the set silently. */
export const MAX_HANDOFF_CAPSULES_PER_STARTUP = 128;

const grantSecretSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'grant secrets are 32 random bytes as 64 lowercase hexadecimal characters');

/**
 * The successor half of one grant. It names the exact set it may rotate and the complete byte-sorted
 * operation set, so a capsule cannot be redeemed against a set it was not issued for.
 */
export const handoffCapsuleSchema = z
  .object({
    version: z.literal(1),
    grantId: canonicalUuidSchema,
    secret: grantSecretSchema,
    generation: generationSchema,
    flavor: flavorSchema,
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    guardianInstanceId: canonicalUuidSchema,
    reaperInstanceId: canonicalUuidSchema,
    proxyInstanceId: canonicalUuidSchema,
    guardianControlEndpoint: canonicalEndpointSchema,
    reaperControlEndpoint: canonicalEndpointSchema,
    proxyEndpoint: canonicalEndpointSchema,
    operations: z.array(proxyHandoffOperationSchema).max(MAX_PROXY_OPERATION_LEDGERS),
    orphanTimeoutMs: z.number().int().positive(),
    teardownReserveMs: z.number().int().positive(),
  })
  .strict()
  .superRefine((capsule, context) => {
    const ordered = [...capsule.operations].every(
      (operation, index) =>
        index === 0 || capsule.operations[index - 1].operation.operationId < operation.operation.operationId,
    );
    if (!ordered) {
      // Byte order is what makes the set comparable across the three authorities; an unsorted or duplicated
      // set would let two capsules disagree about the same proxy without either looking malformed.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'operations must be byte-sorted and unique',
      });
    }
  });

export type HandoffCapsule = z.infer<typeof handoffCapsuleSchema>;

/** What the three authorities retain. The secret itself is never stored beside the digest. */
export type InstalledGrant = Readonly<{
  grantId: string;
  secretSha256: string;
  proxyInstanceId: string;
  operationIds: readonly string[];
  orphanTimeoutMs: number;
  teardownReserveMs: number;
}>;

export type HandoffCapsuleErrorCode =
  | 'handoff_capsule_too_large'
  | 'handoff_capsule_invalid'
  | 'grant_invalid'
  | 'grant_replayed'
  | 'grant_set_mismatch';

export class HandoffCapsuleError extends Error {
  readonly code: HandoffCapsuleErrorCode;

  constructor(code: HandoffCapsuleErrorCode, message: string) {
    super(message);
    this.name = 'HandoffCapsuleError';
    this.code = code;
    Object.setPrototypeOf(this, HandoffCapsuleError.prototype);
  }
}

export function handoffSecretDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Decodes one capsule's bytes. The size cap is applied first so an oversize file is never parsed. */
export function decodeHandoffCapsule(bytes: Uint8Array): HandoffCapsule {
  if (bytes.byteLength > MAX_HANDOFF_CAPSULE_BYTES) {
    throw new HandoffCapsuleError(
      'handoff_capsule_too_large',
      `Handoff capsule exceeded ${MAX_HANDOFF_CAPSULE_BYTES} bytes (observed ${bytes.byteLength}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HandoffCapsuleError('handoff_capsule_invalid', 'Handoff capsule is not valid strict UTF-8 JSON.');
  }
  const result = handoffCapsuleSchema.safeParse(parsed);
  if (!result.success) {
    throw new HandoffCapsuleError('handoff_capsule_invalid', 'Handoff capsule failed strict validation.');
  }
  return result.data;
}

/** The installed half, derived so an installer never has to hold the secret to record the grant. */
export function installedGrantFromCapsule(capsule: HandoffCapsule): InstalledGrant {
  return Object.freeze({
    grantId: capsule.grantId,
    secretSha256: handoffSecretDigest(capsule.secret),
    proxyInstanceId: capsule.proxyInstanceId,
    operationIds: Object.freeze(capsule.operations.map((entry) => entry.operation.operationId)),
    orphanTimeoutMs: capsule.orphanTimeoutMs,
    teardownReserveMs: capsule.teardownReserveMs,
  });
}

function digestsMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * One set-wide grant, consumed by the first redemption that presents the matching secret and the identical
 * operation set. Install is idempotent only for the exact same value: re-installing a different digest or a
 * different set under the same id is a conflict, not an update.
 */
export interface GrantRegistry {
  install(grant: InstalledGrant): { state: 'installed-dormant'; grantId: string };
  redeem(input: { grantId: string; secret: string; operationIds: readonly string[] }): InstalledGrant;
  installed(): InstalledGrant | null;
  redeemed(): boolean;
}

export function createGrantRegistry(): GrantRegistry {
  let installed: InstalledGrant | null = null;
  let consumed = false;

  const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  return {
    install(grant): { state: 'installed-dormant'; grantId: string } {
      if (installed !== null) {
        if (
          installed.grantId !== grant.grantId ||
          !digestsMatch(installed.secretSha256, grant.secretSha256) ||
          !sameSet(installed.operationIds, grant.operationIds)
        ) {
          throw new HandoffCapsuleError('grant_invalid', 'A different grant is already installed for this set.');
        }
        return { state: 'installed-dormant', grantId: installed.grantId };
      }
      installed = grant;
      return { state: 'installed-dormant', grantId: grant.grantId };
    },

    redeem({ grantId, secret, operationIds }): InstalledGrant {
      if (installed === null) throw new HandoffCapsuleError('grant_invalid', 'No grant is installed for this set.');
      if (consumed) throw new HandoffCapsuleError('grant_replayed', 'This grant was already redeemed.');
      if (installed.grantId !== grantId || !digestsMatch(installed.secretSha256, handoffSecretDigest(secret))) {
        throw new HandoffCapsuleError('grant_invalid', 'Redemption did not present the installed grant.');
      }
      if (!sameSet(installed.operationIds, operationIds)) {
        throw new HandoffCapsuleError('grant_set_mismatch', 'Redemption named a different operation set.');
      }
      consumed = true;
      return installed;
    },

    installed(): InstalledGrant | null {
      return installed;
    },

    redeemed(): boolean {
      return consumed;
    },
  };
}
