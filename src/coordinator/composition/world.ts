declare const __VERSION__: string;

import { type PluginRegistry, createPluginRegistry } from '../../infra/plugin-registry.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { backendLog } from '../../infra/backend-log.js';
import { readBuildFlavor, readBundleHash } from '../../infra/bundle-manifest.js';
import type { CoordinatorIdentity } from '../lifecycle.js';
import { TypedEventBus } from '../event-bus.js';
import type { CoordinatorCoreOptions } from './types.js';
import { createDiscussContextRegistry, type DiscussContextRegistry } from '../../discuss/shell/live-registry.js';

import { LaunchCoordinator } from '../live/admission.js';
import { createProviderHostManager, type ProviderHostManager } from '../live/provider-hosts/index.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import type { BackendDefaultsPlan } from './defaults.js';
import { createStoreServicesRef, type StoreServicesRef } from './store-services-ref.js';

export interface CoordinatorWorld {
  readonly identity: CoordinatorIdentity;
  readonly namespace: string;
  readonly bindHost: string;
  readonly advertiseHost?: string;
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
  const version = bootSnapshot.version ?? (typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0');
  const bundleHash = bootSnapshot.bundleHash ?? readBundleHash(pluginRoot);
  backendLog.init({ version, bundleHash });
  const flavor = bootSnapshot.flavor ?? readBuildFlavor(pluginRoot);
  const instanceId = bootSnapshot.instanceId ?? runtime.ids.uuid();
  const token = bootSnapshot.token ?? runtime.ids.randomBytes(32).toString('hex');
  const bindHost = bootSnapshot.bindHost ?? runtime.env.get('CORAL_BACKEND_BIND') ?? '127.0.0.1';
  const advertiseHost = bootSnapshot.advertiseHost ?? runtime.env.get('CORAL_BACKEND_ADVERTISE_HOST');
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
    now,
    log,
  };

  return {
    identity,
    namespace,
    bindHost,
    advertiseHost,
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
