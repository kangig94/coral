import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

import { readBoundedFileAtIdentity } from '../infra/bounded-file-read.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import {
  PERMISSION_BITS_MASK,
  ProxyControlProtocolError,
  canonicalEndpointSchema,
  canonicalUuidSchema,
  coordinatorIdentitySchema,
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
 * `guardian.handoff-install.v1` and `reaper.handoff-install.v1`'s shared request: the guardian and reaper
 * are paired peers of the same set, so a coordinator installs the identical grant on both by the identical
 * message. Deliberately not `proxy.ts`'s own `handoff.install.v1` schema, which carries no `successor` or
 * `teardownReserveMs` field and identifies the set through `grantSetShape` instead of a full
 * `CoordinatorIdentity` — the proxy learns of a handoff only through the two authorities that already hold
 * one, never directly, so its wire shape is a genuinely different message rather than a drifted copy of
 * this one.
 */
export const guardianReaperHandoffInstallParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    secretSha256: grantSecretDigestSchema,
    successor: coordinatorIdentitySchema,
    operations: handoffOperationSetSchema,
    orphanTimeoutMs: z.number().int().positive(),
    teardownReserveMs: z.number().int().positive(),
  })
  .strict();

/**
 * The three grant-bearing requests, here rather than in `protocol.ts` beside every other wire schema for one
 * mechanical reason: each needs a grant primitive this module owns, and this module imports `protocol.ts`, so
 * the obvious home would close a cycle `tests/invariants/production-import-graph.test.ts` fails on outright.
 * They are shared all the same — a coordinator has to name a shape to send it, and the alternative is what
 * these were: parsed on receipt against a declaration no sender could reach.
 */

/**
 * The set half of a grant tuple, repeated on the wire so a coordinator holding two proxies cannot install
 * one proxy's grant on the other by presenting the right secret alone.
 */
const proxyGrantSetShape = {
  generation: generationSchema,
  hostFingerprint: hostFingerprintSchema,
  buildSetId: canonicalUuidSchema,
  proxyInstanceId: canonicalUuidSchema,
} as const;

/** `handoff.install.v1`'s request — the proxy's own, and the last send in this protocol that was validated
 *  only on receipt. Distinct from the guardian/reaper message above, not a drifted copy of it. */
export const proxyHandoffInstallParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    secretSha256: grantSecretDigestSchema,
    ...proxyGrantSetShape,
    operations: handoffOperationSetSchema,
    orphanTimeoutMs: z.number().int().positive(),
  })
  .strict();

/** `handoff.redeem.v1`'s request. No `operations` field: the set is bound at install and returned by
 *  redemption, never presented by a redeemer to be checked against — see `GrantRegistry.redeem`'s own doc. */
export const proxyHandoffRedeemParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    secret: grantSecretSchema,
    successor: coordinatorIdentitySchema,
    ...proxyGrantSetShape,
  })
  .strict();

/** `guardian.handoff-redeem.v1`'s request. The guardian is the sole linearization point for the plaintext
 *  secret, and names no set: the capsule/locator agreement its caller already checked established which
 *  guardian this is. */
export const guardianHandoffRedeemParamsSchema = z
  .object({
    grantId: canonicalUuidSchema,
    secret: grantSecretSchema,
    successor: coordinatorIdentitySchema,
  })
  .strict();

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
    (stat.mode & PERMISSION_BITS_MASK) !== BigInt(PRIVATE_HANDOFF_CAPSULE_MODE)
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
 * `decodeHandoffCapsule`, and re-verifying that same identity — device, inode, mode, owning uid, size, and
 * mtime — after the read completes: `readBoundedFileAtIdentity` (`infra/bounded-file-read.ts`) is the one
 * lstat-open-fstat-bounded-read-restat primitive `bootstrap-capsule.ts`'s own capsule reader calls too, not a
 * parallel copy of it, because a capsule swapped for another mid-read would otherwise be decoded as if it
 * were still the one just proven private. Returns `null` for an absent path — the ordinary case once the
 * recorded set's own enforcers have unlinked it after confirmed absence — rather than forcing every caller to
 * special-case `ENOENT`.
 */
export function readHandoffCapsuleFile(path: string, env: HandoffCapsuleFileEnvironment): HandoffCapsule | null {
  assertCanonicalHandoffCapsulePath(path);
  let baseline: StorageBigIntStat;
  try {
    baseline = assertPrivateHandoffCapsuleFile(path, env);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (baseline.size < 0n || baseline.size > BigInt(MAX_HANDOFF_CAPSULE_BYTES)) {
    throw new HandoffCapsuleError(
      'handoff_capsule_too_large',
      `Handoff capsule exceeded ${MAX_HANDOFF_CAPSULE_BYTES} bytes (observed ${baseline.size}).`,
    );
  }

  const bytes = readBoundedFileAtIdentity(env.storage, path, baseline, MAX_HANDOFF_CAPSULE_BYTES);
  if (bytes === null) {
    throw new HandoffCapsuleError('handoff_capsule_unreadable', 'Handoff capsule changed while it was opened or read.');
  }
  return decodeHandoffCapsule(bytes);
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
 * The set identity a grant is bound to, read from any role's own bootstrap capsule — every role's capsule
 * shares this exact field shape (`bootstrap-capsule.ts`'s `commonBootstrapCapsuleShape`), so a coordinator
 * can never install or redeem a grant for a set it does not belong to. Freezing a fresh 7-field object,
 * rather than freezing the capsule itself, is what keeps a grant's binding from also freezing (or leaking
 * into log output alongside) the capsule's own secrets and endpoints.
 */
export function grantBindingFromCapsule(capsule: GrantBinding): GrantBinding {
  return Object.freeze({
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    proxyInstanceId: capsule.proxyInstanceId,
  });
}

/** Order-sensitive on purpose: both sides of every comparison this guards were sorted the same way at their
 *  own ingress (`handoffOperationSetSchema`), so a position-by-position walk is equality, not just
 *  membership — used for `install`'s own idempotency and for a reaper's own `reaper.record-redemption.v1`
 *  repeat-forward idempotency, never for redemption itself (see `GrantRegistry.redeem`'s own doc for why). */
export function sameOperations(left: readonly OperationIdentity[], right: readonly OperationIdentity[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.jobId === right[index].jobId &&
        value.operationId === right[index].operationId &&
        value.proxyInstanceId === right[index].proxyInstanceId &&
        value.buildSetId === right[index].buildSetId,
    )
  );
}

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
        const identical =
          sameBinding(installed, grant) &&
          digestsMatch(installed.secretSha256, grant.secretSha256) &&
          sameOperations(installed.operations, grant.operations);
        if (identical) {
          return { state: 'installed-dormant', grantId: installed.grantId };
        }
        if (redemption === null) {
          throw new ProxyControlProtocolError('grant_invalid', 'A different grant is already installed for this set.');
        }
        // The installed grant was already consumed by the one successor `redeem` ever admits (single-use,
        // see its own doc), and `install` is reachable only under `authority: 'active'` at the endpoint — so
        // the only caller who can ever present a *different* grant here is that same successor's own
        // coordinator, now the set's legitimate active holder (no other party can hold active control: the
        // bootstrap nonce is spent and this grant is spent). A spent grant secures nothing further once
        // redeemed, so replacing it is what lets that coordinator bequeath the set again for its own future
        // handoff, instead of being permanently refused by a credential nobody needs any more. The stale
        // redemption record is cleared with it: it named the old grant's successor, and must not answer for
        // a grant that successor never redeemed.
        redemption = null;
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
