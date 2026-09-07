import type {
  AppServerTransport,
  HostRef,
  ProviderHostEvictionDisposition,
  ProviderHostTerminalEvictionDisposition,
  ProviderServerSpec,
} from '../../../providers/contract.js';
import {
  PROVIDER_CONTAINMENT_ACCEPTED,
  isAcceptedProviderServerOperatorAbandonment,
  type ContainedProviderServerHandle,
  type ProviderServerFailedSpawnCleanupAcceptance,
  type ProviderServerFailedSpawnCleanupDisposition,
  type ProviderServerFailedSpawnCleanupHold,
  type ProviderServerFailedSpawnCleanupTerminalDisposition,
  type ProviderServerHandle,
  type SpawnProviderServerFn,
} from '../../../providers/app-server-transport.js';
import type { ProviderHostDiagnosticsSnapshot } from '../../../providers/host-diagnostics.js';
import type { ProviderHostInventoryRecord } from '../../services/provider-host-administration.js';
import {
  admissionSlotKey,
  canonicalProviderHostSpecMetadata,
  createHostAdmissionCollection,
  exactHostRefIdentityKey,
  exactHostRefsMatch,
  type AdmissionSlotKey,
  type HostAdmissionCollection,
  type HostAdmissionReservation,
  type HostAdmissionSnapshot,
} from '../../../providers/host-admission.js';
import type { Runtime } from '../../../runtime/ports.js';
import { backendLog } from '../../../infra/backend-log.js';
import { ProcessContainmentError, type RecordedContainmentIdentity } from '../../../infra/process-containment.js';
import {
  acquireProviderHostPin,
  createProviderServerAttachment,
  createProviderServerLease,
  type ProviderServerLease,
} from './lease.js';
import { attachHostNotificationListener, clearIdleTimer, maybeArmIdleTimer, parseIdleTimeoutMs } from './idle.js';
import {
  closeProviderServerEntry as closeEntry,
  createProviderHostContainmentReaper,
  shutdownHandle,
  type ProviderHostContainmentReaper,
} from './drain.js';
import { cloneSpec, ensureProviderServerHandle } from './recovery.js';
import {
  disposeStoppedProviderProxySetAcquisition,
  ensureProviderProxySet,
  type ProviderProxySetAcquisitionCleanupHold,
  type ProviderProxySetAcquisitionCleanupOutcome,
  type ProviderProxySetAcquisitionConfig,
  type ProviderProxySetAcquisitionOutcome,
  type ProviderProxySetAcquisitionStopDisposition,
} from './proxy-set-acquisition.js';
import {
  hostFingerprintFromSpec,
  hostKeyFromSpec,
  hostRefFromEntry,
  type ProviderHostEntry,
  type ProviderHostShutdownDisposition,
  type ProviderHostShutdownHold,
} from './state.js';
import { AbortError, throwIfAborted } from '../../../runtime/abort.js';
import type { ProviderProxyAuthorityRegistry, ProviderProxySetAuthority } from '../provider-proxy/authority.js';
import {
  isProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
  type ProviderProxyOperationAuthority,
} from '../provider-proxy/operation-route.js';
import type { ProviderProxySetLifecycleRef } from '../../services/provider-proxy-set/lifecycle-ref.js';
import type {
  ProviderProxyRepresentationReleaseDisposition,
  ProviderProxyRepresentationReleaseSettlement,
} from '../../services/provider-proxy-set/index.js';
import type { ProviderProxySetProtection } from '../../services/provider-proxy-set/identity.js';
import type { PublicationReceipt } from '../provider-proxy/set-publication.js';
export type { ProviderHostEntry } from './state.js';

export interface ProviderHostManager {
  openSession(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ManagedAppServerSession>;
  attachSession(
    hostRef: HostRef,
    expectation: Readonly<{ spec: ProviderServerSpec; jobId: string }>,
  ): Promise<ManagedAppServerSession | null>;
  drainForHandoff(signal?: AbortSignal): Promise<ProviderHostQuiescenceReceipt>;
  shutdown(signal?: AbortSignal): Promise<ProviderHostQuiescenceReceipt>;
  cleanupObligations?(): ProviderHostCleanupObligations;
  /**
   * The live proxy set's operation-routing capability for `spec`'s executable identity, or `null` when no
   * set is live for it yet. Never triggers or waits on an acquisition — that stays fire-and-forget, started
   * the first time a session is actually acquired for this identity (see `ensureProxySetFor`).
   */
  routeAppServerOperation(spec: ProviderServerSpec): ProviderProxyOperationAuthority | null;
  providerProxySlotReleased?(routeKey: string): void;
}

export type ProviderHostQuiescenceReceipt = Readonly<{
  kind: 'provider-hosts-quiesced';
  liveProxySets: readonly ProviderProxySetAuthority[];
  acquisitionCleanupHolds: readonly ProviderProxySetAcquisitionCleanupHold[];
  closingHosts: readonly ProviderHostClosingObligation[];
}>;

type SettledProviderHostClosingObligation = Readonly<{
  label: string;
  containment: RecordedContainmentIdentity | null;
  settlement: Promise<void>;
}>;

export type ProviderHostShutdownObligation = Readonly<{
  kind: 'provider-server-shutdown-held';
  label: string;
  containment: RecordedContainmentIdentity;
  settlement: Promise<void>;
  inspect(): ProviderHostShutdownHold;
  operatorExit: ProviderHostShutdownHold['operatorExit'];
}>;

export type ProviderHostSpawnCleanupObligation = Readonly<{
  kind: 'provider-server-spawn-cleanup-held';
  label: string;
  containment: null;
  settlement: Promise<void>;
  inspect(): ProviderServerFailedSpawnCleanupHold;
  operatorExit: ProviderServerFailedSpawnCleanupHold['operatorExit'];
}>;

export type ProviderHostClosingObligation =
  | SettledProviderHostClosingObligation
  | ProviderHostSpawnCleanupObligation
  | ProviderHostShutdownObligation;

export type ProviderRepresentationReleaseObligation = Readonly<{
  label: string;
  proxyInstanceId: string;
  pendingOperations: readonly string[];
  disposition: ProviderProxyRepresentationReleaseDisposition;
  exit: 'provider-proxy-representation-release-settlement';
  settlement: Promise<ProviderProxyRepresentationReleaseSettlement>;
}>;

export type ProviderHostCleanupObligations = Pick<
  ProviderHostQuiescenceReceipt,
  'liveProxySets' | 'acquisitionCleanupHolds' | 'closingHosts'
> &
  Readonly<{ representationReleaseHolds: readonly ProviderRepresentationReleaseObligation[] }>;

export type ProviderHostLifecycle = Pick<ProviderHostManager, 'drainForHandoff' | 'shutdown'> &
  Partial<Pick<ProviderHostManager, 'cleanupObligations'>>;

/** Re-evaluates one host after a durable carrier fact changes. */
export interface ProviderHostRetirementReevaluation {
  reevaluateIdleRetirement(hostRef: HostRef): void;
}

export interface ProviderHostAdministrationAuthority {
  admissionSnapshot(): HostAdmissionSnapshot;
  listProviderHosts(): readonly ProviderHostInventoryRecord[];
  inspectProviderHost(hostRef: HostRef): ProviderHostInventoryRecord | null;
  evictHost(hostRef: HostRef): Promise<ProviderHostEvictionDisposition>;
}

/**
 * The registration half of the inheritance branch of proxy-set acquisition (W2.4/W2.5). The redemption
 * mechanism itself — reading a standing recovery capsule and attaching its operations — needs the
 * durable saga and jobs cleanup vocabulary that `coordinator/live/**` may not compose directly
 * (`architecture-layering.test.ts`'s coordinator-contract-entrypoint rule), so it lives in
 * `coordinator/services/provider-proxy-set/inheritance.ts` and calls back into this narrow, domain-free seam
 * once it already holds a live, connected set.
 */
export interface ProviderProxySetRegistration {
  /** Folds an already-redeemed set into this manager's own live sets (`liveSets()`), so it participates in
   *  this coordinator's later shutdown — including a second handoff — exactly as an acquired set would. */
  registerInheritedSet(
    set: ProviderProxyOperationAuthority,
    publicationReceipt: PublicationReceipt,
    protection?: ProviderProxySetProtection,
  ): void;
}

export type ManagedAppServerSession = Readonly<{
  session: AppServerTransport;
  hostRef: HostRef;
  close(): void;
}>;

function foldedKey(key: string, platform: string): string {
  return platform === 'win32' ? key.toLowerCase() : key;
}

function compileLaunchEnvironment(spec: ProviderServerSpec, platform: string): Readonly<Record<string, string>> {
  const environment = spec.env ?? {};
  rejectCaseFoldedDuplicates(environment, platform, 'stable host environment');
  return Object.freeze({ ...environment });
}

function assertProviderHostPolicy(spec: ProviderServerSpec): void {
  const value = spec as unknown as Record<string, unknown>;
  if (value.leaseMode === 'shared') {
    if (
      value.idleRetirement === 'unleased' ||
      value.idleRetirement === 'unleased-and-host-idle' ||
      value.idleRetirement === 'never'
    ) {
      return;
    }
    throw new Error(
      "provider_host_policy_invalid: shared hosts require idleRetirement 'unleased', 'unleased-and-host-idle', or 'never'",
    );
  }
  if (value.leaseMode === 'job-exclusive') {
    if (!Object.hasOwn(value, 'idleRetirement')) return;
    throw new Error('provider_host_policy_invalid: job-exclusive hosts cannot declare idleRetirement');
  }
  throw new Error("provider_host_policy_invalid: leaseMode must be 'shared' or 'job-exclusive'");
}

function rejectCaseFoldedDuplicates(
  environment: Readonly<Record<string, string>>,
  platform: string,
  label: string,
): void {
  const keys = new Map<string, string>();
  for (const key of Object.keys(environment)) {
    const folded = foldedKey(key, platform);
    const prior = keys.get(folded);
    if (prior !== undefined && prior !== key) {
      throw new Error(
        `provider_host_environment_conflict: ${label} contains case-fold duplicate '${prior}' and '${key}'`,
      );
    }
    keys.set(folded, key);
  }
}

function isExactHostRef(value: HostRef): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.provider !== 'string' ||
    typeof value.instanceId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (value.leaseMode === 'shared') {
    return keys.join('\0') === ['fingerprint', 'instanceId', 'leaseMode', 'provider'].join('\0');
  }
  return (
    value.leaseMode === 'job-exclusive' &&
    typeof value.ownerJobId === 'string' &&
    keys.join('\0') === ['fingerprint', 'instanceId', 'leaseMode', 'ownerJobId', 'provider'].join('\0')
  );
}

function entryMatchesHostRef(entry: ProviderHostEntry, hostRef: HostRef): boolean {
  return (
    entry.instanceId !== null &&
    entry.spec.provider === hostRef.provider &&
    hostFingerprintFromSpec(entry.spec) === hostRef.fingerprint &&
    entry.instanceId === hostRef.instanceId &&
    entry.spec.leaseMode === hostRef.leaseMode &&
    (hostRef.leaseMode !== 'job-exclusive' || entry.jobId === hostRef.ownerJobId)
  );
}

function waitForClose<Result>(operation: Promise<Result>, signal: AbortSignal | undefined): Promise<Result> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(new AbortError({ stage: 'provider_host_close_wait', reason: signal.reason }));
  }
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(new AbortError({ stage: 'provider_host_close_wait', reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Provider host close failed.', { cause: error }));
      },
    );
  });
}

function waitForAcquisitionOutcome(
  operation: Promise<ProviderProxySetAcquisitionOutcome>,
  signal: AbortSignal,
): Promise<ProviderProxySetAcquisitionOutcome> {
  if (signal.aborted) {
    return Promise.reject(
      new AbortError({ stage: 'provider_proxy_set_acquisition_cleanup_wait', reason: signal.reason }),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new AbortError({ stage: 'provider_proxy_set_acquisition_cleanup_wait', reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (outcome) => {
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Provider proxy set acquisition failed.', { cause: error }));
      },
    );
  });
}

const MAX_AUTOMATIC_RECLAMATION_ATTEMPTS = 3;
const AUTOMATIC_RECLAMATION_RETRY_DELAY_MS = 1_000;

type ProviderHostClosingRecord = Readonly<{
  ref: HostRef;
  operation: Promise<ProviderHostShutdownDisposition>;
  token: symbol;
  attempt: number;
  state: 'closing' | 'reclamation-failed' | 'shutdown-held';
  failure: Error | null;
  containment: RecordedContainmentIdentity | null;
  diagnostics: ProviderHostDiagnosticsSnapshot;
  shutdownHold: ProviderHostShutdownHold | null;
  holdSettlement: Promise<void> | null;
  resolveHoldSettlement: (() => void) | null;
}>;

type PendingProviderProxySetAcquisition = {
  readonly slotId: string;
  readonly outcome: Promise<ProviderProxySetAcquisitionOutcome>;
  readonly resolveOutcome: (outcome: ProviderProxySetAcquisitionOutcome) => void;
  readonly cleanupCompletion: Promise<ProviderProxySetAcquisitionCleanupOutcome>;
  readonly resolveCleanupCompletion: (outcome: ProviderProxySetAcquisitionCleanupOutcome) => void;
  cleanupHold: Extract<
    ProviderProxySetAcquisitionCleanupHold,
    { kind: 'provider_proxy_acquisition_pending_cleanup' }
  > | null;
  cleanupOwnerAccepted: boolean;
  settlement: Promise<void> | null;
  stop: Readonly<{ disposition: ProviderProxySetAcquisitionStopDisposition }> | null;
};

function reclamationFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error('Provider host reclamation failed.', { cause: error });
}

function isRetryableReclamationFailure(error: Error): boolean {
  if (!(error instanceof ProcessContainmentError)) return false;
  switch (error.code) {
    case 'process_containment_reap_failed':
      return true;
    case 'process_identity_unverified':
      return false;
  }
}

export class DefaultProviderHostManager
  implements ProviderHostManager, ProviderProxyAuthorityRegistry, ProviderProxySetRegistration
{
  private readonly entries = new Map<string, ProviderHostEntry>();
  private readonly admission: HostAdmissionCollection;
  private readonly pendingCloses = new Set<Promise<ProviderHostShutdownDisposition>>();
  private readonly pendingProxySetAcquisitions = new Set<PendingProviderProxySetAcquisition>();
  private readonly closingEntries = new Map<ProviderHostEntry, ProviderHostClosingRecord>();
  private readonly spawnCleanupHolds = new Set<ProviderHostSpawnCleanupObligation>();
  private readonly spawnCleanupRetryRequests = new Map<ProviderHostEntry, () => void>();
  /** Terminal eviction outcomes must remain replayable for the owning process's lifetime; earlier removal
   *  makes a lost reply unrecoverable. */
  private readonly terminalEvictions = new Map<string, ProviderHostTerminalEvictionDisposition>();
  private readonly lifecyclePolicies = new Map<string, string>();
  private nextProviderServerGeneration = 1;
  private acceptingAcquisitions = true;
  private readonly idleTimeoutMs: number;
  private readonly spawnProviderServer: SpawnProviderServerFn;
  private readonly allocateProviderServerGeneration: () => number;
  private readonly runtime: Runtime;
  private readonly reapContainment: ProviderHostContainmentReaper;
  private readonly carrierBlocksRetirement: (hostRef: HostRef) => boolean;
  private readonly proxySetAcquisitionConfig?: ProviderProxySetAcquisitionConfig;
  private readonly providerProxyLifecycleRef?: ProviderProxySetLifecycleRef;
  private readonly proxySetRotationEntries = new Map<string, ProviderHostEntry>();
  /** Abort cannot shorten an admitted handshake; `pendingProxySetAcquisitions` owns every later outcome. */
  private readonly proxySetAcquisitionStop = new AbortController();
  constructor(options: {
    runtime: Runtime;
    idleTimeoutMs?: number;
    spawnProviderServer: SpawnProviderServerFn;
    allocateProviderServerGeneration?: () => number;
    carrierBlocksRetirement: (hostRef: HostRef) => boolean;
    proxySetAcquisition?: ProviderProxySetAcquisitionConfig;
    providerProxyLifecycleRef?: ProviderProxySetLifecycleRef;
    admission?: HostAdmissionCollection;
    reapContainment?: ProviderHostContainmentReaper;
  }) {
    this.runtime = options.runtime;
    this.idleTimeoutMs = options.idleTimeoutMs ?? parseIdleTimeoutMs(this.runtime.env.get('CORAL_BROKER_IDLE_MS'));
    this.spawnProviderServer = options.spawnProviderServer;
    this.reapContainment = options.reapContainment ?? createProviderHostContainmentReaper(this.runtime);
    this.allocateProviderServerGeneration =
      options.allocateProviderServerGeneration ?? (() => this.nextProviderServerGeneration++);
    this.carrierBlocksRetirement = options.carrierBlocksRetirement;
    this.proxySetAcquisitionConfig = options.proxySetAcquisition;
    this.providerProxyLifecycleRef = options.providerProxyLifecycleRef;
    this.admission = options.admission ?? createHostAdmissionCollection({ classify: () => 'unknown' });
  }

  /** Every set acquired so far and not yet reaped, acquired or inherited alike — see
   *  `ProviderProxyAuthorityRegistry.liveSets()`'s own doc for what this snapshot does and does not promise. */
  liveSets(): readonly ProviderProxySetAuthority[] {
    return this.providerProxyLifecycleRef?.get()?.liveSets() ?? [];
  }

  cleanupObligations(): ProviderHostCleanupObligations {
    const lifecycle = this.providerProxyLifecycleRef?.get();
    return {
      liveProxySets: lifecycle?.liveSets() ?? [],
      acquisitionCleanupHolds: lifecycle?.acquisitionCleanupHolds() ?? [],
      representationReleaseHolds: lifecycle?.representationReleaseHolds() ?? [],
      closingHosts: [
        ...[...this.closingEntries.entries()].map(([entry, closing]): ProviderHostClosingObligation => {
          const label = `provider host ${entry.spec.provider} ${closing.ref.instanceId}`;
          const containment = entry.containment ?? closing.containment;
          const shutdownHold = closing.shutdownHold;
          if (shutdownHold !== null && containment !== null && closing.holdSettlement !== null) {
            const currentHold = (): ProviderHostShutdownHold => {
              const current = this.closingEntries.get(entry)?.shutdownHold;
              if (current === null || current === undefined) {
                throw new Error('provider_host_shutdown_hold_settled');
              }
              return current;
            };
            return {
              kind: 'provider-server-shutdown-held',
              label,
              containment,
              settlement: closing.holdSettlement,
              inspect: currentHold,
              operatorExit: {
                get kind() {
                  return currentHold().operatorExit.kind;
                },
                retry: () => currentHold().operatorExit.retry(),
              },
            };
          }
          return {
            label,
            containment,
            settlement: closing.operation.then(
              () => undefined,
              () => undefined,
            ),
          };
        }),
        ...this.spawnCleanupHolds,
      ],
    };
  }

  private retainProviderServerSpawnCleanup(
    entry: ProviderHostEntry,
    held: ProviderServerFailedSpawnCleanupHold,
  ): ProviderServerFailedSpawnCleanupAcceptance {
    let current = held;
    entry.spawnCleanupHold = current;
    entry.spawnCleanupDisposition = null;
    entry.spawnCleanupAttempts = 1;
    let requestRetry!: () => void;
    const retryRequested = new Promise<void>((resolve) => {
      requestRetry = resolve;
    });
    this.spawnCleanupRetryRequests.set(entry, requestRetry);
    const terminal = Promise.resolve().then(async (): Promise<ProviderServerFailedSpawnCleanupTerminalDisposition> => {
      try {
        while (true) {
          await Promise.race([
            current.settled,
            this.runtime.time.sleep(AUTOMATIC_RECLAMATION_RETRY_DELAY_MS),
            retryRequested,
          ]);
          if (entry.spawnCleanupDisposition !== null) return entry.spawnCleanupDisposition;
          let cleanup: ProviderServerFailedSpawnCleanupDisposition;
          try {
            cleanup = await current.retry();
          } catch {
            await this.runtime.time.sleep(AUTOMATIC_RECLAMATION_RETRY_DELAY_MS);
            continue;
          }
          if (cleanup.kind === 'observed-absent') {
            entry.spawnCleanupDisposition = cleanup;
            return cleanup;
          }
          if (cleanup.kind === 'operator-abandoned') {
            if (!isAcceptedProviderServerOperatorAbandonment(current, cleanup)) {
              await this.runtime.time.sleep(AUTOMATIC_RECLAMATION_RETRY_DELAY_MS);
              continue;
            }
            entry.spawnCleanupDisposition = cleanup;
            return cleanup;
          }
          current = { ...cleanup, error: held.error };
          entry.spawnCleanupHold = current;
          entry.spawnCleanupAttempts += 1;
        }
      } finally {
        if (this.spawnCleanupRetryRequests.get(entry) === requestRetry) {
          this.spawnCleanupRetryRequests.delete(entry);
        }
        if (entry.spawnCleanupHold === current) entry.spawnCleanupHold = null;
        const settledObligation = [...this.spawnCleanupHolds].find((candidate) => candidate.settlement === settlement);
        if (settledObligation !== undefined) this.spawnCleanupHolds.delete(settledObligation);
      }
    });
    const settlement = terminal.then(() => undefined);
    const obligation: ProviderHostSpawnCleanupObligation = {
      kind: 'provider-server-spawn-cleanup-held',
      label: `provider host ${entry.spec.provider} failed spawn cleanup`,
      containment: null,
      settlement,
      inspect: () => current,
      operatorExit: held.operatorExit,
    };
    this.spawnCleanupHolds.add(obligation);
    return { kind: 'accepted', owner: 'provider-host-manager', settlement };
  }

  /** See `ProviderProxySetRegistration.registerInheritedSet()`'s interface doc for this seam's full contract. */
  registerInheritedSet(
    set: ProviderProxyOperationAuthority,
    publicationReceipt: PublicationReceipt,
    protection: ProviderProxySetProtection = 'protected',
  ): void {
    const lifecycle = this.providerProxyLifecycleRef?.get();
    if (lifecycle === null || lifecycle === undefined) {
      throw new Error('provider_proxy_set_lifecycle_not_connected');
    }
    if (!isProviderProxyOperationAuthority(set)) {
      throw new Error('provider_proxy_set_inherited_authority_not_durable');
    }
    lifecycle.registerInheritedSet(set, publicationReceipt, null, protection);
  }

  /** See the `ProviderHostManager.routeAppServerOperation()` interface doc for this seam's full contract. */
  routeAppServerOperation(spec: ProviderServerSpec): ProviderProxyOperationAuthority | null {
    return this.providerProxyLifecycleRef?.get()?.routeFor(hostKeyFromSpec(spec)) ?? null;
  }

  providerProxySlotReleased(routeKey: string): void {
    const rotationEntry = this.proxySetRotationEntries.get(routeKey);
    this.proxySetRotationEntries.delete(routeKey);
    if (!this.acceptingAcquisitions) return;
    const entry =
      rotationEntry ??
      [...this.entries.values()].find(
        (candidate) => candidate.identityKey === routeKey && candidate.closingError === null,
      );
    if (entry !== undefined) this.ensureProxySetFor(entry);
  }

  /**
   * Starts acquiring `entry`'s guardian/reaper/proxy set if one is not already live or in flight for it.
   * Fire-and-forget relative to the host lease. The manager retains the acquisition until its callback has
   * either published into the lifecycle or completed the stop disposition assigned by `stopAndClose`.
   */
  private ensureProxySetFor(entry: ProviderHostEntry): void {
    const config = this.proxySetAcquisitionConfig;
    const lifecycle = this.providerProxyLifecycleRef?.get();
    if (config === undefined || lifecycle === null || lifecycle === undefined) return;
    // The executable identity, so every job-exclusive entry of the same spec shares one set.
    const identityKey = entry.identityKey;
    if (lifecycle.routeFor(identityKey) !== null) return;
    const admission = lifecycle.beginFreshAcquisition(identityKey, {
      buildSetId: config.identity.buildSetId,
      hostFingerprint: hostFingerprintFromSpec(entry.spec),
    });
    if (admission.kind !== 'accepted') {
      if (admission.kind === 'capacity') {
        backendLog.warn(
          `Provider proxy set acquisition refused for ${entry.spec.provider} (${identityKey}): ${admission.code}`,
        );
      }
      return;
    }
    let resolveOutcome!: (outcome: ProviderProxySetAcquisitionOutcome) => void;
    const outcome = new Promise<ProviderProxySetAcquisitionOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolveCleanupCompletion!: (outcome: ProviderProxySetAcquisitionCleanupOutcome) => void;
    const cleanupCompletion = new Promise<ProviderProxySetAcquisitionCleanupOutcome>((resolve) => {
      resolveCleanupCompletion = resolve;
    });
    const pending: PendingProviderProxySetAcquisition = {
      slotId: admission.slotId,
      outcome,
      resolveOutcome,
      cleanupCompletion,
      resolveCleanupCompletion,
      cleanupHold: null,
      cleanupOwnerAccepted: false,
      settlement: null,
      stop: null,
    };
    let retrying: Promise<ProviderProxySetAcquisitionCleanupOutcome> | null = null;
    const cleanupHold: Extract<
      ProviderProxySetAcquisitionCleanupHold,
      { kind: 'provider_proxy_acquisition_pending_cleanup' }
    > = {
      kind: 'provider_proxy_acquisition_pending_cleanup',
      owner: 'provider-host-manager',
      target: identityKey,
      reason: 'provider host manager stopped before acquisition settled',
      recoveryCapability: {
        retry: (signal) => {
          if (retrying !== null) return retrying;
          retrying = (async () => {
            let acquired: ProviderProxySetAcquisitionOutcome;
            try {
              acquired = await waitForAcquisitionOutcome(pending.outcome, signal);
              const stop = pending.stop;
              if (stop === null) {
                throw new Error('provider_proxy_set_acquisition_cleanup_disposition_missing');
              }
              if (acquired.kind === 'handed-over' && stop.disposition === 'contain') {
                const acceptance = lifecycle.acquisitionPublicationUnknown(admission.slotId, acquired, (set) =>
                  this.observeGenerationCapacity(identityKey, entry, set),
                );
                if (acceptance.owner !== 'provider-proxy-set-lifecycle') {
                  throw new Error('provider_proxy_set_acquisition_cleanup_owner_not_accepted');
                }
                const held = { kind: 'held' as const, reason: 'containment ownership transferred for recovery' };
                pending.resolveCleanupCompletion(held);
                return held;
              }
              const disposition = await disposeStoppedProviderProxySetAcquisition(acquired, stop.disposition, signal);
              if (disposition.kind === 'held') {
                pending.resolveCleanupCompletion(disposition);
                return disposition;
              }
              if (disposition.kind === 'transfer-required') {
                const acceptance =
                  disposition.acquisition.kind === 'acquired'
                    ? lifecycle.acquisitionSucceeded(
                        admission.slotId,
                        this.observeGenerationCapacity(identityKey, entry, disposition.acquisition.set),
                        disposition.acquisition.publicationReceipt,
                      )
                    : lifecycle.acquisitionPublicationUnknown(admission.slotId, disposition.acquisition, (set) =>
                        this.observeGenerationCapacity(identityKey, entry, set),
                      );
                if (acceptance.owner !== disposition.successor) {
                  throw new Error('provider_proxy_set_acquisition_cleanup_owner_not_accepted');
                }
                const delegated = { kind: 'delegated' as const, owner: acceptance.owner };
                pending.resolveCleanupCompletion(delegated);
                return delegated;
              }
              lifecycle.acquisitionCleanupConfirmed(admission.slotId, cleanupHold, disposition);
              pending.resolveCleanupCompletion(disposition);
              return disposition;
            } catch (error: unknown) {
              const held = {
                kind: 'held' as const,
                reason: error instanceof Error ? error.message : String(error),
              };
              pending.resolveCleanupCompletion(held);
              return held;
            }
          })().finally(() => {
            retrying = null;
          });
          return retrying;
        },
      },
    };
    pending.cleanupHold = cleanupHold;
    this.pendingProxySetAcquisitions.add(pending);
    const settlement = Promise.resolve(
      ensureProviderProxySet(
        entry,
        {
          runtime: this.runtime,
          signal: this.proxySetAcquisitionStop.signal,
          ...config,
          acceptHold: (hold) => lifecycle.persistAcquisitionCleanupHold(admission.slotId, hold),
        },
        async (outcome) => {
          pending.resolveOutcome(outcome);
          if (pending.stop !== null) {
            const cleanup = await pending.cleanupCompletion;
            if (cleanup.kind === 'held') throw new Error(cleanup.reason);
            return;
          }
          if (outcome.kind === 'acquired') {
            const set = this.observeGenerationCapacity(identityKey, entry, outcome.set);
            const acceptance = lifecycle.acquisitionSucceeded(admission.slotId, set, outcome.publicationReceipt);
            if (acceptance.owner !== 'provider-proxy-set-lifecycle') {
              throw new Error('provider_proxy_set_acquisition_owner_not_accepted');
            }
            return;
          }
          if (outcome.kind === 'handed-over') {
            const acceptance = lifecycle.acquisitionPublicationUnknown(admission.slotId, outcome, (set) =>
              this.observeGenerationCapacity(identityKey, entry, set),
            );
            if (acceptance.owner !== 'provider-proxy-set-lifecycle') {
              throw new Error('provider_proxy_set_acquisition_owner_not_accepted');
            }
            return;
          }
          if (outcome.kind === 'provider_proxy_acquisition_held') {
            const acceptance = lifecycle.acquisitionCleanupHeld(admission.slotId, outcome);
            if (acceptance.owner !== 'provider-proxy-set-lifecycle') {
              throw new Error('provider_proxy_set_acquisition_cleanup_owner_not_accepted');
            }
            return;
          }
          if (outcome.kind === 'outcome-unknown') {
            const acceptance = lifecycle.acquisitionCleanupPending(admission.slotId, cleanupHold);
            if (acceptance.kind !== 'accepted' || acceptance.owner !== 'provider-proxy-set-lifecycle') {
              throw new Error('provider_proxy_set_acquisition_cleanup_owner_not_accepted');
            }
            pending.stop = { disposition: 'contain' };
            pending.cleanupOwnerAccepted = true;
            return;
          }
          lifecycle.acquisitionFailed(admission.slotId);
          const strandedArtifacts =
            outcome.strandedArtifacts.length === 0
              ? ''
              : `; stranded artifacts: ${outcome.strandedArtifacts.join(', ')}`;
          backendLog.warn(
            `Provider proxy set acquisition failed for ${entry.spec.provider} (${identityKey}): ${outcome.reason}${strandedArtifacts}`,
          );
        },
      ),
    );
    pending.settlement = settlement;
    void settlement.then(
      () => this.pendingProxySetAcquisitions.delete(pending),
      (error: unknown) => {
        if (pending.cleanupOwnerAccepted) this.pendingProxySetAcquisitions.delete(pending);
        backendLog.warn(
          `Provider proxy set acquisition settlement failed for ${entry.spec.provider} (${identityKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  }

  private observeGenerationCapacity(
    identityKey: string,
    entry: ProviderHostEntry,
    set: ProviderProxyOperationAuthority,
  ): DurableProviderProxyOperationAuthority {
    if (!isProviderProxyOperationAuthority(set)) {
      throw new Error('provider_proxy_set_acquired_authority_not_durable');
    }
    const observed: DurableProviderProxyOperationAuthority = {
      ...set,
      promoteControl: async (redemption, signal) =>
        this.observeGenerationCapacity(identityKey, entry, await set.promoteControl(redemption, signal)),
      prepareOperation: async (attempt) => {
        const result = await set.prepareOperation(attempt);
        if (result.state === 'capacity' && result.code === 'provider_root_generation_draining') {
          const lifecycle = this.providerProxyLifecycleRef?.get();
          if (lifecycle?.routeFor(identityKey) === observed) {
            this.proxySetRotationEntries.set(identityKey, entry);
            lifecycle.beginGracefulDrain(observed.setIdentity);
          }
        }
        return result;
      },
    };
    return observed;
  }

  private async acquireHostLease(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
    admission?: Readonly<{ slot: AdmissionSlotKey; reservation: HostAdmissionReservation }>,
  ): Promise<Readonly<{ lease: ProviderServerLease; entry: ProviderHostEntry }>> {
    if (!this.acceptingAcquisitions) {
      throw new Error('provider_host_draining: provider host manager no longer accepts acquisitions');
    }
    if (options?.signal !== undefined) {
      throwIfAborted(options.signal, 'provider_host_acquire');
    }
    assertProviderHostPolicy(spec);
    if (spec.leaseMode === 'job-exclusive' && options?.jobId === undefined) {
      throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
    }
    const exactEnv = compileLaunchEnvironment(spec, this.runtime.env.platform());
    const entry = this.getOrCreateProviderServerEntry(spec, exactEnv, options?.jobId);
    this.clearIdleTimer(entry);
    const releasePin = acquireProviderHostPin(
      entry,
      {
        kind: 'acquisition',
        ...(options?.jobId === undefined ? {} : { jobId: options.jobId }),
      },
      () => this.onLastRelease(entry),
    );
    this.maybeArmIdleTimer(entry);

    try {
      this.ensureProxySetFor(entry);
      const handle = await ensureProviderServerHandle(entry, {
        spawnProviderServer: (nextSpec) => {
          if (admission === undefined) {
            throw new Error('provider_host_admission_missing: fresh placement requires an admission reservation');
          }
          const hostRef = hostRefFromEntry(entry);
          const generation = this.allocateProviderServerGeneration();
          let spawnedHandle: ProviderServerHandle | null = null;
          admission.reservation.reserveCandidate({
            slot: admission.slot,
            ref: hostRef,
            generation,
            spec: canonicalProviderHostSpecMetadata(entry.spec),
            host: Object.freeze({
              owner: 'coordinator',
              hostKey: entry.hostKey,
              identityKey: entry.identityKey,
              ownerJobId: entry.jobId ?? null,
            }),
            inspectDiagnostics: () => spawnedHandle?.inspectDiagnostics() ?? emptyDiagnostics(),
          });
          const spawnSignal =
            nextSpec.leaseMode === 'job-exclusive' && options?.signal !== undefined
              ? AbortSignal.any([options.signal, this.proxySetAcquisitionStop.signal])
              : this.proxySetAcquisitionStop.signal;
          const spawned = this.spawnProviderServer(
            {
              provider: nextSpec.provider,
              command: nextSpec.command,
              args: nextSpec.args,
              cwd: nextSpec.cwd,
              exactEnv: entry.exactEnv,
              signal: spawnSignal,
              initializeRequest: nextSpec.initializeRequest,
              initializeTimeoutMs: nextSpec.initializeTimeoutMs,
            },
            (fact) => this.admission.observe(admission.slot, hostRef, fact),
            generation,
            (containment) => {
              entry.containment = containment;
              return PROVIDER_CONTAINMENT_ACCEPTED;
            },
            (hold) => this.retainProviderServerSpawnCleanup(entry, hold),
          );
          void spawned.then(
            (disposition) => {
              if (!('kind' in disposition)) spawnedHandle = disposition;
            },
            () => {},
          );
          return spawned;
        },
        closeEntry: (nextEntry, detail) => this.closeProviderServerEntry(nextEntry, detail, { confirmAbsence: true }),
        attachHostNotificationListener: (nextEntry, handle) => this.attachHostNotificationListener(nextEntry, handle),
        createInstanceId: () => this.runtime.ids.uuid(),
        observeRetired: (nextEntry, instanceId) => {
          if (nextEntry.instanceId !== instanceId) return;
          this.admission.observeRetired(hostRefFromEntry(nextEntry), 'closed');
        },
        abandonUninstalled: (nextEntry, instanceId) => {
          if (nextEntry.instanceId !== instanceId) return;
          this.admission.abandon(hostRefFromEntry(nextEntry));
        },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (options?.signal !== undefined) {
        throwIfAborted(options.signal, 'provider_host_acquire_complete');
      }
      if (
        !this.acceptingAcquisitions ||
        this.entries.get(entry.hostKey) !== entry ||
        entry.closingError !== null ||
        entry.handle !== handle
      ) {
        const cause = entry.closingError;
        throw cause === null
          ? new Error('provider_host_draining: provider host acquisition lost drain race')
          : new Error(`provider_host_draining: ${cause.message}`, { cause });
      }
      admission?.reservation.markLive(hostRefFromEntry(entry), handle.generation);
      return Object.freeze({
        lease: createProviderServerLease(handle, releasePin),
        entry,
      });
    } catch (error) {
      releasePin();
      throw error;
    }
  }

  async openSession(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ManagedAppServerSession> {
    if (!this.acceptingAcquisitions) {
      throw new Error('provider_host_draining: provider host manager no longer accepts acquisitions');
    }
    if (options?.signal !== undefined) throwIfAborted(options.signal, 'provider_host_acquire');
    const slot = this.admissionSlotFor(spec, options?.jobId);
    try {
      return await this.admission.withFreshPlacement(slot, async (reservation) => {
        this.assertAdmissionSlotNotClosing(slot);
        const { lease, entry } = await this.acquireHostLease(spec, options, { slot, reservation });
        return this.managedSession(lease, hostRefFromEntry(entry));
      });
    } catch (error: unknown) {
      // Admission refuses blocked candidates before invoking the placement delegate. Rechecking the retained
      // close record translates that ordering into the lifecycle identity callers need during reclamation.
      this.assertAdmissionSlotNotClosing(slot);
      throw error;
    }
  }

  async attachSession(
    hostRef: HostRef,
    expectation: Readonly<{ spec: ProviderServerSpec; jobId: string }>,
  ): Promise<ManagedAppServerSession | null> {
    if (!this.acceptingAcquisitions || !isExactHostRef(hostRef)) return null;
    if (
      expectation.spec.provider !== hostRef.provider ||
      expectation.spec.leaseMode !== hostRef.leaseMode ||
      hostFingerprintFromSpec(expectation.spec) !== hostRef.fingerprint ||
      (hostRef.leaseMode === 'job-exclusive' && hostRef.ownerJobId !== expectation.jobId)
    ) {
      return null;
    }
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.spec.provider === hostRef.provider &&
        hostFingerprintFromSpec(entry.spec) === hostRef.fingerprint &&
        entry.spec.leaseMode === hostRef.leaseMode &&
        entry.instanceId === hostRef.instanceId &&
        (hostRef.leaseMode !== 'job-exclusive' || entry.jobId === hostRef.ownerJobId) &&
        entry.closingError === null,
    );
    if (candidates.length !== 1) return null;
    const handle = candidates[0]?.handle;
    if (handle === null || handle === undefined || handle.isClosed()) return null;
    const entry = candidates[0];
    if (entry === undefined) return null;
    this.clearIdleTimer(entry);
    const releasePin = acquireProviderHostPin(entry, { kind: 'attached-session' }, () => this.onLastRelease(entry));
    this.maybeArmIdleTimer(entry);
    return Object.freeze({
      session: createProviderServerAttachment(handle),
      hostRef,
      close: releasePin,
    });
  }

  private managedSession(lease: ProviderServerLease, hostRef: HostRef): ManagedAppServerSession {
    return Object.freeze({
      session: Object.freeze({
        rpc: <Result = unknown>(method: string, params: Record<string, unknown>) =>
          this.admission.correlateTerminalFailure(hostRef, () => lease.rpc<Result>(method, params)),
        subscribe: lease.subscribe.bind(lease),
        closed: lease.closed,
      }),
      hostRef,
      close: () => lease.release(),
    });
  }

  admissionSnapshot(): HostAdmissionSnapshot {
    return this.admission.snapshot();
  }

  listProviderHosts(): readonly ProviderHostInventoryRecord[] {
    const snapshot = this.admission.snapshot();
    const closingRecords = [...this.closingEntries.entries()];
    const isClosing = (ref: HostRef): boolean =>
      closingRecords.some(([, closing]) => exactHostRefsMatch(closing.ref, ref));
    const records: ProviderHostInventoryRecord[] = [];
    for (const admissionEntry of snapshot.state.values()) {
      if (admissionEntry.phase === 'spawning') {
        const matches = [...this.entries.values()].filter((entry) => entryMatchesHostRef(entry, admissionEntry.ref));
        const entry = matches.length === 1 ? matches[0] : undefined;
        const hold = entry?.spawnCleanupHold;
        if (entry === undefined || hold === null || hold === undefined) continue;
        const processGroup =
          hold.subject.kind === 'process-group'
            ? { pid: hold.subject.processGroupId, processGroupId: hold.subject.processGroupId }
            : {};
        records.push(
          Object.freeze({
            ref: admissionEntry.ref,
            status: 'reclamation-failed',
            spec: canonicalProviderHostSpecMetadata(entry.spec),
            host: Object.freeze({
              owner: 'coordinator',
              hostKey: entry.hostKey,
              identityKey: entry.identityKey,
              ownerJobId: entry.jobId ?? null,
              ...processGroup,
              reclamationAttempts: entry.spawnCleanupAttempts,
              reclamationFailure: hold.error.message,
              reclamationRetryable: true,
            }),
            diagnostics: emptyDiagnostics(),
            diagnosticsRetention: Object.freeze({ ownerBudgetTruncated: false }),
          }),
        );
        continue;
      }
      if (admissionEntry.phase === 'retired-blocked') continue;
      if (isClosing(admissionEntry.ref)) continue;
      const matches = [...this.entries.values()].filter((entry) => entryMatchesHostRef(entry, admissionEntry.ref));
      if (matches.length !== 1) {
        throw new Error('provider_host_inventory_unavailable: live coordinator host could not be revalidated');
      }
      const entry = matches[0];
      const handle = entry.handle;
      if (handle === null) {
        throw new Error('provider_host_inventory_unavailable: live coordinator host process is unavailable');
      }
      if (handle.isClosed()) continue;
      records.push(
        Object.freeze({
          ref: admissionEntry.ref,
          status: 'live',
          spec: canonicalProviderHostSpecMetadata(entry.spec),
          host: Object.freeze({
            owner: 'coordinator',
            hostKey: entry.hostKey,
            identityKey: entry.identityKey,
            ownerJobId: entry.jobId ?? null,
          }),
          diagnostics: handle.inspectDiagnostics(),
          diagnosticsRetention: Object.freeze({ ownerBudgetTruncated: false }),
        }),
      );
    }
    records.push(
      ...snapshot.tombstones
        .filter((tombstone) => !isClosing(tombstone.ref))
        .map((tombstone) =>
          Object.freeze({
            ref: tombstone.ref,
            status: tombstone.phase,
            spec: tombstone.spec,
            host: tombstone.host,
            diagnostics: tombstone.diagnostics,
            diagnosticsRetention: tombstone.diagnosticsRetention,
          }),
        ),
    );
    for (const [entry, closing] of closingRecords) {
      if (closing.state === 'shutdown-held' && closing.shutdownHold !== null) {
        const containment = entry.containment ?? closing.containment;
        if (containment === null) continue;
        records.push(
          Object.freeze({
            ref: closing.ref,
            status: 'shutdown-held',
            spec: canonicalProviderHostSpecMetadata(entry.spec),
            host: Object.freeze({
              owner: 'coordinator',
              hostKey: entry.hostKey,
              identityKey: entry.identityKey,
              ownerJobId: entry.jobId ?? null,
              pid: containment.pid,
              processGroupId: containment.processGroupId,
              observation: closing.shutdownHold.observation,
              successorOwner: closing.shutdownHold.successor?.owner ?? null,
              operatorExit: closing.shutdownHold.operatorExit.kind,
            }),
            diagnostics: closing.diagnostics,
            diagnosticsRetention: Object.freeze({ ownerBudgetTruncated: false }),
          }),
        );
        continue;
      }
      if (closing.state !== 'reclamation-failed' || closing.failure === null) continue;
      const containment = entry.containment ?? closing.containment;
      records.push(
        Object.freeze({
          ref: closing.ref,
          status: 'reclamation-failed',
          spec: canonicalProviderHostSpecMetadata(entry.spec),
          host: Object.freeze({
            owner: 'coordinator',
            hostKey: entry.hostKey,
            identityKey: entry.identityKey,
            ownerJobId: entry.jobId ?? null,
            ...(containment === null ? {} : { pid: containment.pid, processGroupId: containment.processGroupId }),
            reclamationAttempts: closing.attempt,
            reclamationFailure: closing.failure.message,
            reclamationRetryable: isRetryableReclamationFailure(closing.failure),
          }),
          diagnostics: closing.diagnostics,
          diagnosticsRetention: Object.freeze({ ownerBudgetTruncated: false }),
        }),
      );
    }
    return Object.freeze(records);
  }

  inspectProviderHost(hostRef: HostRef): ProviderHostInventoryRecord | null {
    if (!isExactHostRef(hostRef)) return null;
    const matches = this.listProviderHosts().filter((record) => exactHostRefsMatch(record.ref, hostRef));
    if (matches.length > 1) {
      throw new Error('provider_host_identity_integrity: exact host ref matched multiple coordinator records');
    }
    return matches[0] ?? null;
  }

  async evictHost(hostRef: HostRef): Promise<ProviderHostEvictionDisposition> {
    if (!isExactHostRef(hostRef)) return { kind: 'stale' };
    const terminal = this.terminalEvictions.get(exactHostRefIdentityKey(hostRef));
    if (terminal !== undefined) return terminal;
    const liveMatches = [...this.entries.values()].filter((entry) => entryMatchesHostRef(entry, hostRef));
    const closingMatches = [...this.closingEntries.entries()].filter(([, closing]) =>
      exactHostRefsMatch(closing.ref, hostRef),
    );
    const matchedEntries = new Set([...liveMatches, ...closingMatches.map(([entry]) => entry)]);
    if (matchedEntries.size > 1) {
      throw new Error('provider_host_identity_integrity: exact host ref matched multiple coordinator entries');
    }
    const matched = matchedEntries.values().next().value;
    if (matched !== undefined) {
      const spawnCleanup = matched.spawnCleanupHold;
      if (spawnCleanup !== null) {
        const settlement = matched.spawnPromise;
        const abandonment = await spawnCleanup.operatorExit.abandon();
        const accepted = isAcceptedProviderServerOperatorAbandonment(spawnCleanup, abandonment);
        if (accepted) {
          const retained = this.retainTerminalEviction(hostRef, abandonment);
          matched.spawnCleanupDisposition = abandonment;
          this.spawnCleanupRetryRequests.get(matched)?.();
          if (settlement !== null) await settlement.catch(() => undefined);
          return retained;
        }
        return {
          kind: 'held',
          observation: spawnCleanup.observation,
          successorOwner: null,
          operatorExit: spawnCleanup.operatorExit.kind,
        };
      }
      const shutdown = await this.closeProviderServerEntry(matched, 'evicted by operator', { confirmAbsence: true });
      if (shutdown.kind !== 'observed-absent') {
        return {
          kind: 'held',
          observation: shutdown.observation,
          successorOwner: shutdown.successor?.owner ?? null,
          operatorExit: shutdown.operatorExit.kind,
        };
      }
      const disposition = { kind: 'evicted' } as const;
      const retained = this.retainTerminalEviction(hostRef, disposition);
      this.admission.confirmEvicted(hostRef);
      return retained;
    }

    const tombstones = this.admission
      .snapshot()
      .tombstones.filter(
        (tombstone) => tombstone.retirement.processAbsent && exactHostRefsMatch(tombstone.ref, hostRef),
      );
    if (tombstones.length !== 1) return { kind: 'stale' };
    const disposition = { kind: 'evicted' } as const;
    const retained = this.retainTerminalEviction(hostRef, disposition);
    this.admission.confirmEvicted(hostRef);
    return retained;
  }

  private retainTerminalEviction<Disposition extends ProviderHostTerminalEvictionDisposition>(
    hostRef: HostRef,
    disposition: Disposition,
  ): Disposition {
    const key = exactHostRefIdentityKey(hostRef);
    const retained = this.terminalEvictions.get(key);
    if (retained !== undefined) {
      if (retained.kind !== disposition.kind) {
        throw new Error('provider_host_identity_integrity: exact host ref acquired conflicting terminal outcomes');
      }
      return retained as Disposition;
    }
    this.terminalEvictions.set(key, disposition);
    return disposition;
  }

  async drainForHandoff(signal?: AbortSignal): Promise<ProviderHostQuiescenceReceipt> {
    return this.stopAndClose('drained', 'handoff', signal);
  }

  async shutdown(signal?: AbortSignal): Promise<ProviderHostQuiescenceReceipt> {
    return this.stopAndClose('shut down', 'contain', signal);
  }

  private async stopAndClose(
    detail: string,
    disposition: ProviderProxySetAcquisitionStopDisposition,
    signal?: AbortSignal,
  ): Promise<ProviderHostQuiescenceReceipt> {
    this.acceptingAcquisitions = false;
    const acquisitionsToSettle = [...this.pendingProxySetAcquisitions];
    for (const pending of acquisitionsToSettle) {
      if (pending.stop !== null || pending.cleanupHold === null) continue;
      const lifecycle = this.providerProxyLifecycleRef?.get();
      if (lifecycle === null || lifecycle === undefined) {
        throw new Error('provider_proxy_set_lifecycle_not_connected');
      }
      const acceptance = lifecycle.acquisitionCleanupPending(pending.slotId, pending.cleanupHold);
      if (acceptance.kind !== 'accepted') continue;
      if (acceptance.owner !== 'provider-proxy-set-lifecycle') {
        throw new Error('provider_proxy_set_acquisition_cleanup_owner_not_accepted');
      }
      pending.stop = { disposition };
      pending.cleanupOwnerAccepted = true;
    }
    this.proxySetAcquisitionStop.abort();
    const reclamationAttempt = new AbortController();
    const stopReclamation = (): void => reclamationAttempt.abort(signal?.reason);
    if (signal?.aborted) stopReclamation();
    else signal?.addEventListener('abort', stopReclamation, { once: true });
    try {
      const closeOptions = { signal: reclamationAttempt.signal, confirmAbsence: true };
      const entriesToClose = new Set([...this.entries.values(), ...this.closingEntries.keys()]);
      const pendingBeforeClose = [...this.pendingCloses];
      const outcomes = await Promise.allSettled([
        ...[...entriesToClose].map((entry) => this.closeProviderServerEntry(entry, detail, closeOptions)),
        ...pendingBeforeClose.map((operation) => waitForClose(operation, signal)),
        ...acquisitionsToSettle.flatMap((pending) =>
          pending.settlement === null ? [] : [waitForClose(pending.settlement, signal)],
        ),
      ]);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return {
        kind: 'provider-hosts-quiesced',
        ...this.cleanupObligations(),
      };
    } finally {
      signal?.removeEventListener('abort', stopReclamation);
    }
  }

  private getOrCreateProviderServerEntry(
    spec: ProviderServerSpec,
    exactEnv: Readonly<Record<string, string>>,
    jobId: string | undefined,
  ): ProviderHostEntry {
    const identityKey = hostKeyFromSpec(spec);
    const requestedPolicy = spec.leaseMode === 'shared' ? `${spec.leaseMode}:${spec.idleRetirement}` : spec.leaseMode;
    const existingPolicy = this.lifecyclePolicies.get(identityKey);
    if (existingPolicy !== undefined && existingPolicy !== requestedPolicy) {
      throw new Error(
        `provider_host_policy_conflict: executable identity requested as '${requestedPolicy}' after '${existingPolicy}'`,
      );
    }
    this.lifecyclePolicies.set(identityKey, requestedPolicy);
    const hostKey = spec.leaseMode === 'shared' ? identityKey : `${identityKey}\u0000job-${jobId ?? ''}`;
    const existing = this.entries.get(hostKey);
    if (existing) return existing;

    const created: ProviderHostEntry = {
      hostKey,
      identityKey,
      spec: cloneSpec(spec),
      exactEnv: Object.freeze({ ...exactEnv }),
      ...(spec.leaseMode === 'job-exclusive' && jobId !== undefined ? { jobId } : {}),
      handle: null,
      containment: null,
      instanceId: null,
      spawnPromise: null,
      spawnCleanupHold: null,
      spawnCleanupDisposition: null,
      spawnCleanupAttempts: 0,
      pins: new Map(),
      closingError: null,
      closePromise: null,
      hostStats: null,
      idleTimer: null,
      disposeHostNotifications: null,
    };
    this.entries.set(hostKey, created);
    return created;
  }

  private onLastRelease(entry: ProviderHostEntry): void {
    if (entry.closingError !== null) return;
    if (entry.spec.leaseMode === 'shared') {
      this.maybeArmIdleTimer(entry);
      return;
    }
    void this.closeProviderServerEntry(entry, 'job-exclusive host unpinned').catch(() => {});
  }

  reevaluateIdleRetirement(hostRef: HostRef): void {
    if (!isExactHostRef(hostRef)) return;
    const entry = [...this.entries.values()].find((candidate) => entryMatchesHostRef(candidate, hostRef));
    if (entry !== undefined) this.maybeArmIdleTimer(entry);
  }

  private attachHostNotificationListener(entry: ProviderHostEntry, handle: ProviderServerHandle): void {
    attachHostNotificationListener(entry, handle, {
      runtime: this.runtime,
      idleTimeoutMs: this.idleTimeoutMs,
      entries: this.entries,
      carrierBlocksRetirement: this.carrierBlocksRetirement,
      closeProviderServerEntry: (nextEntry, detail) => this.closeProviderServerEntry(nextEntry, detail),
    });
  }

  private maybeArmIdleTimer(entry: ProviderHostEntry): void {
    maybeArmIdleTimer(entry, {
      runtime: this.runtime,
      idleTimeoutMs: this.idleTimeoutMs,
      entries: this.entries,
      carrierBlocksRetirement: this.carrierBlocksRetirement,
      closeProviderServerEntry: (nextEntry, detail) => this.closeProviderServerEntry(nextEntry, detail),
    });
  }

  private clearIdleTimer(entry: ProviderHostEntry): void {
    clearIdleTimer(entry, this.runtime.time);
  }

  private admissionSlotFor(spec: ProviderServerSpec, jobId: string | undefined): AdmissionSlotKey {
    const fingerprint = hostFingerprintFromSpec(spec);
    if (spec.leaseMode === 'shared') return admissionSlotKey(fingerprint);
    if (jobId === undefined) {
      throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
    }
    return admissionSlotKey(`${fingerprint}\u0000job-${jobId}`);
  }

  private assertAdmissionSlotNotClosing(slot: AdmissionSlotKey): void {
    const match = [...this.closingEntries.entries()].find(
      ([entry]) => this.admissionSlotFor(entry.spec, entry.jobId) === slot,
    );
    if (match === undefined) return;
    const [entry, closing] = match;
    const cause = entry.closingError ?? closing.failure ?? new Error('Provider host reclamation is in progress.');
    throw new Error(`provider_host_draining: ${cause.message}`, { cause });
  }

  private async closeProviderServerEntry(
    entry: ProviderHostEntry,
    detail: string,
    options: { signal?: AbortSignal; confirmAbsence?: boolean } = {},
  ): Promise<ProviderHostShutdownDisposition> {
    if (entry.closePromise === null) {
      const priorClosing = this.closingEntries.get(entry);
      const ref = entry.instanceId === null ? (priorClosing?.ref ?? null) : hostRefFromEntry(entry);
      const token = Symbol('provider-host-close');
      const operation = this.closeWithReclamationRetries(entry, detail, token, options.signal);
      entry.closePromise = operation;
      this.pendingCloses.add(operation);
      if (ref !== null) {
        this.closingEntries.set(
          entry,
          Object.freeze({
            ref,
            operation,
            token,
            attempt: 1,
            state: 'closing',
            failure: null,
            containment: entry.containment ?? priorClosing?.containment ?? null,
            diagnostics: priorClosing?.diagnostics ?? entry.handle?.inspectDiagnostics() ?? emptyDiagnostics(),
            shutdownHold: priorClosing?.shutdownHold ?? null,
            holdSettlement: priorClosing?.holdSettlement ?? null,
            resolveHoldSettlement: priorClosing?.resolveHoldSettlement ?? null,
          }),
        );
      }
      void operation.then(
        (disposition) => {
          this.pendingCloses.delete(operation);
          const closing = this.closingEntries.get(entry);
          if (closing?.operation !== operation) return;
          if (disposition.kind !== 'observed-absent') {
            let holdSettlement = closing.holdSettlement;
            let resolveHoldSettlement = closing.resolveHoldSettlement;
            if (holdSettlement === null || resolveHoldSettlement === null) {
              holdSettlement = new Promise<void>((resolve) => {
                resolveHoldSettlement = resolve;
              });
            }
            this.closingEntries.set(
              entry,
              Object.freeze({
                ...closing,
                state: 'shutdown-held',
                shutdownHold: disposition,
                holdSettlement,
                resolveHoldSettlement,
              }),
            );
            if (entry.closePromise === operation) entry.closePromise = null;
            return;
          }
          closing.resolveHoldSettlement?.();
          this.closingEntries.delete(entry);
        },
        (error: unknown) => {
          const closing = this.closingEntries.get(entry);
          const failure = closing?.failure ?? reclamationFailure(error);
          if (closing?.operation === operation && closing.state !== 'reclamation-failed') {
            this.closingEntries.set(
              entry,
              Object.freeze({
                ...closing,
                state: 'reclamation-failed',
                failure,
                containment: entry.containment ?? closing.containment,
              }),
            );
          }
          const containment = entry.containment ?? closing?.containment ?? null;
          const pid = containment?.pid ?? entry.handle?.pid ?? 'unknown';
          const processGroupId = containment?.processGroupId ?? 'unrecorded';
          backendLog.error(
            `Provider host reclamation abandoned: provider=${entry.spec.provider} pid=${pid} pgid=${processGroupId} attempts=${closing?.attempt ?? 1} detail=${detail} failure=${failure.message}`,
            failure,
          );
          this.pendingCloses.delete(operation);
          if (entry.closePromise === operation) entry.closePromise = null;
        },
      );
    }
    const operation = entry.closePromise;
    return waitForClose(operation, options.signal);
  }

  private async closeWithReclamationRetries(
    entry: ProviderHostEntry,
    detail: string,
    token: symbol,
    signal?: AbortSignal,
  ): Promise<ProviderHostShutdownDisposition> {
    for (let attempt = 1; attempt <= MAX_AUTOMATIC_RECLAMATION_ATTEMPTS; attempt += 1) {
      if (signal !== undefined) throwIfAborted(signal, 'provider_host_reclamation');
      try {
        const disposition = await closeEntry(entry, detail, {
          runtime: this.runtime,
          entries: this.entries,
          shutdownHandle: (handle, spec, containment, closeSignal) =>
            this.shutdownHandle(handle, spec, containment, closeSignal),
          reapContainment: this.reapContainment,
          ...(signal === undefined ? {} : { signal }),
        });
        if (disposition.kind === 'observed-absent') return disposition;
        const retry = (): Promise<ProviderHostShutdownDisposition> =>
          this.closeProviderServerEntry(entry, detail, { confirmAbsence: true });
        return {
          ...disposition,
          retry,
          operatorExit: { ...disposition.operatorExit, retry },
        };
      } catch (error: unknown) {
        const failure = reclamationFailure(error);
        const closing = this.closingEntries.get(entry);
        if (closing?.token === token) {
          this.closingEntries.set(
            entry,
            Object.freeze({
              ...closing,
              attempt,
              state: 'reclamation-failed',
              failure,
              containment: entry.containment ?? closing.containment,
            }),
          );
        }
        if (!isRetryableReclamationFailure(failure) || attempt === MAX_AUTOMATIC_RECLAMATION_ATTEMPTS) {
          throw failure;
        }
        await this.runtime.time.sleep(AUTOMATIC_RECLAMATION_RETRY_DELAY_MS, signal === undefined ? {} : { signal });
        if (signal !== undefined) throwIfAborted(signal, 'provider_host_reclamation_retry');
        const retrying = this.closingEntries.get(entry);
        if (retrying?.token === token) {
          this.closingEntries.set(
            entry,
            Object.freeze({ ...retrying, attempt: attempt + 1, state: 'closing', failure: null }),
          );
        }
      }
    }
    throw new Error('provider_host_reclamation_attempts_exhausted');
  }

  private async shutdownHandle(
    handle: ContainedProviderServerHandle,
    spec: ProviderServerSpec,
    containment: ContainedProviderServerHandle['containmentIdentity'],
    signal?: AbortSignal,
  ): Promise<ProviderHostShutdownDisposition> {
    return shutdownHandle(handle, spec, containment, this.runtime.time, this.reapContainment, signal);
  }
}

export function createProviderHostManager(options: {
  runtime: Runtime;
  idleTimeoutMs?: number;
  spawnProviderServer: SpawnProviderServerFn;
  admission: HostAdmissionCollection;
  allocateProviderServerGeneration?: () => number;
  carrierBlocksRetirement: (hostRef: HostRef) => boolean;
  proxySetAcquisition?: ProviderProxySetAcquisitionConfig;
  providerProxyLifecycleRef?: ProviderProxySetLifecycleRef;
}): ProviderHostManager &
  ProviderHostRetirementReevaluation &
  ProviderHostAdministrationAuthority &
  ProviderProxyAuthorityRegistry &
  ProviderProxySetRegistration {
  return new DefaultProviderHostManager(options);
}

function emptyDiagnostics(): ProviderHostDiagnosticsSnapshot {
  return Object.freeze({
    hostLog: Object.freeze({ entries: Object.freeze([]), retainedBytes: 0, truncatedBeforeSeq: 0 }),
    completedObservations: Object.freeze([]),
    factsTruncatedBeforeSeq: 0,
  });
}
