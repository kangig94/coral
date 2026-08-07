import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { hashToken } from '../hash.js';
import type { StorageBigIntStat, StoragePort } from '../port-types.js';
import { generationRunDir, socketPathByteLimit } from './coordinator.js';

const PROVIDER_PATH_IDENTITY_HASH_LENGTH = 24;
const PROVIDER_ROLE_PREFIX = { guardian: '0', proxy: '1', reaper: '2' } as const;
const PRIVATE_DIRECTORY_MODE = 0o700n;
const PERMISSION_BITS = 0o777n;

type ProviderEndpointStorage = Pick<StoragePort, 'lstatSync' | 'mkdirSync'> & {
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
};

export type ProviderProxyEndpointEnvironment = {
  readonly baseDir?: string;
  readonly platform: string;
  readonly tempDirectory: string;
  readonly uid: number;
  readonly storage: ProviderEndpointStorage;
};

type ProviderSetIdentity = {
  readonly generation: 'gen2';
  readonly flavor: BuildFlavor;
  readonly buildSetId: string;
  readonly hostFingerprint: string;
};

export type ProviderProxyEndpointIdentity = ProviderSetIdentity & {
  readonly proxyInstanceId: string;
};

export type ProviderGuardianEndpointIdentity = ProviderSetIdentity & {
  readonly guardianInstanceId: string;
};

export type ProviderReaperEndpointIdentity = ProviderSetIdentity & {
  readonly reaperInstanceId: string;
};

export type ProviderBootstrapCapsulePathOptions = {
  readonly baseDir?: string;
};

export type ProviderProxyEndpointErrorCode = 'proxy_endpoint_insecure' | 'proxy_endpoint_too_long';

export class ProviderProxyEndpointError extends Error {
  readonly code: ProviderProxyEndpointErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ProviderProxyEndpointErrorCode, message: string, context: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ProviderProxyEndpointError';
    this.code = code;
    this.context = context;
    Object.setPrototypeOf(this, ProviderProxyEndpointError.prototype);
  }
}

function providerPathIdentityHash(
  kind: 'guardian' | 'proxy' | 'reaper',
  identity: ProviderSetIdentity,
  instanceId: string,
): string {
  const hash = hashToken(
    JSON.stringify([
      kind,
      identity.generation,
      identity.flavor,
      identity.buildSetId,
      identity.hostFingerprint,
      instanceId,
    ]),
    PROVIDER_PATH_IDENTITY_HASH_LENGTH - 1,
  );
  return `${PROVIDER_ROLE_PREFIX[kind]}${hash}`;
}

function insecureEndpointError(
  fallbackDirectory: string,
  env: ProviderProxyEndpointEnvironment,
  cause?: unknown,
): ProviderProxyEndpointError {
  return new ProviderProxyEndpointError(
    'proxy_endpoint_insecure',
    `Provider endpoint fallback directory is not owned by uid ${env.uid} with mode 0700.`,
    {
      fallbackDirectory,
      expectedUid: env.uid,
      expectedMode: '0700',
      ...(cause === undefined
        ? {}
        : { cause: cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error' }),
    },
  );
}

function ensurePrivateFallbackDirectory(fallbackDirectory: string, env: ProviderProxyEndpointEnvironment): void {
  if (!Number.isSafeInteger(env.uid) || env.uid < 0) {
    throw insecureEndpointError(fallbackDirectory, env);
  }

  try {
    env.storage.mkdirSync(fallbackDirectory, { recursive: true, mode: Number(PRIVATE_DIRECTORY_MODE) });
    const link = env.storage.lstatSync(fallbackDirectory);
    const stat = env.storage.statSync(fallbackDirectory, { bigint: true });
    if (
      !link.isDirectory() ||
      link.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid === undefined ||
      stat.uid !== BigInt(env.uid) ||
      (stat.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw insecureEndpointError(fallbackDirectory, env);
    }
  } catch (error: unknown) {
    if (error instanceof ProviderProxyEndpointError) throw error;
    throw insecureEndpointError(fallbackDirectory, env, error);
  }
}

function providerEndpoint(
  kind: 'guardian' | 'proxy' | 'reaper',
  identity: ProviderSetIdentity,
  instanceId: string,
  env: ProviderProxyEndpointEnvironment,
): string {
  const identityHash = providerPathIdentityHash(kind, identity, instanceId);
  const filename = `provider-${identityHash}.sock`;
  const limit = socketPathByteLimit(env.platform);
  const candidate = join(generationRunDir(identity.flavor, { baseDir: env.baseDir }), filename);
  if (Buffer.byteLength(candidate, 'utf8') < limit) return candidate;

  const fallbackDirectory = join(env.tempDirectory, `coral-${env.uid}`);
  const fallback = join(fallbackDirectory, filename);
  const fallbackBytes = Buffer.byteLength(fallback, 'utf8');
  if (fallbackBytes >= limit) {
    throw new ProviderProxyEndpointError(
      'proxy_endpoint_too_long',
      `Provider endpoint path is ${fallbackBytes} bytes; ${env.platform} requires fewer than ${limit}.`,
      { path: fallback, observedBytes: fallbackBytes, limit, platform: env.platform },
    );
  }

  ensurePrivateFallbackDirectory(fallbackDirectory, env);
  return fallback;
}

function providerBootstrapCapsulePath(
  kind: 'guardian' | 'proxy' | 'reaper',
  identity: ProviderSetIdentity,
  instanceId: string,
  options?: ProviderBootstrapCapsulePathOptions,
): string {
  const identityHash = providerPathIdentityHash(kind, identity, instanceId);
  return join(generationRunDir(identity.flavor, options), `provider-${identityHash}.bootstrap.json`);
}

export function providerProxyEndpoint(
  identity: ProviderProxyEndpointIdentity,
  env: ProviderProxyEndpointEnvironment,
): string {
  return providerEndpoint('proxy', identity, identity.proxyInstanceId, env);
}

export function providerGuardianEndpoint(
  identity: ProviderGuardianEndpointIdentity,
  env: ProviderProxyEndpointEnvironment,
): string {
  return providerEndpoint('guardian', identity, identity.guardianInstanceId, env);
}

export function providerReaperEndpoint(
  identity: ProviderReaperEndpointIdentity,
  env: ProviderProxyEndpointEnvironment,
): string {
  return providerEndpoint('reaper', identity, identity.reaperInstanceId, env);
}

export function providerProxyBootstrapCapsulePath(
  identity: ProviderProxyEndpointIdentity,
  options?: ProviderBootstrapCapsulePathOptions,
): string {
  return providerBootstrapCapsulePath('proxy', identity, identity.proxyInstanceId, options);
}

export function providerGuardianBootstrapCapsulePath(
  identity: ProviderGuardianEndpointIdentity,
  options?: ProviderBootstrapCapsulePathOptions,
): string {
  return providerBootstrapCapsulePath('guardian', identity, identity.guardianInstanceId, options);
}

export function providerReaperBootstrapCapsulePath(
  identity: ProviderReaperEndpointIdentity,
  options?: ProviderBootstrapCapsulePathOptions,
): string {
  return providerBootstrapCapsulePath('reaper', identity, identity.reaperInstanceId, options);
}

/**
 * The successor half of a handoff grant: one capsule per proxy (there is one grant per proxy over its
 * complete operation set, never one per operation), keyed by `proxyInstanceId` like every other proxy-role
 * path. A distinct `.handoff.json` suffix on the same identity hash keeps it from ever colliding with that
 * proxy's own one-use `.bootstrap.json` path, which names a different secret with a different lifetime.
 */
export function providerHandoffCapsulePath(
  identity: ProviderProxyEndpointIdentity,
  options?: ProviderBootstrapCapsulePathOptions,
): string {
  const identityHash = providerPathIdentityHash('proxy', identity, identity.proxyInstanceId);
  return join(generationRunDir(identity.flavor, options), `provider-${identityHash}.handoff.json`);
}
