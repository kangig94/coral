declare const __VERSION__: string;

import { type PluginRegistry, createPluginRegistry } from '../../infra/plugin-registry.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import { ProviderRegistry } from '../../providers/registry.js';
import type { HostRef } from '../../providers/contract.js';
import { providerScopeSchema, type ProviderScope } from '../../infra/provider-scope.js';
import { writeAuditEvent } from '../../infra/audit-log.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readBuildFlavor, readBundleHash, resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { assertRemoteAddressLiteral } from '../../infra/remote-address.js';
import type { RemoteHttpAccessPolicy } from '../../transport/server-ports.js';
import type { CoordinatorIdentity } from '../lifecycle.js';
import { TypedEventBus } from '../event-bus.js';
import type { CoordinatorCoreOptions } from './types.js';
import { createDiscussContextRegistry, type DiscussContextRegistry } from '../../discuss/shell/live-registry.js';

import { LaunchCoordinator } from '../live/admission.js';
import {
  createProviderHostManager,
  type ProviderHostManager,
  type ProviderHostRetirementReevaluation,
} from '../live/provider-hosts/index.js';
import { createHostAdmissionCollection, exactHostRefsMatch } from '../../providers/host-admission.js';
import type { ProviderProxyAuthorityRegistry } from '../live/provider-proxy/authority.js';
import { LocalOperationRegistry } from '../services/operation-registry.js';
import { ProviderProxySetClaimMirror } from '../services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycleRef } from '../services/provider-proxy-set/lifecycle-ref.js';
import {
  createProviderProxySetRecordedContainmentReaper,
  type ProviderProxySetRecordedContainmentReaper,
} from '../services/provider-proxy-set/index.js';
import {
  createProviderProxySetContainmentProver,
  type ProviderProxySetContainmentProver,
} from '../services/provider-proxy-set/containment-proof.js';
import {
  createProviderProxySetInheritance,
  type ProviderProxySetInheritance,
} from '../services/provider-proxy-set/inheritance.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import { CoralSetupError } from '../../runtime/errors.js';
import type { BackendDefaultsPlan } from './defaults.js';
import { createStoreServicesRef, type StoreServicesRef } from './store-services-ref.js';
import { ChildPrincipalRegistry } from '../child-principal-registry.js';
import { admittedByThisCoordinator, classifyLocalCarriers } from './carrier-observation.js';
import { isLivePhase } from '../../jobs/phase.js';

const REMOTE_BIND_OPT_IN_ENV = 'CORAL_BACKEND_ALLOW_REMOTE';
const REMOTE_BIND_ADDRESS_ALLOWLIST_ENV = 'CORAL_BACKEND_REMOTE_ADDR_ALLOWLIST';
const REMOTE_BIND_UNRESTRICTED_ENV = 'CORAL_BACKEND_REMOTE_UNRESTRICTED';
const SYSTEM_PROVIDER_SCOPE_ENV = 'CORAL_SYSTEM_PROVIDER_SCOPE';
const PROVIDER_HOST_RETIREMENT_REEVALUATION_ATTEMPTS = 3;
const PROVIDER_HOST_RETIREMENT_REEVALUATION_RETRY_MS = 100;

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

function readConfiguredSystemProviderScope(
  raw: string | undefined,
): Extract<ProviderScope, { origin: 'system' }> | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const scope = providerScopeSchema.parse(JSON.parse(raw) as unknown);
    if (scope.origin !== 'system') throw new Error('origin must be system');
    return scope;
  } catch (error) {
    throw new CoralSetupError({
      code: 'system_provider_scope_invalid',
      userMessage: `${SYSTEM_PROVIDER_SCOPE_ENV} is not a valid named system provider scope.`,
      remediation: `Set ${SYSTEM_PROVIDER_SCOPE_ENV} to a strict JSON object with origin "system", a non-empty name, and canonical provider profiles, or unset it to disable HTTP/internal provider execution.`,
      context: { detail: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * The read-only startup boundary lets carrier consumers distinguish unfinished recovery without gaining the
 * authority to declare recovery complete themselves.
 */
export type StartupRecoveryBarrier = Readonly<{
  hasPassed(): boolean;
}>;

/**
 * Creates separate closure-backed facets so co-resident coordinator worlds cannot publish or observe one
 * another's startup boundary, and only composition decides where the publishing facet travels.
 */
export function createStartupRecoveryBarrier(): Readonly<{
  read: StartupRecoveryBarrier;
  publication: Readonly<{ publish(): void }>;
}> {
  let passed = false;
  return Object.freeze({
    read: Object.freeze({ hasPassed: () => passed }),
    publication: Object.freeze({
      publish: () => {
        passed = true;
      },
    }),
  });
}

export function createCarrierBlocksRetirement(
  storeServicesRef: StoreServicesRef,
  localCarrierRegistries: Parameters<typeof classifyLocalCarriers>[1],
): (hostRef: HostRef) => boolean {
  return (hostRef) => {
    const storeServices = storeServicesRef.tryGet();
    if (storeServices === null) return true;

    try {
      const progressStore = storeServices.progressStore;
      const matchingJobIds: string[] = [];
      for (const jobId of progressStore.listStoredNonterminalJobIds()) {
        const detail = progressStore.loadJobProjectionDetail(jobId);
        if (detail.status === null) return true;
        const jobRuntime = detail.runtime;
        if (jobRuntime?.transport !== 'app-server' || jobRuntime.providerMeta.leaseState !== 'acquired') {
          continue;
        }

        const storedHostRef = jobRuntime.providerMeta.hostRef;
        if (storedHostRef.leaseMode === 'job-exclusive' && storedHostRef.ownerJobId !== jobId) return true;
        if (exactHostRefsMatch(storedHostRef, hostRef)) matchingJobIds.push(jobId);
      }
      if (matchingJobIds.length === 0) return false;

      const observedMaxJournalSeq =
        progressStore.getDb().prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()
          ?.seq ?? 0;
      const observations = classifyLocalCarriers(matchingJobIds, localCarrierRegistries, observedMaxJournalSeq);
      if (
        observations.length !== matchingJobIds.length ||
        observations.some(({ observation }) => !isLivePhase(observation.storedPhase))
      ) {
        return true;
      }
      return observations.some(
        ({ observation }) => observation.liveness === 'live' || observation.liveness === 'unknown',
      );
    } catch {
      return true;
    }
  };
}

export function connectProviderHostRetirementReevaluation(options: {
  eventBus: TypedEventBus;
  storeServicesRef: StoreServicesRef;
  operationRegistry: LocalOperationRegistry;
  retirement: ProviderHostRetirementReevaluation;
  time: Pick<Runtime['time'], 'setTimeout'>;
}): void {
  const pendingRetries = new Map<string, ReturnType<Runtime['time']['setTimeout']>>();

  const attemptReevaluation = (jobId: string, attemptsRemaining: number): void => {
    try {
      const detail = options.storeServicesRef.tryGet()?.progressStore.loadJobProjectionDetail(jobId);
      const runtime = detail?.runtime;
      if (runtime?.transport !== 'app-server' || runtime.providerMeta.leaseState !== 'acquired') return;
      options.retirement.reevaluateIdleRetirement(runtime.providerMeta.hostRef);
    } catch (error: unknown) {
      backendLog.warn(`Failed to re-evaluate provider-host retirement for job '${jobId}': ${errorMessage(error)}`);
      if (attemptsRemaining <= 1 || pendingRetries.has(jobId)) return;

      try {
        const timer = options.time.setTimeout(() => {
          pendingRetries.delete(jobId);
          attemptReevaluation(jobId, attemptsRemaining - 1);
        }, PROVIDER_HOST_RETIREMENT_REEVALUATION_RETRY_MS);
        timer.unref?.();
        pendingRetries.set(jobId, timer);
      } catch (scheduleError: unknown) {
        backendLog.warn(
          `Failed to schedule provider-host retirement re-evaluation for job '${jobId}': ${errorMessage(scheduleError)}`,
        );
      }
    }
  };

  const reevaluateForJob = (jobId: string): void => {
    // Terminal publication and operation settlement are already committed before this callback. Keep failures
    // contained here, but preserve their liveness signal through a short bounded retry chain.
    if (pendingRetries.has(jobId)) return;
    attemptReevaluation(jobId, PROVIDER_HOST_RETIREMENT_REEVALUATION_ATTEMPTS);
  };

  // These are the two facts the carrier guard reads that can change after the last pin is released:
  // durable terminal publication removes the job from the nonterminal set, while registry settlement drops
  // this generation's live-operation evidence. Both re-enter the one guarded manager decision above.
  options.eventBus.on('job:completed', ({ jobId }) => reevaluateForJob(jobId));
  options.operationRegistry.connectSettlementObserver(reevaluateForJob);
}

export interface CoordinatorWorld {
  readonly identity: CoordinatorIdentity;
  readonly namespace: string;
  readonly bindHost: string;
  readonly advertiseHost?: string;
  readonly remoteAccess: RemoteHttpAccessPolicy;
  readonly backendPid: number;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly systemProviderScope?: Extract<ProviderScope, { origin: 'system' }>;
  readonly resolveProjectSource: (projectRoot: string) => string;
  readonly idleTimer: IdleTimer;
  readonly launchCoordinator: LaunchCoordinator;
  readonly eventBus: TypedEventBus;
  readonly providerRegistry: ProviderRegistry;
  readonly pluginRegistry: PluginRegistry;
  readonly childPrincipalRegistry: ChildPrincipalRegistry;
  readonly discussRegistry: DiscussContextRegistry;
  readonly storeServicesRef: StoreServicesRef;
  /** Carrier consumers receive only this facet, so none can advance startup recovery on a read path. */
  readonly startupRecoveryBarrier: StartupRecoveryBarrier;
  readonly providerHostManager: ProviderHostManager;
  /** Absent whenever `options.providerHostManager` overrode the default (see the construction site's own
   *  comment) — every test override, and only every test override. */
  readonly providerProxyAuthority?: ProviderProxyAuthorityRegistry;
  /** Same absence rule as `providerProxyAuthority` above — the capsule-inheritance branch of proxy-set
   *  acquisition (W2.4/W2.5), which startup recovery drives once the store is open and before it can decide
   *  any job carrier-detached. */
  readonly providerProxyInheritance?: ProviderProxySetInheritance;
  readonly providerProxySetContainmentProver: ProviderProxySetContainmentProver;
  readonly reapRecordedContainment: ProviderProxySetRecordedContainmentReaper;
  /** This coordinator generation's live app-server operations (W2.3) — see `CoordinatorCoreOptions.operationRegistry`. */
  readonly operationRegistry: LocalOperationRegistry;
  readonly providerProxyClaims: ProviderProxySetClaimMirror;
  readonly providerProxyLifecycleRef: ProviderProxySetLifecycleRef;
  readonly pluginRoot: string;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function createCoordinatorWorld(
  options: CoordinatorCoreOptions,
  runtime: Runtime,
  defaultsPlan: BackendDefaultsPlan,
  startupRecoveryBarrier: StartupRecoveryBarrier = createStartupRecoveryBarrier().read,
): CoordinatorWorld {
  const bootSnapshot = options.bootSnapshot ?? {};
  const pluginRoot = defaultsPlan.eager.resolvedPluginRoot;
  const namespace = options.backendNamespace ?? pluginRootNamespace(pluginRoot);
  const resolveProjectSource =
    options.resolveProjectSourceFn ?? ((projectRoot: string) => runtime.paths.projectSource(projectRoot));
  const strictBuild = resolveStrictBundleIdentity();
  if (!strictBuild.ok && strictBuild.reason !== 'embedded_identity_unavailable') {
    throw new Error('Coordinator build identity does not match its adjacent manifest.');
  }
  if (strictBuild.ok && strictBuild.manifest.storeFormatFingerprint !== options.storeFormat.fingerprint) {
    throw new Error('Coordinator store format does not match its adjacent manifest.');
  }
  const bundledVersion = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';
  const version = strictBuild.ok ? strictBuild.manifest.version : (bootSnapshot.version ?? bundledVersion);
  // A build identity that cannot be proven must never be one two boots can both claim.
  const buildSetId = strictBuild.ok ? strictBuild.manifest.buildSetId : (bootSnapshot.buildSetId ?? runtime.ids.uuid());
  const bundleHash = strictBuild.ok
    ? strictBuild.manifest.bundleHash
    : (bootSnapshot.bundleHash ?? readBundleHash(pluginRoot));
  const cliBundleHash = strictBuild.ok ? strictBuild.manifest.cliBundleHash : bundleHash;
  const claudeAppserverBundleHash = strictBuild.ok ? strictBuild.manifest.claudeAppserverBundleHash : bundleHash;
  backendLog.init({ version, bundleHash });
  const flavor = strictBuild.ok ? strictBuild.manifest.flavor : (bootSnapshot.flavor ?? readBuildFlavor(pluginRoot));
  const instanceId = bootSnapshot.instanceId ?? runtime.ids.uuid();
  const token = bootSnapshot.token ?? runtime.ids.randomBytes(32).toString('hex');
  const bootToken = bootSnapshot.bootToken ?? runtime.ids.randomBytes(32).toString('hex');
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
  const configuredSystemScope =
    options.systemProviderScope ?? readConfiguredSystemProviderScope(runtime.env.get(SYSTEM_PROVIDER_SCOPE_ENV));
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
  const childPrincipalRegistry = new ChildPrincipalRegistry(runtime.ids);
  const pluginRegistry = createPluginRegistry({
    storage: runtime.storage,
    env: runtime.env,
    homeDir: runtime.env.get('HOME') ?? runtime.env.get('USERPROFILE') ?? undefined,
  });
  const discussRegistry = options.discussRegistry ?? createDiscussContextRegistry();
  const storeServicesRef = createStoreServicesRef();
  const operationRegistry = options.operationRegistry ?? new LocalOperationRegistry();
  const providerProxyClaims = new ProviderProxySetClaimMirror();
  const providerProxyLifecycleRef = new ProviderProxySetLifecycleRef();
  const providerProxySetContainmentProver = createProviderProxySetContainmentProver(runtime);
  const reapRecordedContainment = createProviderProxySetRecordedContainmentReaper(runtime);
  const localCarrierRegistries = {
    getDb: () => storeServicesRef.get().progressStore.getDb(),
    loadJobProjectionDetail: (jobId: string) => storeServicesRef.get().progressStore.loadJobProjectionDetail(jobId),
    platform: runtime.env.platform() as NodeJS.Platform,
    hasStartupRecoveryPassed: () => startupRecoveryBarrier.hasPassed(),
    isAdmittedByThisCoordinator: (jobId: string) => admittedByThisCoordinator(launchCoordinator, jobId),
    registryStateForJob: (jobId: string) => operationRegistry.stateForJob(jobId),
  };
  const carrierBlocksRetirement = createCarrierBlocksRetirement(storeServicesRef, localCarrierRegistries);
  // A caller-supplied `providerHostManager` (every test that fakes provider hosts) never carries live
  // guardian/reaper/proxy sets, so `providerProxyAuthority` stays absent rather than reporting on a
  // substitute it played no part in creating — matching `runShutdownSequence`'s own `undefined` default.
  let providerHostManager: ProviderHostManager;
  let providerProxyAuthority: ProviderProxyAuthorityRegistry | undefined;
  let providerProxyInheritance: ProviderProxySetInheritance | undefined;
  if (options.providerHostManager !== undefined) {
    providerHostManager = options.providerHostManager;
  } else {
    const created = createProviderHostManager({
      runtime,
      spawnProviderServer: launchCoordinator.spawnProviderServer.bind(launchCoordinator),
      admission: options.providerHostAdmission ?? createHostAdmissionCollection({ classify: () => 'unknown' }),
      allocateProviderServerGeneration: launchCoordinator.allocateProviderServerGeneration.bind(launchCoordinator),
      carrierBlocksRetirement,
      proxySetAcquisition: {
        pluginRoot,
        identity: { instanceId, buildSetId, flavor },
        operationRegistry,
        ...(options.buildProviderEventHandler === undefined
          ? {}
          : { onProviderEvent: options.buildProviderEventHandler }),
      },
      providerProxyLifecycleRef,
    });
    connectProviderHostRetirementReevaluation({
      eventBus,
      storeServicesRef,
      operationRegistry,
      retirement: created,
      time: runtime.time,
    });
    providerHostManager = created;
    providerProxyAuthority = created;
    // The redemption mechanism needs jobs-domain vocabulary `coordinator/live/**` may not reach directly
    // (`architecture-layering.test.ts`'s coordinator-contract-entrypoint rule), so it is composed here in
    // `coordinator/composition/` — itself exempt — closing over the identical identity/registry/event-handler
    // `proxySetAcquisition` above already carries, and folding a successfully redeemed set back into `created`
    // through its narrow, domain-free `registerInheritedSet` seam.
    providerProxyInheritance = createProviderProxySetInheritance({
      runtime,
      identity: { instanceId, buildSetId, flavor },
      operationRegistry,
      containmentProver: providerProxySetContainmentProver,
      reapRecordedContainment,
      ...(options.buildProviderEventHandler === undefined
        ? {}
        : { onProviderEvent: options.buildProviderEventHandler }),
      registerInheritedSet: (set) => {
        created.registerInheritedSet(set);
      },
    });
  }
  providerRegistry.connectAppServerHost(providerHostManager);

  const identity: CoordinatorIdentity = {
    pluginRoot,
    namespace,
    version,
    buildSetId,
    bundleHash,
    cliBundleHash,
    claudeAppserverBundleHash,
    flavor,
    instanceId,
    token,
    bootToken,
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
    ...(configuredSystemScope === undefined ? {} : { systemProviderScope: configuredSystemScope }),
    resolveProjectSource,
    idleTimer,
    launchCoordinator,
    eventBus,
    providerRegistry,
    childPrincipalRegistry,
    pluginRegistry,
    discussRegistry,
    storeServicesRef,
    startupRecoveryBarrier,
    providerHostManager,
    ...(providerProxyAuthority === undefined ? {} : { providerProxyAuthority }),
    ...(providerProxyInheritance === undefined ? {} : { providerProxyInheritance }),
    providerProxySetContainmentProver,
    reapRecordedContainment,
    operationRegistry,
    providerProxyClaims,
    providerProxyLifecycleRef,
    pluginRoot,
    now,
    log,
  };
}
