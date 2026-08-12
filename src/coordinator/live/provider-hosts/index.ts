import type { AppServerTransport, HostRef, ProviderServerSpec } from '../../../providers/contract.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '../../../providers/app-server-transport.js';
import type { ProviderHostDiagnosticsSnapshot } from '../../../providers/host-diagnostics.js';
import type { ProviderHostInventoryRecord } from '../../services/provider-host-administration.js';
import {
  admissionSlotKey,
  canonicalProviderHostSpecMetadata,
  exactHostRefsMatch,
  type AdmissionSlotKey,
  type HostAdmissionReservation,
  type HostAdmissionSnapshot,
} from '../../../providers/host-admission.js';
import type { Runtime } from '../../../runtime/ports.js';
import { backendLog } from '../../../infra/backend-log.js';
import {
  acquireProviderHostPin,
  createProviderServerAttachment,
  createProviderServerLease,
  releaseProviderHostPin,
  type ProviderServerLease,
} from './lease.js';
import { attachHostNotificationListener, clearIdleTimer, maybeArmIdleTimer, parseIdleTimeoutMs } from './idle.js';
import { closeAllProviderServerEntries, closeProviderServerEntry as closeEntry, shutdownHandle } from './drain.js';
import { cloneSpec, ensureProviderServerHandle } from './recovery.js';
import { ensureProviderProxySet, type ProviderProxySetAcquisitionConfig } from './proxy-set-acquisition.js';
import { hostFingerprintFromSpec, hostKeyFromSpec, hostRefFromEntry, type ProviderHostEntry } from './state.js';
import { AbortError, throwIfAborted } from '../../../runtime/abort.js';
import type { ProviderProxyAuthorityRegistry, ProviderProxySetAuthority } from '../provider-proxy/authority.js';
import {
  isProviderProxyOperationAuthority,
  type DurableProviderProxyOperationAuthority,
  type ProviderProxyOperationAuthority,
} from '../provider-proxy/operation-route.js';
import type { ProviderProxySetLifecycleRef } from '../../services/provider-proxy-set-lifecycle-ref.js';
import { createCoordinatorProviderHostAdmission } from '../provider-host-admission.js';
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
  drainForHandoff(signal?: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
  /**
   * The live proxy set's operation-routing capability for `spec`'s executable identity, or `null` when no
   * set is live for it yet. Never triggers or waits on an acquisition — that stays fire-and-forget, started
   * the first time a session is actually acquired for this identity (see `ensureProxySetFor`).
   */
  routeAppServerOperation(spec: ProviderServerSpec): ProviderProxyOperationAuthority | null;
  providerProxySlotReleased?(routeKey: string): void;
}

export type ProviderHostLifecycle = Pick<ProviderHostManager, 'drainForHandoff' | 'shutdown'>;

export interface ProviderHostAdministrationAuthority {
  admissionSnapshot(): HostAdmissionSnapshot;
  listProviderHosts(): readonly ProviderHostInventoryRecord[];
  inspectProviderHost(hostRef: HostRef): ProviderHostInventoryRecord | null;
  evictHost(hostRef: HostRef): Promise<boolean>;
}

/**
 * The registration half of the inheritance branch of proxy-set acquisition (W2.4/W2.5). The redemption
 * mechanism itself — reading a standing recovery capsule and attaching its operations — needs the
 * durable saga and jobs cleanup vocabulary that `coordinator/live/**` may not compose directly
 * (`architecture-layering.test.ts`'s coordinator-contract-entrypoint rule), so it lives in
 * `coordinator/services/provider-proxy-set-inheritance.ts` and calls back into this narrow, domain-free seam
 * once it already holds a live, connected set.
 */
export interface ProviderProxySetRegistration {
  /** Folds an already-redeemed set into this manager's own live sets (`liveSets()`), so it participates in
   *  this coordinator's later shutdown — including a second handoff — exactly as an acquired set would. */
  registerInheritedSet(set: ProviderProxyOperationAuthority): void;
}

export type ManagedAppServerSession = Readonly<{
  session: AppServerTransport;
  hostRef: HostRef;
  close(): void;
}>;

export { hostKeyFromSpec } from './state.js';

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
    if (value.idleRetirement === 'host-reported' || value.idleRetirement === 'none') return;
    throw new Error("provider_host_policy_invalid: shared hosts require idleRetirement 'host-reported' or 'none'");
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

function waitForClose(operation: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    return Promise.reject(new AbortError({ stage: 'provider_host_close_wait', reason: signal.reason }));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new AbortError({ stage: 'provider_host_close_wait', reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Provider host close failed.', { cause: error }));
      },
    );
  });
}

export class DefaultProviderHostManager
  implements ProviderHostManager, ProviderProxyAuthorityRegistry, ProviderProxySetRegistration
{
  private readonly entries = new Map<string, ProviderHostEntry>();
  private readonly admission = createCoordinatorProviderHostAdmission();
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly closingEntries = new Map<ProviderHostEntry, Readonly<{ ref: HostRef; operation: Promise<void> }>>();
  private readonly lifecyclePolicies = new Map<string, string>();
  private nextProviderServerGeneration = 1;
  private acceptingAcquisitions = true;
  private readonly idleTimeoutMs: number;
  private readonly spawnProviderServer: SpawnProviderServerFn;
  private readonly allocateProviderServerGeneration: () => number;
  private readonly runtime: Runtime;
  private readonly carrierBlocksRetirement: (hostRef: HostRef) => boolean;
  private readonly proxySetAcquisitionConfig?: ProviderProxySetAcquisitionConfig;
  private readonly providerProxyLifecycleRef?: ProviderProxySetLifecycleRef;
  private readonly proxySetRotationEntries = new Map<string, ProviderHostEntry>();
  /**
   * Aborted by `stopAndClose` the instant it runs, before anything in it is awaited. Threaded into every
   * acquisition attempt (`ensureProxySetFor`) alongside that attempt's own internal deadline
   * (`PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS`) via `AbortSignal.any`. `acquireProviderProxySet`'s own
   * final gate before publishing a set (see its doc) means an attempt still in flight when this fires can
   * never settle `acquired` — it is unwound and reported failed instead, no matter how far into its own
   * handshake it already was. That guarantee is what lets `runShutdownSequence` read `liveSets()` exactly
   * once, right after `shutdown()` / `drainForHandoff()` returns, and trust nothing still-pending can add to
   * it afterward — rather than awaiting each attempt's own up-to-45s budget just to find out.
   */
  private readonly proxySetAcquisitionStop = new AbortController();
  constructor(options: {
    runtime: Runtime;
    idleTimeoutMs?: number;
    spawnProviderServer: SpawnProviderServerFn;
    allocateProviderServerGeneration?: () => number;
    carrierBlocksRetirement?: (hostRef: HostRef) => boolean;
    proxySetAcquisition?: ProviderProxySetAcquisitionConfig;
    providerProxyLifecycleRef?: ProviderProxySetLifecycleRef;
  }) {
    this.runtime = options.runtime;
    this.idleTimeoutMs = options.idleTimeoutMs ?? parseIdleTimeoutMs(this.runtime.env.get('CORAL_BROKER_IDLE_MS'));
    this.spawnProviderServer = options.spawnProviderServer;
    this.allocateProviderServerGeneration =
      options.allocateProviderServerGeneration ?? (() => this.nextProviderServerGeneration++);
    this.carrierBlocksRetirement = options.carrierBlocksRetirement ?? (() => false);
    this.proxySetAcquisitionConfig = options.proxySetAcquisition;
    this.providerProxyLifecycleRef = options.providerProxyLifecycleRef;
  }

  /** Every set acquired so far and not yet reaped, acquired or inherited alike — see
   *  `ProviderProxyAuthorityRegistry.liveSets()`'s own doc for what this snapshot does and does not promise. */
  liveSets(): readonly ProviderProxySetAuthority[] {
    return this.providerProxyLifecycleRef?.get()?.liveSets() ?? [];
  }

  /** See `ProviderProxySetRegistration.registerInheritedSet()`'s interface doc for this seam's full contract. */
  registerInheritedSet(set: ProviderProxyOperationAuthority): void {
    const lifecycle = this.providerProxyLifecycleRef?.get();
    if (lifecycle === null || lifecycle === undefined) {
      throw new Error('provider_proxy_set_lifecycle_not_connected');
    }
    if (!isProviderProxyOperationAuthority(set)) {
      throw new Error('provider_proxy_set_inherited_authority_not_durable');
    }
    lifecycle.registerInheritedSet(set);
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
   * Fire-and-forget by design (see `ensureProviderProxySet`'s own doc): the caller of `acquireHostLease` gets
   * its real app-server session exactly as before, unaffected by whether this succeeds, fails, or is still
   * running when that session opens. A coordinator constructed without `proxySetAcquisition` (every test that
   * does not care about this feature) never attempts it at all.
   */
  private ensureProxySetFor(entry: ProviderHostEntry): void {
    const config = this.proxySetAcquisitionConfig;
    const lifecycle = this.providerProxyLifecycleRef?.get();
    if (config === undefined || lifecycle === null || lifecycle === undefined) return;
    // The executable identity, so every job-exclusive entry of the same spec shares one set. See the
    // `liveProxySets` field comment for why a per-entry key would be both wrong and unbounded.
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
    ensureProviderProxySet(
      entry,
      { runtime: this.runtime, signal: this.proxySetAcquisitionStop.signal, ...config },
      (outcome) => {
        if (outcome.kind === 'acquired') {
          const set = this.observeGenerationCapacity(identityKey, entry, outcome.set);
          lifecycle.acquisitionSucceeded(admission.slotId, set);
          return;
        }
        lifecycle.acquisitionFailed(admission.slotId);
        backendLog.warn(
          `Provider proxy set acquisition failed for ${entry.spec.provider} (${identityKey}): ${outcome.reason}`,
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
    acquireProviderHostPin(entry);
    this.ensureProxySetFor(entry);

    try {
      let reservedRef: HostRef | null = null;
      const handle = await ensureProviderServerHandle(entry, {
        spawnProviderServer: (nextSpec) => {
          if (admission === undefined) {
            throw new Error('provider_host_admission_missing: fresh placement requires an admission reservation');
          }
          const hostRef = hostRefFromEntry(entry);
          reservedRef = hostRef;
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
          const spawned = this.spawnProviderServer(
            {
              provider: nextSpec.provider,
              command: nextSpec.command,
              args: nextSpec.args,
              cwd: nextSpec.cwd,
              exactEnv: entry.exactEnv,
              ...(nextSpec.leaseMode === 'job-exclusive' && options?.signal ? { signal: options.signal } : {}),
              initializeRequest: nextSpec.initializeRequest,
              initializeTimeoutMs: nextSpec.initializeTimeoutMs,
            },
            (fact) => this.admission.observe(admission.slot, hostRef, fact),
            generation,
          );
          void spawned.then(
            (handle) => {
              spawnedHandle = handle;
            },
            () => {},
          );
          return spawned;
        },
        runtime: this.runtime,
        shutdownHandle: (handle, nextSpec) => this.shutdownHandle(handle, nextSpec),
        attachHostNotificationListener: (nextEntry, handle) => this.attachHostNotificationListener(nextEntry, handle),
        clearIdleTimer: (nextEntry) => this.clearIdleTimer(nextEntry),
        removeEntry: (nextEntry) => {
          if (this.entries.get(nextEntry.hostKey) === nextEntry) this.entries.delete(nextEntry.hostKey);
        },
        createInstanceId: () => this.runtime.ids.uuid(),
        observeRetired: () => {
          if (reservedRef !== null) admission?.reservation.observeRetired(reservedRef);
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
        throw entry.closingError ?? new Error('provider_host_draining: provider host acquisition lost drain race');
      }
      admission?.reservation.markLive(hostRefFromEntry(entry), handle.generation);
      return Object.freeze({
        lease: createProviderServerLease(handle, () => this.releaseHostPin(entry)),
        entry,
      });
    } catch (error) {
      this.releaseHostPin(entry);
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
    return this.admission.withFreshPlacement(slot, async (reservation) => {
      const { lease, entry } = await this.acquireHostLease(spec, options, { slot, reservation });
      return this.managedSession(lease, hostRefFromEntry(entry));
    });
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
    acquireProviderHostPin(entry);
    let closed = false;
    return Object.freeze({
      session: createProviderServerAttachment(handle),
      hostRef,
      close: () => {
        if (closed) return;
        closed = true;
        this.releaseHostPin(entry);
      },
    });
  }

  private managedSession(lease: ProviderServerLease, hostRef: HostRef): ManagedAppServerSession {
    return Object.freeze({
      session: Object.freeze({
        rpc: lease.rpc.bind(lease),
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
    const processEntries = new Set([...this.entries.values(), ...this.closingEntries.keys()]);
    const records: ProviderHostInventoryRecord[] = [];
    for (const admissionEntry of snapshot.state.values()) {
      if (admissionEntry.phase === 'spawning' || admissionEntry.phase === 'retired-blocked') continue;
      const matches = [...processEntries].filter((entry) => entryMatchesHostRef(entry, admissionEntry.ref));
      if (matches.length !== 1) {
        throw new Error('provider_host_inventory_unavailable: live coordinator host could not be revalidated');
      }
      const entry = matches[0] as ProviderHostEntry;
      const handle = entry.handle;
      if (handle === null || handle.isClosed()) {
        throw new Error('provider_host_inventory_unavailable: live coordinator host process is unavailable');
      }
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
      ...snapshot.tombstones.map((tombstone) =>
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

  async evictHost(hostRef: HostRef): Promise<boolean> {
    if (!isExactHostRef(hostRef)) return false;
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
      await this.closeProviderServerEntry(matched, 'evicted by operator', { confirmAbsence: true });
      this.admission.confirmEvicted(hostRef);
      return true;
    }

    const tombstones = this.admission
      .snapshot()
      .tombstones.filter(
        (tombstone) => tombstone.retirement.processAbsent && exactHostRefsMatch(tombstone.ref, hostRef),
      );
    if (tombstones.length !== 1) return false;
    return this.admission.confirmEvicted(hostRef);
  }

  async drainForHandoff(signal?: AbortSignal): Promise<void> {
    await this.stopAndClose('drained', signal);
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.stopAndClose('shut down', signal);
  }

  private async stopAndClose(detail: string, signal?: AbortSignal): Promise<void> {
    this.acceptingAcquisitions = false;
    // Cuts off every proxy-set acquisition still running before anything below is awaited — see
    // `proxySetAcquisitionStop`'s own doc for why this is what makes `liveSets()` safe for a caller to read
    // once this method returns, with no risk of a straggler acquisition adding to it afterward.
    this.proxySetAcquisitionStop.abort();
    await closeAllProviderServerEntries(
      this.entries,
      detail,
      (entry, detail, options) => this.closeProviderServerEntry(entry, detail, options),
      signal === undefined ? {} : { signal },
    );
    await waitForClose(
      Promise.all([...this.pendingCloses]).then(() => {}),
      signal,
    );
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
      instanceId: null,
      spawnPromise: null,
      pinCount: 0,
      closingError: null,
      closePromise: null,
      hostStats: null,
      idleTimer: null,
      disposeHostNotifications: null,
    };
    this.entries.set(hostKey, created);
    return created;
  }

  private releaseHostPin(entry: ProviderHostEntry): void {
    releaseProviderHostPin(entry);
    if (entry.pinCount > 0 || entry.closingError !== null) return;
    if (entry.spec.leaseMode === 'shared') {
      this.maybeArmIdleTimer(entry);
      return;
    }
    void this.closeProviderServerEntry(entry, 'job-exclusive host unpinned').catch(() => {});
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

  private async closeProviderServerEntry(
    entry: ProviderHostEntry,
    detail: string,
    options: { signal?: AbortSignal; confirmAbsence?: boolean } = {},
  ): Promise<void> {
    if (entry.closePromise === null) {
      const ref = entry.instanceId === null ? null : hostRefFromEntry(entry);
      const operation = closeEntry(entry, detail, {
        runtime: this.runtime,
        entries: this.entries,
        shutdownHandle: (handle, spec) => this.shutdownHandle(handle, spec),
      });
      entry.closePromise = operation;
      this.pendingCloses.add(operation);
      if (ref !== null) this.closingEntries.set(entry, Object.freeze({ ref, operation }));
      void operation.then(
        () => {
          this.pendingCloses.delete(operation);
          if (this.closingEntries.get(entry)?.operation === operation) this.closingEntries.delete(entry);
        },
        () => {
          this.pendingCloses.delete(operation);
          if (entry.closePromise === operation) entry.closePromise = null;
        },
      );
    }
    const operation = entry.closePromise;
    try {
      await waitForClose(operation, options.signal);
    } catch (error: unknown) {
      if (options.confirmAbsence) throw error;
    }
  }

  private async shutdownHandle(handle: ProviderServerHandle, spec: ProviderServerSpec): Promise<void> {
    await shutdownHandle(handle, spec, this.runtime.time);
  }
}

export function createProviderHostManager(options: {
  runtime: Runtime;
  idleTimeoutMs?: number;
  spawnProviderServer: SpawnProviderServerFn;
  allocateProviderServerGeneration?: () => number;
  carrierBlocksRetirement?: (hostRef: HostRef) => boolean;
  proxySetAcquisition?: ProviderProxySetAcquisitionConfig;
  providerProxyLifecycleRef?: ProviderProxySetLifecycleRef;
}): ProviderHostManager &
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
