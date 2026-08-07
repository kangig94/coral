import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import {
  ProxyControlProtocolError,
  canonicalEndpointSchema,
  canonicalUuidSchema,
  flavorSchema,
  generationSchema,
  hostFingerprintSchema,
  operationIdentitySchema,
  type OperationIdentity,
} from './protocol.js';
import { MAX_PROXY_OPERATION_LEDGERS } from './ledger.js';

/** Read cap applied before parsing, so an oversize file is refused without being decoded. */
export const MAX_HANDOFF_CAPSULE_BYTES = 64 * 1024;

export const grantSecretSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'grant secrets are 32 random bytes as 64 lowercase hexadecimal characters');

/** The installed half never carries the secret itself, only its SHA-256. */
export const grantSecretDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'a grant secret digest is SHA-256 as 64 lowercase hexadecimal characters');

/**
 * One handoff operation set, on the wire wherever an install or a redemption forward names it:
 * `*.handoff-install.v1` on all three roles, and the guardian's own forward of a redemption to its paired
 * reaper. Byte order is what makes the set comparable — an unsorted or duplicated set is refused at every
 * ingress rather than made order-insensitive downstream: canonical values are established at the boundary,
 * not repaired past it.
 *
 * Deliberately absent from a *redemption request*: the set is established once, at install, and a redeemer
 * never presents it — see `InstalledGrant.operations` and `GrantRegistry.redeem`'s own doc for why checking
 * a redeemer-echoed copy against the installed one added nothing a redeemer could not already control.
 */
export const handoffOperationSetSchema = z
  .array(operationIdentitySchema)
  .max(MAX_PROXY_OPERATION_LEDGERS)
  .superRefine((operations, context) => {
    const ordered = operations.every(
      (operation, index) => index === 0 || operations[index - 1].operationId < operation.operationId,
    );
    if (!ordered) {
      // Byte order is what makes the set comparable across the three authorities; an unsorted or duplicated
      // set would let two capsules disagree about the same proxy without either looking malformed.
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'operations must be byte-sorted and unique' });
    }
  });

/**
 * The successor half of one grant: exactly what a redeemer needs to reach and authenticate against the set,
 * and nothing a durable authority already tracks on its own terms. Two facts are deliberately absent:
 *
 * - The operation set. It is installed once, directly on all three roles, and a redeemer never needs to name
 *   it in advance — `GrantRedemption` hands it back at redemption instead (`InstalledGrant.operations`).
 *   Carrying it here too would make this file a second, staler copy of a fact the roles already hold.
 * - `committedThroughProviderSeq`. The store's own copy of that watermark advances transactionally, inside
 *   the same commit as the effect it accompanies (`coordinator/services/provider-event-application.ts`), and
 *   is the only durable one. A capsule field of the same name would instead be the proxy ledger's *belief*
 *   about that watermark, frozen at whatever instant this capsule happened to be written — which can lag or
 *   lead the store's real commit by however long a `provider.event.v1` round trip was still in flight at that
 *   instant. A successor resumes from the store's own watermark plus one; it must never resume from a number
 *   this file could hand it instead.
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
    orphanTimeoutMs: z.number().int().positive(),
    teardownReserveMs: z.number().int().positive(),
  })
  .strict();

export type HandoffCapsule = z.infer<typeof handoffCapsuleSchema>;

/**
 * What the three authorities retain. The secret itself is never stored beside the digest, and the identity
 * tuple is what a grant is bound to: a capsule replayed from another build set or another proxy cannot be
 * redeemed here just because its secret happens to match (`GrantBinding`, checked by `redeem` below).
 *
 * `operations` is retained but not bound: it is recorded once at `install` and handed back verbatim by
 * `redeem` (see `GrantRedemption`), never re-checked against anything a caller later presents. Binding
 * redemption to it added nothing a redeemer could not already control — a redeemer that only ever echoes
 * back what it was told is being checked against itself, not against an independent fact — while the
 * identity tuple, `secretSha256`, and each role's own instance id are facts the redeemer cannot forge.
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
  operations: readonly OperationIdentity[];
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
export type HandoffCapsuleErrorCode =
  | 'handoff_capsule_too_large'
  | 'handoff_capsule_invalid'
  | 'handoff_capsule_non_canonical_path'
  | 'handoff_capsule_not_private'
  | 'handoff_capsule_write_failed'
  | 'handoff_capsule_unreadable';

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

const PRIVATE_HANDOFF_CAPSULE_MODE = 0o600;
const PERMISSION_BITS = 0o777n;

type HandoffCapsuleFileStorage = Pick<
  StoragePort,
  'closeSync' | 'fstatSync' | 'lstatSync' | 'openSync' | 'readSync' | 'statSync' | 'writeAtomicDurableSync'
>;

export type HandoffCapsuleFileEnvironment = Readonly<{
  storage: HandoffCapsuleFileStorage;
  uid: number;
}>;

function assertCanonicalHandoffCapsulePath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new HandoffCapsuleError(
      'handoff_capsule_non_canonical_path',
      'Handoff capsule path must be absolute and normalized.',
    );
  }
}

function assertPrivateHandoffCapsuleFile(path: string, env: HandoffCapsuleFileEnvironment): StorageBigIntStat {
  if (!Number.isSafeInteger(env.uid) || env.uid < 0) {
    throw new HandoffCapsuleError('handoff_capsule_not_private', 'Handoff capsule owner uid is unavailable.');
  }
  const link = env.storage.lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new HandoffCapsuleError(
      'handoff_capsule_non_canonical_path',
      'Handoff capsule must be a regular file, not a symlink.',
    );
  }
  const stat = env.storage.statSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid === undefined ||
    stat.uid !== BigInt(env.uid) ||
    (stat.mode & PERMISSION_BITS) !== BigInt(PRIVATE_HANDOFF_CAPSULE_MODE)
  ) {
    throw new HandoffCapsuleError(
      'handoff_capsule_not_private',
      'Handoff capsule must be a current-uid mode-0600 regular file.',
    );
  }
  return stat;
}

/**
 * Writes the successor half of a grant durably: one strict mode-0600, at-most-64-KiB capsule per proxy,
 * atomically renamed into place and fsynced (`StoragePort.writeAtomicDurableSync`) — the same durable-publish
 * primitive `kb/ops/promote-marker.ts` uses. A grant with no durable capsule is unredeemable no matter how
 * many authorities acknowledge it, so this is the one write in the install sequence that must survive a
 * `SIGKILL` landing the instant after it returns.
 */
export function writeHandoffCapsuleFile(
  path: string,
  capsule: HandoffCapsule,
  env: HandoffCapsuleFileEnvironment,
): void {
  assertCanonicalHandoffCapsulePath(path);
  const parsed = handoffCapsuleSchema.parse(capsule);
  const encoded = JSON.stringify(parsed);
  const encodedBytes = Buffer.byteLength(encoded, 'utf8');
  if (encodedBytes > MAX_HANDOFF_CAPSULE_BYTES) {
    throw new HandoffCapsuleError(
      'handoff_capsule_too_large',
      `Handoff capsule exceeded ${MAX_HANDOFF_CAPSULE_BYTES} bytes (encoded ${encodedBytes}).`,
    );
  }
  const durable = env.storage.writeAtomicDurableSync(path, encoded, {
    encoding: 'utf-8',
    mode: PRIVATE_HANDOFF_CAPSULE_MODE,
  });
  if (!durable) {
    throw new HandoffCapsuleError(
      'handoff_capsule_write_failed',
      'Handoff capsule could not be written durably (its parent directory disappeared).',
    );
  }
  // Written, not merely believed written: a mode or ownership drift here means a later reader would trust
  // bytes this process cannot itself verify came from this write, so it is caught at the write site instead.
  assertPrivateHandoffCapsuleFile(path, env);
}

/**
 * Reads one capsule file, verifying it is a private, size-bounded regular file before any byte crosses into
 * `decodeHandoffCapsule`. Returns `null` for an absent path — the ordinary case once the recorded set's own
 * enforcers have unlinked it after confirmed absence — rather than forcing every caller to special-case
 * `ENOENT`.
 */
export function readHandoffCapsuleFile(path: string, env: HandoffCapsuleFileEnvironment): HandoffCapsule | null {
  assertCanonicalHandoffCapsulePath(path);
  let stat: StorageBigIntStat;
  try {
    stat = assertPrivateHandoffCapsuleFile(path, env);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (stat.size < 0n || stat.size > BigInt(MAX_HANDOFF_CAPSULE_BYTES)) {
    throw new HandoffCapsuleError(
      'handoff_capsule_too_large',
      `Handoff capsule exceeded ${MAX_HANDOFF_CAPSULE_BYTES} bytes (observed ${stat.size}).`,
    );
  }

  let descriptor: number | null = null;
  try {
    descriptor = env.storage.openSync(path, 'r');
    const opened = env.storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.size !== stat.size) {
      throw new HandoffCapsuleError('handoff_capsule_unreadable', 'Handoff capsule changed while it was opened.');
    }
    const bytes = Buffer.allocUnsafe(MAX_HANDOFF_CAPSULE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = env.storage.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_HANDOFF_CAPSULE_BYTES) {
      throw new HandoffCapsuleError(
        'handoff_capsule_too_large',
        `Handoff capsule exceeded ${MAX_HANDOFF_CAPSULE_BYTES} bytes (observed ${offset}).`,
      );
    }
    return decodeHandoffCapsule(bytes.subarray(0, offset));
  } catch (error: unknown) {
    if (error instanceof HandoffCapsuleError) throw error;
    throw new HandoffCapsuleError('handoff_capsule_unreadable', 'Handoff capsule could not be read safely.');
  } finally {
    if (descriptor !== null) {
      try {
        env.storage.closeSync(descriptor);
      } catch {
        // Best effort: the read result above already determined success or failure.
      }
    }
  }
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
 * One set-wide grant, consumed by the first redemption that presents the matching secret and identity tuple.
 * Install is idempotent only for the exact same value: re-installing a different digest or a different
 * operation set under the same id is a conflict, not an update.
 */
export interface GrantRegistry {
  install(grant: InstalledGrant): { state: 'installed-dormant'; grantId: string };
  /**
   * Consumes the grant for one successor. Single-use means one *successor*, not one call: a successor whose
   * reply was lost in transit retries with the identical grant and identity, and must get back what it
   * already earned — refusing it would hand the set to a teardown it had already prevented. The recorded
   * redemption is what tells "the same one, again" from "a different one", so retry-safety and
   * replay-refusal are the same comparison rather than two mechanisms.
   *
   * No `operations` parameter: the installed set is not part of what a redeemer proves it holds — a redeemer
   * would only ever be echoing back the exact value it read out of the capsule this same install produced,
   * which the installed copy already equals by construction. `GrantRedemption.grant.operations` hands the set
   * back on success instead, so a caller who genuinely needs it gets it from the one place it was ever
   * authoritative.
   */
  redeem(input: {
    grantId: string;
    secret: string;
    /** Who is redeeming. Recorded on the first success and required to match on every retry. */
    successorInstanceId: string;
    binding: GrantBinding;
  }): GrantRedemption;
  redemption(): GrantRedemption | null;
}

export function createGrantRegistry(mintReceipt: () => string): GrantRegistry {
  let installed: InstalledGrant | null = null;
  let redemption: GrantRedemption | null = null;

  /** Order-sensitive on purpose: both sides of every comparison this guards were sorted the same way at
   *  their own ingress (`handoffOperationSetSchema`), so a position-by-position walk is equality, not just
   *  membership — used only for `install`'s own idempotency, never for redemption (see `redeem`'s own doc). */
  const sameOperations = (left: readonly OperationIdentity[], right: readonly OperationIdentity[]): boolean =>
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.jobId === right[index].jobId &&
        value.operationId === right[index].operationId &&
        value.proxyInstanceId === right[index].proxyInstanceId &&
        value.buildSetId === right[index].buildSetId,
    );

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
          !sameOperations(installed.operations, grant.operations)
        ) {
          throw new ProxyControlProtocolError('grant_invalid', 'A different grant is already installed for this set.');
        }
        return { state: 'installed-dormant', grantId: installed.grantId };
      }
      installed = grant;
      return { state: 'installed-dormant', grantId: grant.grantId };
    },

    redeem({ grantId, secret, successorInstanceId, binding }): GrantRedemption {
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

    redemption(): GrantRedemption | null {
      return redemption;
    },
  };
}
