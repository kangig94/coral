import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  ProxyControlProtocolError,
  canonicalEndpointSchema,
  canonicalUuidSchema,
  flavorSchema,
  generationSchema,
  hostFingerprintSchema,
  proxyHandoffOperationSchema,
} from './protocol.js';
import { MAX_PROXY_OPERATION_LEDGERS } from './ledger.js';

/** Read cap applied before parsing, so an oversize file is refused without being decoded. */
export const MAX_HANDOFF_CAPSULE_BYTES = 64 * 1024;
/** Discovery fails closed on the candidate after this many, rather than truncating the set silently. */
export const MAX_HANDOFF_CAPSULES_PER_STARTUP = 128;

export const grantSecretSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'grant secrets are 32 random bytes as 64 lowercase hexadecimal characters');

/** The installed half never carries the secret itself, only its SHA-256. */
export const grantSecretDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'a grant secret digest is SHA-256 as 64 lowercase hexadecimal characters');

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

/**
 * What the three authorities retain. The secret itself is never stored beside the digest, and the whole
 * identity tuple is kept: a grant is bound to one exact set, so a capsule replayed from another build set
 * or another proxy cannot be redeemed here just because its secret and operation list happen to match.
 */
export type InstalledGrant = Readonly<{
  grantId: string;
  secretSha256: string;
  generation: string;
  flavor: string;
  buildSetId: string;
  hostFingerprint: string;
  guardianInstanceId: string;
  reaperInstanceId: string;
  proxyInstanceId: string;
  operationIds: readonly string[];
  /**
   * Part of what the grant is bound to, not decoration: a successor computes its attach budget from this,
   * so a grant installed under one orphan timeout must not be redeemable against a set running another.
   */
  orphanTimeoutMs: number;
}>;

/**
 * Only the decoding failures. A grant that is refused once it is *on* the wire — wrong secret, wrong set,
 * a second successor — refuses with the protocol's own `grant_invalid`/`grant_replayed`, so no layer has to
 * translate one vocabulary into the other on the way out.
 */
export type HandoffCapsuleErrorCode = 'handoff_capsule_too_large' | 'handoff_capsule_invalid';

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
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    proxyInstanceId: capsule.proxyInstanceId,
    operationIds: Object.freeze(capsule.operations.map((entry) => entry.operation.operationId)),
    orphanTimeoutMs: capsule.orphanTimeoutMs,
  });
}

function digestsMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** What one successful redemption produced. Returned again, unchanged, to that successor's exact retry. */
export type GrantRedemption = Readonly<{
  grant: InstalledGrant;
  redemptionReceipt: string;
  successorInstanceId: string;
}>;

/**
 * The set the redeemer believes it is rotating, compared against what was installed. The orphan timeout is
 * deliberately absent: a redeemer never names it, so it is checked where it *is* named — a second install
 * under the same id but a different timeout is a conflict, not an update.
 */
export type GrantBinding = Pick<
  InstalledGrant,
  | 'generation'
  | 'flavor'
  | 'buildSetId'
  | 'hostFingerprint'
  | 'guardianInstanceId'
  | 'reaperInstanceId'
  | 'proxyInstanceId'
>;

/**
 * One set-wide grant, consumed by the first redemption that presents the matching secret and the identical
 * operation set. Install is idempotent only for the exact same value: re-installing a different digest or a
 * different set under the same id is a conflict, not an update.
 */
export interface GrantRegistry {
  install(grant: InstalledGrant): { state: 'installed-dormant'; grantId: string };
  /**
   * Consumes the grant for one successor. Single-use means one *successor*, not one call: a successor whose
   * reply was lost in transit retries with the identical grant, secret, set and identity, and must get back
   * what it already earned — refusing it would hand the set to a teardown it had already prevented. The
   * recorded redemption is what tells "the same one, again" from "a different one", so retry-safety and
   * replay-refusal are the same comparison rather than two mechanisms.
   */
  redeem(input: {
    grantId: string;
    secret: string;
    /** Who is redeeming. Recorded on the first success and required to match on every retry. */
    successorInstanceId: string;
    operationIds: readonly string[];
    binding: GrantBinding;
  }): GrantRedemption;
  installed(): InstalledGrant | null;
  redemption(): GrantRedemption | null;
}

export function createGrantRegistry(mintReceipt: () => string): GrantRegistry {
  let installed: InstalledGrant | null = null;
  let redemption: GrantRedemption | null = null;

  const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  /** Every field a grant is bound to, including the timeout only an installer names. */
  const sameBinding = (left: InstalledGrant, right: InstalledGrant): boolean =>
    left.grantId === right.grantId &&
    left.generation === right.generation &&
    left.flavor === right.flavor &&
    left.buildSetId === right.buildSetId &&
    left.hostFingerprint === right.hostFingerprint &&
    left.guardianInstanceId === right.guardianInstanceId &&
    left.reaperInstanceId === right.reaperInstanceId &&
    left.proxyInstanceId === right.proxyInstanceId &&
    left.orphanTimeoutMs === right.orphanTimeoutMs;

  return {
    install(grant): { state: 'installed-dormant'; grantId: string } {
      if (installed !== null) {
        if (
          !sameBinding(installed, grant) ||
          !digestsMatch(installed.secretSha256, grant.secretSha256) ||
          !sameSet(installed.operationIds, grant.operationIds)
        ) {
          throw new ProxyControlProtocolError('grant_invalid', 'A different grant is already installed for this set.');
        }
        return { state: 'installed-dormant', grantId: installed.grantId };
      }
      installed = grant;
      return { state: 'installed-dormant', grantId: grant.grantId };
    },

    redeem({ grantId, secret, successorInstanceId, operationIds, binding }): GrantRedemption {
      if (installed === null)
        throw new ProxyControlProtocolError('grant_invalid', 'No grant is installed for this set.');
      if (installed.grantId !== grantId || !digestsMatch(installed.secretSha256, handoffSecretDigest(secret))) {
        throw new ProxyControlProtocolError('grant_invalid', 'Redemption did not present the installed grant.');
      }
      if (!sameBinding(installed, { ...installed, ...binding })) {
        // A capsule from another set is a replay of a grant that was never for this one.
        throw new ProxyControlProtocolError(
          'grant_replayed',
          'Redemption named a different guardian/reaper/proxy set.',
        );
      }
      if (!sameSet(installed.operationIds, operationIds)) {
        throw new ProxyControlProtocolError('grant_replayed', 'Redemption named a different operation set.');
      }
      if (redemption !== null) {
        if (redemption.successorInstanceId !== successorInstanceId) {
          throw new ProxyControlProtocolError(
            'grant_replayed',
            'This grant was already redeemed by another successor.',
          );
        }
        return redemption;
      }
      redemption = Object.freeze({ grant: installed, redemptionReceipt: mintReceipt(), successorInstanceId });
      return redemption;
    },

    installed(): InstalledGrant | null {
      return installed;
    },

    redemption(): GrantRedemption | null {
      return redemption;
    },
  };
}
