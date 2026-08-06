import { timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

import { resolveStrictBundleIdentity, type StrictBundleIdentityResult } from '../infra/bundle-manifest.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import {
  ProxyControlProtocolError,
  canonicalEndpointSchema,
  canonicalUuidSchema,
  flavorSchema,
  generationSchema,
  hostFingerprintSchema,
} from './protocol.js';

export const MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES = 4_096;

const PRIVATE_CAPSULE_MODE = 0o600n;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PERMISSION_BITS = 0o777n;
const SECRET_HEX_BYTES = 32;
const CLAIM_SUFFIX = '.consuming';

const bootstrapSecretSchema = z
  .string()
  .length(SECRET_HEX_BYTES * 2)
  .regex(/^[0-9a-f]{64}$/);

const commonBootstrapCapsuleShape = {
  generation: generationSchema,
  flavor: flavorSchema,
  buildSetId: canonicalUuidSchema,
  hostFingerprint: hostFingerprintSchema,
  guardianInstanceId: canonicalUuidSchema,
  reaperInstanceId: canonicalUuidSchema,
  proxyInstanceId: canonicalUuidSchema,
  bootstrapNonce: bootstrapSecretSchema,
} as const;

export const guardianBootstrapCapsuleSchema = z
  .object({
    role: z.literal('guardian'),
    ...commonBootstrapCapsuleShape,
    canonicalControlEndpoint: canonicalEndpointSchema,
    reaperControlEndpoint: canonicalEndpointSchema,
    proxyEndpoint: canonicalEndpointSchema,
    guardianReaperAuthSecret: bootstrapSecretSchema,
    proxyGuardianAuthSecret: bootstrapSecretSchema,
  })
  .strict();

export type GuardianBootstrapCapsule = z.infer<typeof guardianBootstrapCapsuleSchema>;

export const reaperBootstrapCapsuleSchema = z
  .object({
    role: z.literal('reaper'),
    ...commonBootstrapCapsuleShape,
    canonicalControlEndpoint: canonicalEndpointSchema,
    guardianControlEndpoint: canonicalEndpointSchema,
    proxyEndpoint: canonicalEndpointSchema,
    guardianReaperAuthSecret: bootstrapSecretSchema,
  })
  .strict();

export type ReaperBootstrapCapsule = z.infer<typeof reaperBootstrapCapsuleSchema>;

export const proxyBootstrapCapsuleSchema = z
  .object({
    role: z.literal('proxy'),
    ...commonBootstrapCapsuleShape,
    canonicalEndpoint: canonicalEndpointSchema,
    guardianControlEndpoint: canonicalEndpointSchema,
    proxyGuardianAuthSecret: bootstrapSecretSchema,
  })
  .strict();

export type ProxyBootstrapCapsule = z.infer<typeof proxyBootstrapCapsuleSchema>;

export const providerBootstrapCapsuleSchema = z.discriminatedUnion('role', [
  guardianBootstrapCapsuleSchema,
  reaperBootstrapCapsuleSchema,
  proxyBootstrapCapsuleSchema,
]);

export type ProviderBootstrapCapsule = z.infer<typeof providerBootstrapCapsuleSchema>;
export type ProviderBootstrapRole = ProviderBootstrapCapsule['role'];

/**
 * The one-use half of a bootstrap capsule, held by the role the capsule was issued to. Presenting it is how
 * a coordinator proves it is the one that started this process; the first acceptance spends it, so the nonce
 * authorizes exactly one control tenancy and a replay opens no second one. The spend lives here rather than
 * in the control endpoint because a credential's one-shot belongs to whoever owns the credential — the same
 * reason a handoff grant's one-shot lives in its registry.
 */
export interface BootstrapNonceCredential {
  /** Throws `unauthorized_control` unless `offered` is the unspent nonce; spends it on acceptance. */
  spend(offered: unknown): void;
}

export function createBootstrapNonceCredential(nonce: string): BootstrapNonceCredential {
  const expected = Buffer.from(nonce, 'utf8');
  let spent = false;
  return {
    spend(offered: unknown): void {
      if (spent) {
        throw new ProxyControlProtocolError('unauthorized_control', 'The bootstrap nonce was already spent.');
      }
      const presented = typeof offered === 'string' ? Buffer.from(offered, 'utf8') : Buffer.alloc(0);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new ProxyControlProtocolError(
          'unauthorized_control',
          'Control open did not present the bootstrap nonce.',
        );
      }
      spent = true;
    },
  };
}

type ProviderBootstrapCapsuleStorage = Pick<
  StoragePort,
  | 'closeSync'
  | 'fstatSync'
  | 'lstatSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readSync'
  | 'renameSync'
  | 'rmSync'
  | 'statSync'
  | 'writeFileSync'
>;

export type ProviderBootstrapCapsuleEnvironment = {
  readonly storage: ProviderBootstrapCapsuleStorage;
  readonly uid: number;
  readonly resolveStrictIdentity?: () => StrictBundleIdentityResult;
};

export type ProviderBootstrapCapsuleErrorCode =
  | 'bootstrap_capsule_already_exists'
  | 'bootstrap_capsule_build_flavor_mismatch'
  | 'bootstrap_capsule_build_set_mismatch'
  | 'bootstrap_capsule_create_failed'
  | 'bootstrap_capsule_invalid'
  | 'bootstrap_capsule_non_canonical_path'
  | 'bootstrap_capsule_not_private'
  | 'bootstrap_capsule_replayed'
  | 'bootstrap_capsule_role_mismatch'
  | 'bootstrap_capsule_scalar_too_long'
  | 'bootstrap_capsule_strict_identity_unavailable'
  | 'bootstrap_capsule_too_large'
  | 'bootstrap_capsule_unreadable';

export class ProviderBootstrapCapsuleError extends Error {
  readonly code: ProviderBootstrapCapsuleErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: ProviderBootstrapCapsuleErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ProviderBootstrapCapsuleError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, ProviderBootstrapCapsuleError.prototype);
  }
}

function assertCanonicalCapsulePath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_non_canonical_path',
      'Provider bootstrap capsule path must be absolute and normalized.',
      { path },
    );
  }
}

function schemaFailure(error: z.ZodError): ProviderBootstrapCapsuleError {
  if (error.issues.some((issue) => issue.code === z.ZodIssueCode.too_big)) {
    return new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_scalar_too_long',
      'Provider bootstrap capsule contains an overlength scalar.',
    );
  }
  if (error.issues.some((issue) => issue.message === 'endpoint must be an absolute canonical path')) {
    return new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_non_canonical_path',
      'Provider bootstrap capsule contains a non-canonical endpoint path.',
    );
  }
  return new ProviderBootstrapCapsuleError(
    'bootstrap_capsule_invalid',
    'Provider bootstrap capsule failed strict validation.',
  );
}

function parseCapsule(value: unknown): ProviderBootstrapCapsule {
  const parsed = providerBootstrapCapsuleSchema.safeParse(value);
  if (!parsed.success) throw schemaFailure(parsed.error);
  return parsed.data;
}

function encodeCapsule(capsule: ProviderBootstrapCapsule): string {
  const encoded = JSON.stringify(parseCapsule(capsule));
  const encodedBytes = Buffer.byteLength(encoded, 'utf8');
  if (encodedBytes > MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_too_large',
      `Provider bootstrap capsule exceeds ${MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES} bytes.`,
      { observedBytes: encodedBytes, limit: MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES },
    );
  }
  return encoded;
}

function privateFileError(path: string, uid: number): ProviderBootstrapCapsuleError {
  return new ProviderBootstrapCapsuleError(
    'bootstrap_capsule_not_private',
    `Provider bootstrap capsule must be a current-uid mode-0600 regular file.`,
    { path, expectedUid: uid, expectedMode: '0600' },
  );
}

function assertPrivateFile(path: string, uid: number, storage: ProviderBootstrapCapsuleStorage): StorageBigIntStat {
  if (!Number.isSafeInteger(uid) || uid < 0) throw privateFileError(path, uid);

  const link = storage.lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_non_canonical_path',
      'Provider bootstrap capsule must be a regular file, not a symlink.',
      { path },
    );
  }

  const stat = storage.statSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid === undefined ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & PERMISSION_BITS) !== PRIVATE_CAPSULE_MODE
  ) {
    throw privateFileError(path, uid);
  }
  return stat;
}

function sameFile(left: StorageBigIntStat, right: StorageBigIntStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function readClaimedCapsule(path: string, env: ProviderBootstrapCapsuleEnvironment): string {
  let descriptor: number | null = null;
  try {
    const pathBefore = assertPrivateFile(path, env.uid, env.storage);
    if (pathBefore.size < 0n || pathBefore.size > BigInt(MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES)) {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_too_large',
        `Provider bootstrap capsule exceeds ${MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES} bytes.`,
        { observedBytes: pathBefore.size.toString(), limit: MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES },
      );
    }

    descriptor = env.storage.openSync(path, 'r');
    const opened = env.storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFile(pathBefore, opened)) {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_unreadable',
        'Provider bootstrap capsule changed while it was being opened.',
        { path },
      );
    }

    const bytes = Buffer.allocUnsafe(MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = env.storage.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES) {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_too_large',
        `Provider bootstrap capsule exceeds ${MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES} bytes.`,
        { observedBytes: offset, limit: MAX_PROVIDER_BOOTSTRAP_CAPSULE_BYTES },
      );
    }

    const openedAfter = env.storage.fstatSync(descriptor, { bigint: true });
    const pathAfter = assertPrivateFile(path, env.uid, env.storage);
    if (!sameFile(opened, openedAfter) || !sameFile(opened, pathAfter) || openedAfter.size !== BigInt(offset)) {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_unreadable',
        'Provider bootstrap capsule changed while it was being read.',
        { path },
      );
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_invalid',
        'Provider bootstrap capsule is not valid UTF-8.',
      );
    }
  } catch (error: unknown) {
    if (error instanceof ProviderBootstrapCapsuleError) throw error;
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_unreadable',
      'Provider bootstrap capsule could not be read safely.',
      { path },
    );
  } finally {
    if (descriptor !== null) {
      try {
        env.storage.closeSync(descriptor);
      } catch {
        // The claimed path remains unavailable to every later consumer even if descriptor cleanup fails.
      }
    }
  }
}

function decodeCapsule(encoded: string): ProviderBootstrapCapsule {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_invalid',
      'Provider bootstrap capsule is not valid JSON.',
    );
  }
  if (JSON.stringify(value) !== encoded) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_invalid',
      'Provider bootstrap capsule is not canonical no-whitespace JSON.',
    );
  }
  return parseCapsule(value);
}

function assertConsumingBuild(
  capsule: ProviderBootstrapCapsule,
  resolveStrictIdentity: () => StrictBundleIdentityResult,
): void {
  const identity = resolveStrictIdentity();
  if (!identity.ok) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_strict_identity_unavailable',
      'The consuming backend could not establish its strict bundle identity.',
      { reason: identity.reason },
    );
  }
  if (capsule.buildSetId !== identity.manifest.buildSetId) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_build_set_mismatch',
      'Provider bootstrap capsule belongs to a different build set.',
      { capsuleBuildSetId: capsule.buildSetId, consumingBuildSetId: identity.manifest.buildSetId },
    );
  }
  if (capsule.flavor !== identity.manifest.flavor) {
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_build_flavor_mismatch',
      'Provider bootstrap capsule belongs to a different build flavor.',
      { capsuleFlavor: capsule.flavor, consumingFlavor: identity.manifest.flavor },
    );
  }
}

export function createProviderBootstrapCapsule(
  path: string,
  capsule: ProviderBootstrapCapsule,
  env: Pick<ProviderBootstrapCapsuleEnvironment, 'storage' | 'uid'>,
): void {
  assertCanonicalCapsulePath(path);
  const encoded = encodeCapsule(capsule);

  try {
    env.storage.mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    env.storage.writeFileSync(path, encoded, { encoding: 'utf8', mode: Number(PRIVATE_CAPSULE_MODE), flag: 'wx' });
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_already_exists',
        'Provider bootstrap capsule path already exists.',
        { path },
      );
    }
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_create_failed',
      'Provider bootstrap capsule could not be created.',
      { path },
    );
  }

  try {
    assertPrivateFile(path, env.uid, env.storage);
  } catch (error: unknown) {
    env.storage.rmSync(path, { force: true });
    throw error;
  }
}

export function consumeProviderBootstrapCapsule(
  path: string,
  expectedRole: 'guardian',
  env: ProviderBootstrapCapsuleEnvironment,
): GuardianBootstrapCapsule;
export function consumeProviderBootstrapCapsule(
  path: string,
  expectedRole: 'reaper',
  env: ProviderBootstrapCapsuleEnvironment,
): ReaperBootstrapCapsule;
export function consumeProviderBootstrapCapsule(
  path: string,
  expectedRole: 'proxy',
  env: ProviderBootstrapCapsuleEnvironment,
): ProxyBootstrapCapsule;
export function consumeProviderBootstrapCapsule(
  path: string,
  expectedRole: ProviderBootstrapRole,
  env: ProviderBootstrapCapsuleEnvironment,
): ProviderBootstrapCapsule {
  assertCanonicalCapsulePath(path);
  const claimedPath = `${path}${CLAIM_SUFFIX}`;

  try {
    // Renaming removes the only consumable name atomically before any secret bytes are read.
    env.storage.renameSync(path, claimedPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_replayed',
        'Provider bootstrap capsule has already been consumed.',
        { path },
      );
    }
    throw new ProviderBootstrapCapsuleError(
      'bootstrap_capsule_unreadable',
      'Provider bootstrap capsule could not be claimed for consumption.',
      { path },
    );
  }

  try {
    const capsule = decodeCapsule(readClaimedCapsule(claimedPath, env));
    if (capsule.role !== expectedRole) {
      throw new ProviderBootstrapCapsuleError(
        'bootstrap_capsule_role_mismatch',
        `Expected a ${expectedRole} bootstrap capsule but received ${capsule.role}.`,
        { expectedRole, observedRole: capsule.role },
      );
    }
    assertConsumingBuild(capsule, env.resolveStrictIdentity ?? resolveStrictBundleIdentity);
    return capsule;
  } finally {
    env.storage.rmSync(claimedPath, { force: true });
  }
}
