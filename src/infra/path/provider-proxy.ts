import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { hashToken } from '../hash.js';
import {
  ensurePrivateSocketDir,
  SocketDirectoryError,
  type SocketDirectoryRefusal,
  type SocketDirectoryStorage,
} from '../private-socket-directory.js';
import { generationRunDir } from './coordinator.js';
import { socketFallbackDir, socketPathByteLimit } from './unix-socket.js';

const PROVIDER_PATH_IDENTITY_HASH_LENGTH = 24;
const PROVIDER_ROLE_PREFIX = { guardian: '0', proxy: '1', reaper: '2' } as const;

export type ProviderProxyEndpointEnvironment = {
  readonly baseDir?: string;
  readonly platform: string;
  readonly uid: number;
  readonly storage: SocketDirectoryStorage;
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

export type ProviderProxyEndpointErrorCode = 'proxy_endpoint_insecure' | 'proxy_endpoint_unverified';

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
  refusal: SocketDirectoryRefusal,
  cause?: unknown,
): ProviderProxyEndpointError {
  const requirement = `a directory owned by uid ${env.uid} with mode 0700`;
  const observation =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'observation unavailable';
  const directory = observation.includes(fallbackDirectory)
    ? 'The provider endpoint fallback directory'
    : `Provider endpoint fallback directory '${fallbackDirectory}'`;
  const observed: Record<SocketDirectoryRefusal, string> = {
    foreign: `belongs to another user, so it cannot be ${requirement}`,
    unusable: `is not ${requirement}`,
    unsecurable: `cannot be held as ${requirement}: ${observation}`,
    unverified: `could not be verified as ${requirement}: ${observation}`,
  };
  const remediation: Record<SocketDirectoryRefusal, string> = {
    foreign: 'Ask its owner or an administrator to remove it, then start Coral again.',
    unusable: 'Remove it, then start Coral again.',
    unsecurable:
      "Give this host's administrator this observation, then start Coral again after the directory is repaired.",
    unverified: 'Resolve the reported filesystem error, then start Coral again.',
  };
  return new ProviderProxyEndpointError(
    refusal === 'unverified' ? 'proxy_endpoint_unverified' : 'proxy_endpoint_insecure',
    `${directory} ${observed[refusal]}. ${remediation[refusal]}`,
    {
      fallbackDirectory,
      refusal,
      expectedUid: env.uid,
      expectedMode: '0700',
      ...(cause === undefined
        ? {}
        : { cause: cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error' }),
    },
  );
}

function ensurePrivateFallbackDirectory(fallbackDirectory: string, env: ProviderProxyEndpointEnvironment): void {
  try {
    ensurePrivateSocketDir(fallbackDirectory, env.uid, env.storage);
  } catch (error: unknown) {
    if (error instanceof SocketDirectoryError) {
      throw insecureEndpointError(fallbackDirectory, env, error.refusal, error.cause);
    }
    throw insecureEndpointError(fallbackDirectory, env, 'unverified', error);
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

  const fallbackDirectory = socketFallbackDir(env.uid);
  const fallback = join(fallbackDirectory, filename);

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

/** The filename half of one capsule generation, exposed so discovery can build its own pattern from the same
 *  rule rather than a hand-kept copy of it. */
export function providerHandoffCapsuleFileSuffix(capsuleVersion: number): string {
  return capsuleVersion <= 2 ? 'handoff.json' : `handoff.v${capsuleVersion}.json`;
}

/**
 * The filename a capsule of one generation lives under.
 *
 * **The generation is in the filename**, and that is the only thing standing between a rollback and a dead
 * coordinator. A build reads a capsule strictly and refuses to start on one it cannot parse, so a newer
 * format under a name an older build opens is boot-fatal for it. v0.10.8's discovery matches
 * `provider-1<hash>.handoff.json` *exactly*, so anything from generation 3 onward is invisible to it rather
 * than fatal — and the change asks nothing of the build being rolled back to, which is what makes it the only
 * version of this fix that can work at all.
 *
 * Versions 1 and 2 keep the unsuffixed name they shipped under; nothing writes them any more, and renaming
 * them would hide capsules this build still has to find and refuse.
 *
 * The generation is a required argument and there is no default. `infra/` may not reach into
 * `provider-proxy/`, so a "current version" constant here would be a second copy of a fact the schema union
 * owns — and the two drifting apart is precisely how a capsule ends up written under a name that contradicts
 * its contents. Callers pass `CURRENT_HANDOFF_CAPSULE_VERSION` to write, or the capsule's own version to
 * address one that already exists.
 */
export function providerHandoffCapsulePath(
  identity: ProviderProxyEndpointIdentity,
  capsuleVersion: number,
  options?: ProviderBootstrapCapsulePathOptions,
): string {
  const identityHash = providerPathIdentityHash('proxy', identity, identity.proxyInstanceId);
  const suffix = providerHandoffCapsuleFileSuffix(capsuleVersion);
  return join(generationRunDir(identity.flavor, options), `provider-${identityHash}.${suffix}`);
}
