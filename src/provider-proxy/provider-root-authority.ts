import { backendLog } from '../infra/backend-log.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import type { Runtime } from '../runtime/ports.js';
import {
  spawnProviderServerTransport,
  type ProviderServerHandle,
  type SpawnProviderServerOptions,
} from '../providers/app-server-transport.js';
import type { ProviderHostDiagnosticsSnapshot } from '../providers/host-diagnostics.js';
import {
  admissionSlotKey,
  canonicalProviderHostSpecMetadata,
  exactHostRefsMatch,
  type AdmissionSlotKey,
  type HostAdmissionCollection,
  type HostAdmissionReservation,
  type HostAdmissionSnapshot,
} from '../providers/host-admission.js';
import type { AppServerTransport, HostRef, ProviderServerSpec } from '../providers/contract.js';
import type { AppServerHostAuthority, ManagedHostSession } from '../providers/internal/app-server-host.js';
import type { ProviderOperationKey } from './ledger.js';
import type { ProviderHostInventoryRecordWire, ProxyPrepareCapacityCode } from './protocol.js';
import { createProxyProviderHostAdmission } from './provider-host-admission.js';

/**
 * Reconstructs and runs the live Claude/Codex kernel inside the proxy process.
 *
 * The coordinator never runs a kernel after proxy admission (plan §"Process topology, endpoint, guardian, and
 * authentication"): it prepares strict data and transactionally applies acknowledged semantic events. This
 * module is where that data turns back into a running `BoundProvider` — the proxy-local mirror of what
 * `src/jobs/shell/launch.ts` does in-process, minus everything that only makes sense with store/journal access.
 *
 * Judgement call (see the task report): a proxy-local `DefaultProviderHostManager`
 * (`src/coordinator/live/provider-hosts/index.ts`) is not legitimate here — it lives under `src/coordinator/live/`,
 * which `tests/invariants/architecture-layering.test.ts`'s `PROVIDER_PROXY_FORBIDDEN` list and
 * `tests/invariants/provider-proxy-no-store.test.ts`'s transitive reachability check both forbid
 * `src/provider-proxy/**` from reaching, at any depth — reusing it would also recurse into `ensureProxySetFor`,
 * which spawns a *fresh* guardian/reaper/proxy set on demand. Its multi-job idle-timer and drain/shutdown
 * lifecycle is coordinator-daemon-shaped, not proxy-shaped, so this file still owns a narrower pool below —
 * but the raw spawn-and-JSON-RPC-framing primitive underneath it, `spawnProviderServerTransport`, now lives at
 * `src/providers/app-server-transport.ts`, legal for this domain to import, so this file builds its pool on
 * that shared transport rather than a second implementation of it.
 */

export const MAX_PROXY_LIVE_PROVIDER_ROOTS = 1;
export const PROVIDER_ROOT_ROTATION_THRESHOLD = 127;

export class ProxyProviderRootCapacityError extends Error {
  readonly code: Extract<ProxyPrepareCapacityCode, 'provider_root_live_capacity' | 'provider_root_generation_draining'>;

  constructor(code: ProxyProviderRootCapacityError['code'], message: string) {
    super(message);
    this.name = 'ProxyProviderRootCapacityError';
    this.code = code;
    Object.setPrototypeOf(this, ProxyProviderRootCapacityError.prototype);
  }
}

// --- proxy-owned app-server host authority: pool over the shared transport -------------------------------

/** This build's `ProviderServerSpec` as the shared transport's own spawn options. `spec.env` is always the
 *  *complete* launch environment a provider's own `planHost` computed, never additions to the inherited one
 *  — `exactEnv` is the shared transport's name for that same "exact replace" semantics
 *  (`compileLaunchEnvironment`, `src/coordinator/live/provider-hosts/index.ts`, treats it identically). */
function spawnOptionsFor(spec: ProviderServerSpec, signal: AbortSignal | undefined): SpawnProviderServerOptions {
  return {
    provider: spec.provider,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    ...(spec.env ? { exactEnv: spec.env } : {}),
    ...(signal === undefined ? {} : { signal }),
    ...(spec.initializeRequest === undefined ? {} : { initializeRequest: spec.initializeRequest }),
    ...(spec.initializeTimeoutMs === undefined ? {} : { initializeTimeoutMs: spec.initializeTimeoutMs }),
  };
}

/** `ProviderServerHandle` (`rpc.request`/`onNotification`/`closePromise`) as the narrower `AppServerTransport`
 *  (`rpc`/`subscribe`/`closed`) a bound provider's session actually needs. `subscribe` forwards straight to
 *  `onNotification` rather than wrapping it: the shared transport's own dispatch loop already logs a throwing
 *  handler through `backendLog` and treats it as fatal to the connection (kills the child, rejects every
 *  pending request) — a second try/catch here would only shadow that, not improve on it.
 *
 *  Duplicates `createProviderServerAttachment` (`src/coordinator/live/provider-hosts/lease.ts`) verbatim.
 *  `src/providers/` is not on `provider-proxy`'s forbidden-import list (only `src/coordinator/` and its
 *  siblings are — `tests/invariants/architecture-layering.test.ts`'s `PROVIDER_PROXY_FORBIDDEN`), and
 *  `src/providers/contract.ts` does not import `src/providers/app-server-transport.ts`, so relocating this
 *  adapter to the latter — a module both this file and `lease.ts` already import `ProviderServerHandle`
 *  from — is layering-legal and would remove the duplicate. Left in place because doing so also requires
 *  editing `lease.ts` and `app-server-transport.ts`, both outside this pass's touch scope
 *  (`src/provider-proxy/**` and `src/infra/bundle-manifest.ts`). */
function transportFor(handle: ProviderServerHandle): AppServerTransport {
  return {
    rpc: (method, params) => handle.rpc.request(method, params),
    subscribe: (handler) => handle.onNotification(handler),
    closed: handle.closePromise,
  };
}

/** Best-effort graceful shutdown through the spec's own `shutdownCapability` RPC, if any, then the shared
 *  transport's own SIGTERM/SIGKILL escalation regardless of how the graceful attempt went. `handle.close()` is
 *  idempotent (`entry.closed` is checked before signalling), so running it after an already-graceful exit
 *  costs nothing but one no-op signal to a process that is already gone. */
async function closeSpawnedHandle(
  handle: ProviderServerHandle,
  spec: ProviderServerSpec,
  runtime: Runtime,
): Promise<void> {
  const capability = spec.shutdownCapability;
  if (capability !== undefined) {
    handle.markExpectedClose();
    try {
      await Promise.race([handle.rpc.request(capability.method, {}), runtime.time.sleep(capability.timeoutMs)]);
    } catch {
      /* best effort; the escalation below still runs */
    }
  }
  await handle.close();
}

/** Recursively re-keys every plain object in `value` (at every nesting depth) into ascending key order,
 *  leaving arrays and scalars untouched. Byte-for-byte copy of `canonicalValue`
 *  (`src/coordinator/live/provider-hosts/state.ts`) — required because `JSON.stringify`'s own second
 *  argument is a replacer *allowlist* applied at every nesting level, not a top-level key sorter: passing
 *  `Object.keys(canonical).sort()` there (the bug this replaces) silently drops every field one level below
 *  the top instead of sorting it. Sorting the value graph first and calling plain `JSON.stringify` on the
 *  result is the only way to get a deep-stable key order without that trap. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/** Stable identity for one executable configuration, independent of lease mode — a faithful reimplementation
 *  of `hostKeyFromSpec` (`src/coordinator/live/provider-hosts/state.ts`), copied rather than imported because
 *  that module lives under the forbidden `src/coordinator/live/` tree (see this file's top-of-file doc
 *  comment). Same field set, same `canonicalValue` sorter, same `JSON.stringify` call with no replacer — a
 *  divergence here silently mints a `HostRef.fingerprint` (below) that can never match the coordinator's own
 *  for an identical spec, which is exactly the defect this shape once had. The correspondence is not just
 *  asserted in prose: `tests/unit/provider-proxy/semantic-operation.test.ts`'s "agrees with the coordinator's
 *  own key/fingerprint functions" case imports both copies directly and proves they produce identical output
 *  for the same spec. Exported so that test can drive it directly rather than only indirectly through
 *  `createProxyAppServerHostAuthority`'s pooling behavior. */
export function specIdentityKey(spec: ProviderServerSpec): string {
  return JSON.stringify(
    canonicalValue({
      provider: spec.provider,
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: spec.env ?? {},
      initializeRequest: spec.initializeRequest ?? null,
      initializeTimeoutMs: spec.initializeTimeoutMs ?? null,
      shutdownCapability: spec.shutdownCapability ?? null,
    }),
  );
}

/** Mirrors `hostFingerprintFromSpec` (`src/coordinator/live/provider-hosts/state.ts`) the same way
 *  `specIdentityKey` mirrors `hostKeyFromSpec`: same three fields, same key order (a plain object literal's
 *  string keys serialize in insertion order, so this does not need `canonicalValue`), same digest. Only the
 *  hashing call differs in *spelling* — `runtime.ids.sha256` here vs. `node:crypto`'s `createHash('sha256')`
 *  there — not in behavior: `src/runtime/real.ts` implements `ids.sha256` as
 *  `createHash('sha256').update(input).digest('hex')`, the identical primitive. Exported for the same
 *  direct-test reason as `specIdentityKey`. */
export function specFingerprint(runtime: Runtime, spec: ProviderServerSpec): string {
  return runtime.ids.sha256(
    JSON.stringify({
      identity: specIdentityKey(spec),
      leaseMode: spec.leaseMode,
      idleRetirement: spec.leaseMode === 'shared' ? spec.idleRetirement : null,
    }),
  );
}

type HostPoolEntry = {
  readonly hostKey: string;
  readonly spec: ProviderServerSpec;
  readonly instanceId: string;
  readonly handle: ProviderServerHandle;
  readonly transport: AppServerTransport;
  readonly incarnation: ProcessIncarnation;
  readonly jobId: string | undefined;
  readonly cancellationMode: ProxyHostCancellationMode;
  refCount: number;
  rootTokenReleased: boolean;
  closePromise: Promise<void> | null;
};

function hostKeyFor(
  spec: ProviderServerSpec,
  operation: ProviderOperationKey,
  mode: ProxyHostCancellationMode,
  jobId: string | undefined,
): string {
  const specKey = specIdentityKey(spec);
  if (mode === 'operation-isolated') return JSON.stringify([operation.jobId, operation.operationId, specKey]);
  return spec.leaseMode === 'shared' ? specKey : `${specKey} job:${jobId ?? ''}`;
}

function assertLeasePolicy(spec: ProviderServerSpec, jobId: string | undefined): void {
  if (spec.leaseMode === 'job-exclusive' && jobId === undefined) {
    throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
  }
}

function hostRefForIdentity(
  spec: ProviderServerSpec,
  instanceId: string,
  jobId: string | undefined,
  runtime: Runtime,
): HostRef {
  const identity = {
    provider: spec.provider,
    fingerprint: specFingerprint(runtime, spec),
    instanceId,
  } as const;
  if (spec.leaseMode === 'shared') return Object.freeze({ ...identity, leaseMode: 'shared' as const });
  return Object.freeze({ ...identity, leaseMode: 'job-exclusive' as const, ownerJobId: jobId as string });
}

function hostRefFor(entry: HostPoolEntry, runtime: Runtime): HostRef {
  return hostRefForIdentity(entry.spec, entry.instanceId, entry.jobId, runtime);
}

function isMatchingHostRef(hostRef: HostRef, entry: HostPoolEntry, runtime: Runtime): boolean {
  if (hostRef.provider !== entry.spec.provider) return false;
  if (hostRef.fingerprint !== specFingerprint(runtime, entry.spec)) return false;
  if (hostRef.instanceId !== entry.instanceId) return false;
  if (hostRef.leaseMode !== entry.spec.leaseMode) return false;
  return hostRef.leaseMode !== 'job-exclusive' || hostRef.ownerJobId === entry.jobId;
}

export type ProxyHostCancellationMode = 'shared-acknowledged-interrupt' | 'operation-isolated';

export interface ProxyOperationHostScope extends AppServerHostAuthority {
  selectCancellationMode(mode: ProxyHostCancellationMode): void;
}

export interface ProxyAppServerHostAuthority {
  beginOperation(key: ProviderOperationKey): ProxyOperationHostScope;
  /** The raw process identity behind an already-open `HostRef`, for the guardian containment report. `null`
   *  when the reference no longer names a live entry this authority holds. */
  rootIdentity(hostRef: HostRef): Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null;
  closed(hostRef: HostRef): Promise<Error | void> | null;
  forceClose(hostRef: HostRef): Promise<void>;
  evictHost(hostRef: HostRef): Promise<boolean>;
}

export interface ProxyProviderHostAdministrationAuthority {
  admissionSnapshot(): HostAdmissionSnapshot;
  listProviderHosts(): readonly ProxyProviderHostInventoryRecord[];
  inspectProviderHost(hostRef: HostRef): ProxyProviderHostInventoryRecord | null;
  evictHost(hostRef: HostRef): Promise<boolean>;
}

export type ProxyProviderHostInventoryRecord = ProviderHostInventoryRecordWire;

type FreshHostPlacement = Readonly<{
  slot: AdmissionSlotKey;
  reservation: HostAdmissionReservation;
}>;

type RootSpawnRequest = Readonly<{
  operation: ProviderOperationKey;
  cancellationMode: ProxyHostCancellationMode;
  hostKey: string;
  spec: ProviderServerSpec;
  options: Readonly<{ jobId?: string; signal?: AbortSignal }> | undefined;
  placement: FreshHostPlacement;
}>;

type RootSpawnTransaction = {
  readonly request: RootSpawnRequest;
  readonly generation: number;
  readonly instanceId: string;
  readonly reservedRef: HostRef;
  handle: ProviderServerHandle | null;
  liveRootCommitted: boolean;
};

type RootRetirement = {
  entry: HostPoolEntry | null;
  releasedBeforeEntry: boolean;
};

class ProxyProviderRootPool {
  private readonly runtime: Runtime;
  private readonly admission: HostAdmissionCollection;
  private readonly entries = new Map<string, HostPoolEntry>();
  private readonly closingEntries = new Set<HostPoolEntry>();
  private nextGeneration = 0;
  private liveRoots = 0;
  private spawningRoots = 0;
  // Informational generation-local admission count; no serviceability decision reads it.
  private generationRootSlotsSpent = 0;

  constructor(runtime: Runtime, admission: HostAdmissionCollection) {
    this.runtime = runtime;
    this.admission = admission;
  }

  active(hostKey: string): HostPoolEntry | undefined {
    return this.entries.get(hostKey);
  }

  remove(entry: HostPoolEntry): void {
    if (this.entries.get(entry.hostKey) === entry) this.entries.delete(entry.hostKey);
  }

  matches(hostRef: HostRef, entry: HostPoolEntry): boolean {
    return isMatchingHostRef(hostRef, entry, this.runtime);
  }

  allEntries(): ReadonlySet<HostPoolEntry> {
    return new Set([...this.entries.values(), ...this.closingEntries]);
  }

  matchingEntries(hostRef: HostRef): ReadonlySet<HostPoolEntry> {
    const matches = new Set<HostPoolEntry>();
    for (const entry of this.entries.values()) {
      if (this.matches(hostRef, entry)) matches.add(entry);
    }
    for (const entry of this.closingEntries) {
      if (this.matches(hostRef, entry)) matches.add(entry);
    }
    return matches;
  }

  rootIdentity(hostRef: HostRef): Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null {
    for (const entry of this.entries.values()) {
      if (this.matches(hostRef, entry)) {
        return { pid: entry.handle.pid, incarnation: entry.incarnation };
      }
    }
    return null;
  }

  closed(hostRef: HostRef): Promise<Error | void> | null {
    for (const entry of this.entries.values()) {
      if (this.matches(hostRef, entry)) return entry.transport.closed;
    }
    return null;
  }

  async forceClose(hostRef: HostRef): Promise<void> {
    const matched = this.takeForceCloseTarget(hostRef);
    if (matched !== undefined) await this.close(matched);
  }

  async spawn(request: RootSpawnRequest): Promise<HostPoolEntry> {
    const transaction = this.reserveSpawn(request);
    const { spec, options, placement } = request;
    const { reservedRef } = transaction;
    const admission = this.admission;
    try {
      const handle = await spawnProviderServerTransport({
        runtime: this.runtime,
        options: spawnOptionsFor(spec, options?.signal),
        generation: transaction.generation,
        observeProviderResponse: (fact) => admission.observe(placement.slot, reservedRef, fact),
      });
      transaction.handle = handle;
      return this.commitSpawnedRoot(transaction, handle);
    } catch (error: unknown) {
      await this.compensateFailedSpawn(transaction);
      throw error;
    }
  }

  close(entry: HostPoolEntry): Promise<void> {
    if (entry.closePromise !== null) return entry.closePromise;
    this.closingEntries.add(entry);
    const closePromise = closeSpawnedHandle(entry.handle, entry.spec, this.runtime).then(() =>
      this.releaseLiveRoot(entry),
    );
    entry.closePromise = closePromise;
    void closePromise.then(
      () => {
        if (entry.closePromise === closePromise) this.closingEntries.delete(entry);
      },
      () => {
        if (entry.closePromise === closePromise) entry.closePromise = null;
      },
    );
    return closePromise;
  }

  private reserveRootToken(): void {
    if (this.generationRootSlotsSpent >= PROVIDER_ROOT_ROTATION_THRESHOLD) {
      throw new ProxyProviderRootCapacityError(
        'provider_root_generation_draining',
        `Provider root generation reached its ${PROVIDER_ROOT_ROTATION_THRESHOLD} root rotation threshold.`,
      );
    }
    if (this.liveRoots + this.spawningRoots + 1 > MAX_PROXY_LIVE_PROVIDER_ROOTS) {
      throw new ProxyProviderRootCapacityError(
        'provider_root_live_capacity',
        `Provider root admission permits at most ${MAX_PROXY_LIVE_PROVIDER_ROOTS} live or spawning root.`,
      );
    }
    this.spawningRoots += 1;
  }

  private reserveSpawn(request: RootSpawnRequest): RootSpawnTransaction {
    this.reserveRootToken();
    const { operation, cancellationMode, hostKey, spec, options, placement } = request;
    const instanceId = this.runtime.ids.uuid();
    const transaction: RootSpawnTransaction = {
      request,
      generation: this.nextGeneration++,
      instanceId,
      reservedRef: hostRefForIdentity(spec, instanceId, options?.jobId, this.runtime),
      handle: null,
      liveRootCommitted: false,
    };
    placement.reservation.reserveCandidate({
      slot: placement.slot,
      ref: transaction.reservedRef,
      generation: transaction.generation,
      spec: canonicalProviderHostSpecMetadata(spec),
      host: Object.freeze({
        owner: 'provider-proxy',
        hostKey,
        ownerJobId: options?.jobId ?? null,
        operationJobId: operation.jobId,
        operationId: operation.operationId,
        cancellationMode,
      }),
      inspectDiagnostics: () => transaction.handle?.inspectDiagnostics() ?? emptyDiagnostics(),
    });
    return transaction;
  }

  private commitSpawnedRoot(transaction: RootSpawnTransaction, handle: ProviderServerHandle): HostPoolEntry {
    const { request, generation, instanceId, reservedRef } = transaction;
    const { cancellationMode, hostKey, spec, options, placement } = request;
    this.spawningRoots -= 1;
    this.liveRoots += 1;
    this.generationRootSlotsSpent += 1;
    transaction.liveRootCommitted = true;

    const retirement = this.installRetirement(transaction, handle);
    const incarnation = probeProcessIncarnation(handle.pid, this.runtime.env.platform() as NodeJS.Platform);
    if (incarnation === null || handle.isClosed()) {
      throw new Error(`Provider server ${spec.provider} could not have its own incarnation read after spawn.`);
    }
    const entry: HostPoolEntry = {
      hostKey,
      spec,
      instanceId,
      handle,
      transport: transportFor(handle),
      incarnation,
      jobId: options?.jobId,
      cancellationMode,
      refCount: 0,
      rootTokenReleased: retirement.releasedBeforeEntry,
      closePromise: null,
    };
    retirement.entry = entry;
    this.entries.set(hostKey, entry);
    placement.reservation.markLive(reservedRef, generation);
    return entry;
  }

  private installRetirement(transaction: RootSpawnTransaction, handle: ProviderServerHandle): RootRetirement {
    const retirement: RootRetirement = { entry: null, releasedBeforeEntry: false };
    const retire = (): void => {
      if (retirement.entry !== null) this.remove(retirement.entry);
      transaction.request.placement.reservation.observeRetired(transaction.reservedRef, 'closed');
      if (retirement.entry !== null) {
        this.releaseLiveRoot(retirement.entry);
      } else if (!retirement.releasedBeforeEntry) {
        retirement.releasedBeforeEntry = true;
        this.liveRoots -= 1;
      }
    };
    void handle.closePromise.then(retire, retire);
    return retirement;
  }

  private async compensateFailedSpawn(transaction: RootSpawnTransaction): Promise<void> {
    const { placement } = transaction.request;
    if (!transaction.liveRootCommitted) {
      this.spawningRoots -= 1;
      placement.reservation.observeRetired(transaction.reservedRef, 'closed');
    } else if (transaction.handle !== null) {
      try {
        await transaction.handle.close();
        placement.reservation.observeRetired(transaction.reservedRef, 'closed');
      } catch {
        // A failed close retains the live-root token because process absence was not confirmed.
      }
    }
  }

  private releaseLiveRoot(entry: HostPoolEntry): void {
    if (entry.rootTokenReleased) return;
    entry.rootTokenReleased = true;
    this.liveRoots -= 1;
  }

  private takeForceCloseTarget(hostRef: HostRef): HostPoolEntry | undefined {
    for (const entry of this.entries.values()) {
      if (!this.matches(hostRef, entry)) continue;
      this.assertForceCloseAllowed(entry);
      this.entries.delete(entry.hostKey);
      this.closingEntries.add(entry);
      return entry;
    }
    for (const entry of this.closingEntries) {
      if (!this.matches(hostRef, entry)) continue;
      this.assertForceCloseAllowed(entry);
      return entry;
    }
    return undefined;
  }

  private assertForceCloseAllowed(entry: HostPoolEntry): void {
    if (entry.cancellationMode === 'shared-acknowledged-interrupt') {
      throw new Error('provider_host_scope_shared_force_close_forbidden');
    }
  }
}

class ProxyProviderHostSessions {
  private readonly runtime: Runtime;
  private readonly admission: HostAdmissionCollection;
  private readonly pool: ProxyProviderRootPool;

  constructor(runtime: Runtime, admission: HostAdmissionCollection, pool: ProxyProviderRootPool) {
    this.runtime = runtime;
    this.admission = admission;
    this.pool = pool;
  }

  beginOperation(operation: ProviderOperationKey): ProxyOperationHostScope {
    let cancellationMode: ProxyHostCancellationMode | null = null;
    const selectedMode = (): ProxyHostCancellationMode => {
      if (cancellationMode === null) {
        throw new Error('provider_host_scope_unselected: cancellation mode must be selected before acquisition');
      }
      return cancellationMode;
    };

    return {
      selectCancellationMode(mode) {
        if (cancellationMode !== null) {
          throw new Error('provider_host_scope_already_selected: cancellation mode may be selected only once');
        }
        cancellationMode = mode;
      },
      openSession: (spec, options) => {
        const mode = selectedMode();
        const slot = admissionSlotKey(hostKeyFor(spec, operation, mode, options?.jobId));
        return this.admission.withFreshPlacement(slot, (reservation) =>
          this.openSession(operation, mode, spec, options, { slot, reservation }),
        );
      },
      attachSession: (hostRef, expectation) => this.attachSession(operation, selectedMode(), hostRef, expectation),
    };
  }

  private async openSession(
    operation: ProviderOperationKey,
    cancellationMode: ProxyHostCancellationMode,
    spec: ProviderServerSpec,
    options: Readonly<{ jobId?: string; signal?: AbortSignal }> | undefined,
    placement: FreshHostPlacement,
  ): Promise<ManagedHostSession> {
    assertLeasePolicy(spec, options?.jobId);
    const hostKey = hostKeyFor(spec, operation, cancellationMode, options?.jobId);
    const existing = this.pool.active(hostKey);
    if (existing !== undefined) return this.managedSessionFor(existing);
    const entry = await this.pool.spawn({ operation, cancellationMode, hostKey, spec, options, placement });
    return this.managedSessionFor(entry);
  }

  private async attachSession(
    operation: ProviderOperationKey,
    cancellationMode: ProxyHostCancellationMode,
    hostRef: HostRef,
    expectation: Readonly<{ spec: ProviderServerSpec; jobId?: string }>,
  ): Promise<ManagedHostSession | null> {
    const hostKey = hostKeyFor(expectation.spec, operation, cancellationMode, expectation.jobId);
    const entry = this.pool.active(hostKey);
    if (entry === undefined || !this.pool.matches(hostRef, entry)) return null;
    return this.managedSessionFor(entry);
  }

  private managedSessionFor(entry: HostPoolEntry): ManagedHostSession {
    let released = false;
    const hostRef = hostRefFor(entry, this.runtime);
    entry.refCount += 1;
    return Object.freeze({
      session: Object.freeze({
        rpc: <Result = unknown>(method: string, params: Record<string, unknown>) =>
          this.admission.correlateTerminalFailure(hostRef, () => entry.transport.rpc<Result>(method, params)),
        subscribe: entry.transport.subscribe.bind(entry.transport),
        closed: entry.transport.closed,
      }),
      hostRef,
      close: () => {
        if (released) return;
        released = true;
        entry.refCount -= 1;
        if (entry.refCount > 0) return;
        this.pool.remove(entry);
        void this.pool.close(entry).catch((error: unknown) => {
          backendLog.error(
            `semantic operation runtime: app-server host close failed for ${entry.spec.provider}`,
            error,
          );
        });
      },
    });
  }
}

class ProxyProviderHostAdministration {
  private readonly admission: HostAdmissionCollection;
  private readonly pool: ProxyProviderRootPool;

  constructor(admission: HostAdmissionCollection, pool: ProxyProviderRootPool) {
    this.admission = admission;
    this.pool = pool;
  }

  listProviderHosts(): readonly ProxyProviderHostInventoryRecord[] {
    const snapshot = this.admission.snapshot();
    const processEntries = this.pool.allEntries();
    const records: ProxyProviderHostInventoryRecord[] = [];
    for (const admissionEntry of snapshot.state.values()) {
      if (admissionEntry.phase === 'spawning' || admissionEntry.phase === 'retired-blocked') continue;
      const matches = [...processEntries].filter((entry) => this.pool.matches(admissionEntry.ref, entry));
      if (matches.length !== 1) {
        throw new Error('provider_host_inventory_unavailable: live proxy host could not be revalidated');
      }
      const entry = matches[0];
      if (entry.handle.isClosed()) {
        throw new Error('provider_host_inventory_unavailable: live proxy host process is unavailable');
      }
      records.push(
        Object.freeze({
          ref: admissionEntry.ref,
          status: 'live',
          spec: canonicalProviderHostSpecMetadata(entry.spec),
          host: Object.freeze({
            owner: 'provider-proxy',
            hostKey: entry.hostKey,
            ownerJobId: entry.jobId ?? null,
            cancellationMode: entry.cancellationMode,
          }),
          diagnostics: entry.handle.inspectDiagnostics(),
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

  inspectProviderHost(hostRef: HostRef): ProxyProviderHostInventoryRecord | null {
    const matches = this.listProviderHosts().filter((record) => exactHostRefsMatch(record.ref, hostRef));
    if (matches.length > 1) {
      throw new Error('provider_host_identity_integrity: exact host ref matched multiple proxy records');
    }
    return matches[0] ?? null;
  }

  async evictHost(hostRef: HostRef): Promise<boolean> {
    const snapshot = this.admission.snapshot();
    const owned =
      [...snapshot.state.values()].some((entry) => exactHostRefsMatch(entry.ref, hostRef)) ||
      snapshot.tombstones.some((tombstone) => exactHostRefsMatch(tombstone.ref, hostRef));
    if (!owned) return false;

    const matches = this.pool.matchingEntries(hostRef);
    if (matches.size > 1) {
      throw new Error('provider_host_identity_integrity: exact host ref matched multiple proxy entries');
    }
    const matched = matches.values().next().value;
    if (matched !== undefined) {
      this.pool.remove(matched);
      await this.pool.close(matched);
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

  admissionSnapshot(): HostAdmissionSnapshot {
    return this.admission.snapshot();
  }
}

/**
 * The proxy's own narrower stand-in for `DefaultProviderHostManager`: pools app-server children by executable
 * identity (shared) or identity+job (job-exclusive, so this proxy's own stage-then-activate sequence reuses
 * one process rather than spawning twice), ref-counts sessions, and closes a pool entry once its last
 * reference releases. Deliberately does not replicate the coordinator's idle-timer-based early retirement for
 * `idleRetirement: 'unleased-and-host-idle'` shared hosts — every host here stays open until its last referencing
 * operation stops, which is a reported simplification (see the task report), not an attempt to reproduce that
 * policy exactly.
 */
export function createProxyAppServerHostAuthority(
  runtime: Runtime,
): ProxyAppServerHostAuthority & ProxyProviderHostAdministrationAuthority {
  const admission = createProxyProviderHostAdmission();
  const pool = new ProxyProviderRootPool(runtime, admission);
  const sessions = new ProxyProviderHostSessions(runtime, admission, pool);
  const administration = new ProxyProviderHostAdministration(admission, pool);

  return {
    beginOperation: (operation) => sessions.beginOperation(operation),
    rootIdentity: (hostRef) => pool.rootIdentity(hostRef),
    closed: (hostRef) => pool.closed(hostRef),
    forceClose: (hostRef) => pool.forceClose(hostRef),
    listProviderHosts: () => administration.listProviderHosts(),
    inspectProviderHost: (hostRef) => administration.inspectProviderHost(hostRef),
    evictHost: (hostRef) => administration.evictHost(hostRef),
    admissionSnapshot: () => administration.admissionSnapshot(),
  };
}

function emptyDiagnostics(): ProviderHostDiagnosticsSnapshot {
  return Object.freeze({
    hostLog: Object.freeze({ entries: Object.freeze([]), retainedBytes: 0, truncatedBeforeSeq: 0 }),
    completedObservations: Object.freeze([]),
    factsTruncatedBeforeSeq: 0,
  });
}
