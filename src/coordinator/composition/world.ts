declare const __VERSION__: string;

import { type PluginRegistry, createPluginRegistry } from '../../infra/plugin-registry.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { writeAuditEvent } from '../../infra/audit-log.js';
import { backendLog } from '../../infra/backend-log.js';
import { readBuildFlavor, readBundleHash } from '../../infra/bundle-manifest.js';
import { assertRemoteAddressLiteral } from '../../infra/remote-address.js';
import type { RemoteHttpAccessPolicy } from '../../transport/server-ports.js';
import type { CoordinatorIdentity } from '../lifecycle.js';
import { TypedEventBus } from '../event-bus.js';
import type { CoordinatorCoreOptions } from './types.js';
import { createDiscussContextRegistry, type DiscussContextRegistry } from '../../discuss/shell/live-registry.js';

import { LaunchCoordinator } from '../live/admission.js';
import { createProviderHostManager, type ProviderHostManager } from '../live/provider-hosts/index.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import { CoralSetupError } from '../../runtime/errors.js';
import type { BackendDefaultsPlan } from './defaults.js';
import { createStoreServicesRef, type StoreServicesRef } from './store-services-ref.js';

const REMOTE_BIND_OPT_IN_ENV = 'CORAL_BACKEND_ALLOW_REMOTE';
const REMOTE_BIND_ADDRESS_ALLOWLIST_ENV = 'CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST';
const REMOTE_BIND_UNRESTRICTED_ENV = 'CORAL_BACKEND_REMOTE_UNRESTRICTED';

function isLoopbackBindHost(bindHost: string): boolean {
  const host = bindHost.trim().toLowerCase();
  if (host === 'localhost' || host === '::1') return true;

  const octets = host.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((part) => /^\d+$/.test(part))) return false;

  const [first, ...rest] = octets.map((part) => Number(part));
  return first === 127 && rest.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function assertRemoteBindHostAllowed(bindHost: string, allowRemote: string | undefined): void {
  if (isLoopbackBindHost(bindHost) || allowRemote === '1') return;

  throw new CoralSetupError({
    code: 'backend_remote_bind_requires_opt_in',
    userMessage: `Refusing to bind Coral backend to non-loopback host '${bindHost}' without ${REMOTE_BIND_OPT_IN_ENV}=1.`,
    remediation: `Use loopback-only CORAL_BACKEND_BIND (127.0.0.1, ::1, or localhost), or set ${REMOTE_BIND_OPT_IN_ENV}=1 only when remote backend exposure is intentional and protected by a trusted network boundary.`,
    context: { bindHost, optInEnv: REMOTE_BIND_OPT_IN_ENV },
  });
}

function parseRemoteAddressAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }

  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let normalized: string;
    try {
      normalized = assertRemoteAddressLiteral(trimmed, REMOTE_BIND_ADDRESS_ALLOWLIST_ENV);
    } catch (error) {
      throw new CoralSetupError({
        code: 'backend_remote_bind_invalid_allowlist',
        userMessage: `Invalid ${REMOTE_BIND_ADDRESS_ALLOWLIST_ENV} entry '${trimmed}'.`,
        remediation: `${REMOTE_BIND_ADDRESS_ALLOWLIST_ENV} currently accepts comma-separated IP address literals only; use ${REMOTE_BIND_UNRESTRICTED_ENV}=1 only behind a trusted network boundary.`,
        context: {
          allowlistEnv: REMOTE_BIND_ADDRESS_ALLOWLIST_ENV,
          invalidEntry: trimmed,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    parsed.push(normalized);
  }
  return parsed;
}

function resolveRemoteAccessPolicy(params: {
  bindHost: string;
  allowRemote: string | undefined;
  allowlist: string | undefined;
  unrestricted: string | undefined;
}): RemoteHttpAccessPolicy {
  const { bindHost, allowRemote, allowlist, unrestricted } = params;
  if (isLoopbackBindHost(bindHost)) {
    return { mode: 'loopback' };
  }

  assertRemoteBindHostAllowed(bindHost, allowRemote);
  const allowedRemoteAddresses = parseRemoteAddressAllowlist(allowlist);
  if (allowedRemoteAddresses.length > 0) {
    return { mode: 'address_allowlist', allowedRemoteAddresses };
  }

  if (unrestricted === '1') {
    return { mode: 'unrestricted' };
  }

  throw new CoralSetupError({
    code: 'backend_remote_bind_requires_access_policy',
    userMessage: `Refusing to bind Coral backend to non-loopback host '${bindHost}' without a remote access policy.`,
    remediation: `Set ${REMOTE_BIND_ADDRESS_ALLOWLIST_ENV} to a comma-separated list of trusted client IP addresses, or set ${REMOTE_BIND_UNRESTRICTED_ENV}=1 only behind a trusted network boundary.`,
    context: {
      bindHost,
      optInEnv: REMOTE_BIND_OPT_IN_ENV,
      allowlistEnv: REMOTE_BIND_ADDRESS_ALLOWLIST_ENV,
      unrestrictedEnv: REMOTE_BIND_UNRESTRICTED_ENV,
    },
  });
}

export interface CoordinatorWorld {
  readonly identity: CoordinatorIdentity;
  readonly namespace: string;
  readonly bindHost: string;
  readonly advertiseHost?: string;
  readonly remoteAccess: RemoteHttpAccessPolicy;
  readonly backendPid: number;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly resolveProjectSource: (projectRoot: string) => string;
  readonly idleTimer: IdleTimer;
  readonly launchCoordinator: LaunchCoordinator;
  readonly eventBus: TypedEventBus;
  readonly providerRegistry: ProviderRegistry;
  readonly pluginRegistry: PluginRegistry;
  readonly discussRegistry: DiscussContextRegistry;
  readonly storeServicesRef: StoreServicesRef;
  readonly providerHostManager: ProviderHostManager;
  readonly pluginRoot: string;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function createCoordinatorWorld(
  options: CoordinatorCoreOptions,
  runtime: Runtime,
  defaultsPlan: BackendDefaultsPlan,
): CoordinatorWorld {
  const bootSnapshot = options.bootSnapshot ?? {};
  const pluginRoot = defaultsPlan.eager.resolvedPluginRoot;
  const namespace = options.backendNamespace ?? pluginRootNamespace(pluginRoot);
  const resolveProjectSource =
    options.resolveProjectSourceFn ?? ((projectRoot: string) => runtime.paths.projectSource(projectRoot));
  const bundledVersion = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';
  const version = bootSnapshot.version ?? bundledVersion;
  const bundleHash = bootSnapshot.bundleHash ?? readBundleHash(pluginRoot);
  backendLog.init({ version, bundleHash });
  const flavor = bootSnapshot.flavor ?? readBuildFlavor(pluginRoot);
  const instanceId = bootSnapshot.instanceId ?? runtime.ids.uuid();
  const token = bootSnapshot.token ?? runtime.ids.randomBytes(32).toString('hex');
  const shutdownToken = bootSnapshot.shutdownToken ?? runtime.ids.randomBytes(32).toString('hex');
  const bindHost = bootSnapshot.bindHost ?? runtime.env.get('CORAL_BACKEND_BIND') ?? '127.0.0.1';
  const advertiseHost = bootSnapshot.advertiseHost ?? runtime.env.get('CORAL_BACKEND_ADVERTISE_HOST');
  const remoteAccess = resolveRemoteAccessPolicy({
    bindHost,
    allowRemote: runtime.env.get(REMOTE_BIND_OPT_IN_ENV),
    allowlist: runtime.env.get(REMOTE_BIND_ADDRESS_ALLOWLIST_ENV),
    unrestricted: runtime.env.get(REMOTE_BIND_UNRESTRICTED_ENV),
  });
  if (remoteAccess.mode !== 'loopback') {
    writeAuditEvent(
      'remote_bind_enabled',
      {
        bindHost,
        advertiseHost,
        mode: remoteAccess.mode,
        allowlistCount: remoteAccess.allowedRemoteAddresses?.length ?? 0,
      },
      remoteAccess.mode === 'unrestricted' ? 'warn' : 'info',
    );
  }
  const backendPid = bootSnapshot.pid ?? runtime.env.pid();
  const coralEnvSnapshot = runtime.env.coralSnapshot();
  const now = bootSnapshot.now ?? (() => runtime.time.now());
  const log =
    bootSnapshot.log ??
    ((message: string) => {
      backendLog.raw(message);
    });

  // backendLog.init must complete before constructing singletons; do not move it below this point.
  const idleTimer = defaultsPlan.eager.createIdleTimer();
  const launchCoordinator = options.launchCoordinator ?? new LaunchCoordinator({ runtime });
  const eventBus = options.eventBus ?? new TypedEventBus();
  const providerRegistry = options.providerRegistry ?? new ProviderRegistry();
  const pluginRegistry = createPluginRegistry({
    storage: runtime.storage,
    env: runtime.env,
    homeDir: runtime.env.get('HOME') ?? runtime.env.get('USERPROFILE') ?? undefined,
  });
  const discussRegistry = options.discussRegistry ?? createDiscussContextRegistry();
  const storeServicesRef = createStoreServicesRef();
  const providerHostManager =
    options.providerHostManager ??
    createProviderHostManager({
      runtime,
      spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
    });

  const identity: CoordinatorIdentity = {
    pluginRoot,
    namespace,
    version,
    bundleHash,
    flavor,
    instanceId,
    token,
    shutdownToken,
    now,
    log,
  };

  return {
    identity,
    namespace,
    bindHost,
    advertiseHost,
    remoteAccess,
    backendPid,
    coralEnvSnapshot,
    resolveProjectSource,
    idleTimer,
    launchCoordinator,
    eventBus,
    providerRegistry,
    pluginRegistry,
    discussRegistry,
    storeServicesRef,
    providerHostManager,
    pluginRoot,
    now,
    log,
  };
}
