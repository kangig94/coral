import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { probeProcessStartedAtSeconds } from '../infra/node-process.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { Runtime } from '../runtime/ports.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import { providerRequestFailed } from '../providers/fault.js';
import {
  spawnProviderServerTransport,
  type ProviderServerHandle,
  type SpawnProviderServerOptions,
} from '../providers/app-server-transport.js';
import {
  isAbortStopCause,
  type AppServerTransport,
  type HostRef,
  type ProviderEventBody,
  type ProviderServerSpec,
  type ProviderStopCause,
} from '../providers/contract.js';
import type { AppServerHostAuthority, ManagedHostSession } from '../providers/internal/app-server-host.js';
import type {
  BoundProvider,
  BoundProviderAppServerExecutionRuntime,
  BoundProviderExecutionPreparationInput,
  BoundProviderHostPreparationInput,
} from '../providers/bound-provider-contract.js';
import type { ProviderOperationKey, ProviderRootIdentity } from './ledger.js';
import type {
  SemanticOperationHost,
  SemanticOperationStartHandle,
  SemanticOperationStartResult,
} from './operation-supervisor.js';
import type { Proxy } from './proxy.js';
import {
  providerOperationPreparePermanentRefusalSchema,
  type ProviderOperationPreparePermanentRefusal,
  type ProxyPreparedAppServerOperation,
} from './protocol.js';

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

export const SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS = SIGTERM_GRACE_MS + SIGKILL_GRACE_MS;

export class SemanticOperationCancellationTimeoutError extends Error {
  readonly code = 'semantic_operation_cancellation_timeout';
  readonly timeoutMs = SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS;

  constructor() {
    super(`Provider operation cancellation did not settle within ${SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS}ms.`);
    this.name = 'SemanticOperationCancellationTimeoutError';
    Object.setPrototypeOf(this, SemanticOperationCancellationTimeoutError.prototype);
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
  readonly processStartedAtSeconds: number;
  readonly jobId: string | undefined;
  refCount: number;
  closePromise: Promise<void> | null;
};

function hostKeyFor(spec: ProviderServerSpec, jobId: string | undefined): string {
  // Shared hosts pool by executable identity alone; job-exclusive hosts pool by identity *and* job, so the
  // same job's own stage-then-activate calls reuse one process while a different job never attaches to it.
  return spec.leaseMode === 'shared' ? specIdentityKey(spec) : `${specIdentityKey(spec)} job:${jobId ?? ''}`;
}

function assertLeasePolicy(spec: ProviderServerSpec, jobId: string | undefined): void {
  if (spec.leaseMode === 'job-exclusive' && jobId === undefined) {
    throw new Error('provider_host_policy_invalid: job-exclusive acquisition requires a job id');
  }
}

function hostRefFor(entry: HostPoolEntry, runtime: Runtime): HostRef {
  const identity = {
    provider: entry.spec.provider,
    fingerprint: specFingerprint(runtime, entry.spec),
    instanceId: entry.instanceId,
  } as const;
  if (entry.spec.leaseMode === 'shared') return Object.freeze({ ...identity, leaseMode: 'shared' as const });
  return Object.freeze({ ...identity, leaseMode: 'job-exclusive' as const, ownerJobId: entry.jobId as string });
}

function isMatchingHostRef(hostRef: HostRef, entry: HostPoolEntry, runtime: Runtime): boolean {
  if (hostRef.provider !== entry.spec.provider) return false;
  if (hostRef.fingerprint !== specFingerprint(runtime, entry.spec)) return false;
  if (hostRef.instanceId !== entry.instanceId) return false;
  if (hostRef.leaseMode !== entry.spec.leaseMode) return false;
  return hostRef.leaseMode !== 'job-exclusive' || hostRef.ownerJobId === entry.jobId;
}

function isSameHostRef(left: HostRef, right: HostRef): boolean {
  if (left.provider !== right.provider) return false;
  if (left.fingerprint !== right.fingerprint) return false;
  if (left.instanceId !== right.instanceId) return false;
  if (left.leaseMode !== right.leaseMode) return false;
  if (left.leaseMode === 'shared' && right.leaseMode === 'shared') return true;
  return left.leaseMode === 'job-exclusive' && right.leaseMode === 'job-exclusive'
    ? left.ownerJobId === right.ownerJobId
    : false;
}

export interface ProxyAppServerHostAuthority extends AppServerHostAuthority {
  /** The raw process identity behind an already-open `HostRef`, for the guardian containment report. `null`
   *  when the reference no longer names a live entry this authority holds. */
  rootIdentity(hostRef: HostRef): Readonly<{ pid: number; processStartedAtSeconds: number }> | null;
  closed(hostRef: HostRef): Promise<Error | void> | null;
  forceClose(hostRef: HostRef): Promise<void>;
}

/**
 * The proxy's own narrower stand-in for `DefaultProviderHostManager`: pools app-server children by executable
 * identity (shared) or identity+job (job-exclusive, so this proxy's own stage-then-activate sequence reuses
 * one process rather than spawning twice), ref-counts sessions, and closes a pool entry once its last
 * reference releases. Deliberately does not replicate the coordinator's idle-timer-based early retirement for
 * `idleRetirement: 'host-reported'` shared hosts — every host here stays open until its last referencing
 * operation stops, which is a reported simplification (see the task report), not an attempt to reproduce that
 * policy exactly.
 */
export function createProxyAppServerHostAuthority(runtime: Runtime): ProxyAppServerHostAuthority {
  const entries = new Map<string, HostPoolEntry>();
  const closingEntries = new Set<HostPoolEntry>();
  // Purely informational (mirrors `DefaultProviderHostManager`'s own per-acquisition counter,
  // `src/coordinator/live/admission.ts`); nothing in this pool reads it back.
  let nextGeneration = 0;

  const closeEntry = (entry: HostPoolEntry): Promise<void> => {
    closingEntries.add(entry);
    if (entry.closePromise !== null) return entry.closePromise;
    const closePromise = closeSpawnedHandle(entry.handle, entry.spec, runtime);
    entry.closePromise = closePromise;
    void closePromise.then(
      () => {
        if (entry.closePromise === closePromise) closingEntries.delete(entry);
      },
      () => {
        if (entry.closePromise === closePromise) entry.closePromise = null;
      },
    );
    return closePromise;
  };

  const managedSessionFor = (entry: HostPoolEntry): ManagedHostSession => {
    let released = false;
    entry.refCount += 1;
    return Object.freeze({
      session: entry.transport,
      hostRef: hostRefFor(entry, runtime),
      close: () => {
        if (released) return;
        released = true;
        entry.refCount -= 1;
        if (entry.refCount > 0) return;
        if (entries.get(entry.hostKey) === entry) entries.delete(entry.hostKey);
        void closeEntry(entry).catch((error: unknown) => {
          backendLog.error(
            `semantic operation runtime: app-server host close failed for ${entry.spec.provider}`,
            error,
          );
        });
      },
    });
  };

  return {
    async openSession(spec, options) {
      assertLeasePolicy(spec, options?.jobId);
      const hostKey = hostKeyFor(spec, options?.jobId);
      const existing = entries.get(hostKey);
      if (existing !== undefined) return managedSessionFor(existing);

      const handle = await spawnProviderServerTransport({
        runtime,
        options: spawnOptionsFor(spec, options?.signal),
        generation: nextGeneration++,
      });
      const processStartedAtSeconds = probeProcessStartedAtSeconds(
        handle.pid,
        runtime.env.platform() as NodeJS.Platform,
      );
      if (processStartedAtSeconds === null) {
        await handle.close().catch(() => {});
        throw new Error(`Provider server ${spec.provider} could not have its own start time read after spawn.`);
      }
      const entry: HostPoolEntry = {
        hostKey,
        spec,
        instanceId: runtime.ids.uuid(),
        handle,
        transport: transportFor(handle),
        processStartedAtSeconds,
        jobId: options?.jobId,
        refCount: 0,
        closePromise: null,
      };
      entries.set(hostKey, entry);
      return managedSessionFor(entry);
    },

    async attachSession(hostRef, expectation) {
      const hostKey = hostKeyFor(expectation.spec, expectation.jobId);
      const entry = entries.get(hostKey);
      if (entry === undefined || !isMatchingHostRef(hostRef, entry, runtime)) return null;
      return managedSessionFor(entry);
    },

    rootIdentity(hostRef) {
      for (const entry of entries.values()) {
        if (isMatchingHostRef(hostRef, entry, runtime)) {
          return { pid: entry.handle.pid, processStartedAtSeconds: entry.processStartedAtSeconds };
        }
      }
      return null;
    },

    closed(hostRef) {
      for (const entry of entries.values()) {
        if (isMatchingHostRef(hostRef, entry, runtime)) return entry.transport.closed;
      }
      return null;
    },

    async forceClose(hostRef) {
      let matched: HostPoolEntry | undefined;
      for (const entry of entries.values()) {
        if (isMatchingHostRef(hostRef, entry, runtime)) {
          matched = entry;
          entries.delete(entry.hostKey);
          closingEntries.add(entry);
          break;
        }
      }
      if (matched === undefined) {
        for (const entry of closingEntries) {
          if (isMatchingHostRef(hostRef, entry, runtime)) {
            matched = entry;
            break;
          }
        }
      }
      if (matched !== undefined) await closeEntry(matched);
    },
  };
}

// --- bound-provider reconstruction ----------------------------------------------------------------------

/** `ProviderContinuityBlob` (`src/sessions/continuity.ts`) structurally, without importing it: `src/sessions/`
 *  is forbidden to `provider-proxy/` (`tests/invariants/architecture-layering.test.ts`'s `PROVIDER_PROXY_FORBIDDEN`),
 *  so this derives the identical type from a field this file already legitimately imports rather than naming
 *  the origin module — TypeScript's structural typing makes the two interchangeable at every call site below. */
type DerivedPersistedContinuity = NonNullable<BoundProviderExecutionPreparationInput['persistedContinuity']>;

/** The one JSON shape `persistedContinuity` may hold once decoded off the wire: `null` (no session), or a
 *  provider-opaque record. `ProxyPreparedAppServerOperation.persistedContinuity` is typed `JsonValue | null`
 *  at the wire boundary (§Canonical Values at Boundaries) because the envelope cannot depend on any one
 *  provider's continuity shape; this is where it becomes the canonical `DerivedPersistedContinuity | undefined`
 *  the bound-provider execution contract expects. */
function derivePersistedContinuity(prepared: ProxyPreparedAppServerOperation): DerivedPersistedContinuity | undefined {
  const raw = prepared.persistedContinuity;
  if (raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new TypeError(
      `Prepared operation for provider '${prepared.provider}' carried non-record persisted continuity.`,
    );
  }
  return raw as DerivedPersistedContinuity;
}

/**
 * Rebuilds the `BoundProvider` this operation names from its binding envelope. A fresh built-in registry per
 * call is cheap (pure registration, no I/O) and keeps this function free of shared mutable module state; the
 * host authority it connects is the one live thing every call shares.
 */
type BoundProviderReconstruction =
  | Readonly<{ state: 'reconstructed'; bound: BoundProvider }>
  | ProviderOperationPreparePermanentRefusal;

function prepareRefusal(
  code: ProviderOperationPreparePermanentRefusal['code'],
  disposition: ProviderOperationPreparePermanentRefusal['disposition'],
  reason: string,
): ProviderOperationPreparePermanentRefusal {
  const diagnostic = reason.trim();
  return providerOperationPreparePermanentRefusalSchema.parse({
    state: 'permanent-refusal',
    code,
    disposition,
    reason: (diagnostic.length === 0 ? 'Provider operation prepare was refused.' : diagnostic).slice(0, 4096),
  });
}

function boundedRefusalReason(error: unknown, fallback: string): string {
  const reason = errorMessage(error).trim();
  return (reason.length === 0 ? fallback : reason).slice(0, 4096);
}

function rebuildBoundProvider(
  prepared: ProxyPreparedAppServerOperation,
  authority: AppServerHostAuthority,
): BoundProviderReconstruction {
  const registry = createBuiltInProviderRegistry();
  registry.connectAppServerHost(authority);
  const rehydrated = registry.rehydrateBinding(prepared.binding);
  if (!rehydrated.ok) {
    return prepareRefusal(
      'provider_reconstruction_refused',
      'local-fallback',
      `Prepared operation named provider '${prepared.provider}' with an unrehydratable binding (${rehydrated.failure.reason}).`,
    );
  }
  const bound = rehydrated.value;
  if (bound.name !== prepared.provider) {
    return prepareRefusal(
      'provider_reconstruction_refused',
      'local-fallback',
      `Prepared operation named provider '${prepared.provider}' but its binding rehydrated to '${bound.name}'.`,
    );
  }
  if (bound.appServer === undefined) {
    return prepareRefusal(
      'provider_reconstruction_refused',
      'local-fallback',
      `Provider '${bound.name}' has no app-server capability; this proxy runs app-server operations only.`,
    );
  }
  return { state: 'reconstructed', bound };
}

function stagingInput(runtime: Runtime, prepared: ProxyPreparedAppServerOperation): BoundProviderHostPreparationInput {
  return {
    request: prepared.request,
    persistedContinuity: derivePersistedContinuity(prepared),
    baseEnv: prepared.baseEnv,
    platform: prepared.platform,
    storage: runtime.storage,
  };
}

function executionInput(
  runtime: Runtime,
  prepared: ProxyPreparedAppServerOperation,
): BoundProviderExecutionPreparationInput {
  return {
    request: prepared.request,
    persistedContinuity: derivePersistedContinuity(prepared),
    baseEnv: prepared.baseEnv,
    protectedEnv: prepared.protectedEnv,
    platform: prepared.platform,
    storage: runtime.storage,
  };
}

/** `runtime.continuityBridge.checkpoint()`'s value is dead for both built-in app-server providers: Claude and
 *  Codex each compose `sessionContinuity()` (`src/providers/middleware/session-continuity.ts`) into their own
 *  `run`, and that middleware constructs and injects its *own* bridge into the wrapped runtime before the
 *  inner provider ever reads this one. `src/jobs/shell/launch.ts`'s in-process `NOOP_CONTINUITY_BRIDGE` is the
 *  exact same placeholder for the exact same reason; this is that same precedent, reimplemented here because
 *  `src/jobs/` is forbidden to this domain. See the task report for why the ack-gated checkpoint property the
 *  plan describes is not implementable through this seam at all — it is a property of who calls
 *  `commitContinuityEvent`/`rejectContinuityEvent` on the *yielded* continuity events, not of this bridge. */
function missingContinuityBridge(method: string): never {
  throw new Error(`runtime.continuityBridge.${method}() called without sessionContinuity() middleware.`);
}
const NOOP_CONTINUITY_BRIDGE: BoundProviderAppServerExecutionRuntime['continuityBridge'] = {
  checkpoint: () => missingContinuityBridge('checkpoint'),
  transportClosed: () => missingContinuityBridge('transportClosed'),
};

function buildExecutionRuntime(
  runtime: Runtime,
  key: ProviderOperationKey,
  prepared: ProxyPreparedAppServerOperation,
  signal: AbortSignal,
  onHostRef: BoundProviderAppServerExecutionRuntime['onHostRef'],
): BoundProviderAppServerExecutionRuntime {
  return {
    transport: 'app-server',
    signal,
    time: runtime.time,
    storage: runtime.storage,
    env: runtime.env,
    ids: runtime.ids,
    jobId: key.jobId,
    persistedContinuity: derivePersistedContinuity(prepared),
    continuityBridge: NOOP_CONTINUITY_BRIDGE,
    // Pure functions of this build's own root and the request's own cwd — not job-specific data, so unlike
    // `persistedContinuity`/`request` this needs no wire field at all; the proxy derives it from its own
    // `Runtime` exactly as `LaunchOrchestrator.createProviderRuntime` derives it from the coordinator's.
    kbRoot: runtime.paths.coral.corpus.kbRoot,
    ...(prepared.request.cwd
      ? {
          coralProjects: runtime.paths.projectData(prepared.request.cwd),
          projectSource: runtime.paths.projectSource(prepared.request.cwd),
        }
      : {}),
    // `equippedTools` is intentionally omitted: it is job-specific expansion state
    // (`src/expansion/equipped-tools.ts`) that `ProxyPreparedAppServerOperationV1` does not carry, and this
    // proxy has no store to resolve it from independently. Reported gap, not a silent truncation.
    onAppServerWaiting: () => {},
    onHostRef,
  };
}

// --- per-operation kernel execution and event pumping ----------------------------------------------------

function operationKeyString(key: ProviderOperationKey): string {
  return `${key.jobId} ${key.operationId}`;
}

type StagedOperation = {
  readonly key: ProviderOperationKey;
  readonly abortController: AbortController;
  bound: BoundProvider | null;
  staged: Readonly<{ hostRef: HostRef; close(): void }> | null;
  root: Readonly<{ pid: number; processStartedAtSeconds: number }> | null;
  stageHandle: SemanticOperationStageHandle | null;
  startHandle: SemanticOperationStartHandle | null;
  startCommitted: boolean;
  releaseRequested: boolean;
  closed: boolean;
  hostRef: HostRef | null;
  transportClosed: Promise<Error | void>;
  resolveTransportClosed(error?: Error | void): void;
  /** Set once `stop()` is in flight, so the pump loop's catch-all can tell a deliberate stop from a genuine
   *  unprompted kernel failure and choose the right synthesized outcome (or none, for an interruption). */
  pendingStopCause: ProviderStopCause | null;
  /** Resolves once the pump loop has fully settled; `stop()` awaits this so no event can be emitted after it
   *  returns. `null` until `host.start` assigns it — `stop()` is only ever called after the supervisor has
   *  stored the activation ACK, so by the time it is read it is always set;
   *  mutated in place rather than replacing the map entry, so `start`/`stop` and the pump loop all observe the
   *  same object. */
  done: Promise<void> | null;
};

export type SemanticOperationStageResult =
  | Readonly<{ state: 'staged'; providerRoot: ProviderRootIdentity }>
  | ProviderOperationPreparePermanentRefusal;

export interface SemanticOperationStageHandle {
  readonly result: Promise<SemanticOperationStageResult>;
  abortAndRelease(): Promise<void>;
}

export type SemanticOperationRuntimeOptions = Readonly<{
  runtime: Runtime;
  hostAuthority: ProxyAppServerHostAuthority;
  /** The live `Proxy` this runtime pumps events into and reads ledger state from. Supplied as a getter
   *  because `createProxy` itself needs this runtime's `host` before the `Proxy` it returns can exist —
   *  the same forward-reference shape `role-main.ts` already uses for `guardianRef`/`reaperRef`. */
  getProxy(): Proxy;
}>;

export interface SemanticOperationRuntime {
  readonly host: SemanticOperationHost;
  stage(key: ProviderOperationKey, prepared: ProxyPreparedAppServerOperation): SemanticOperationStageHandle;
  /**
   * Ensures this operation's provider root exists — spawning the underlying app-server child only when no
   * pooled entry already serves it — without starting the operation's own turn. Idempotent per key: a retried
   * `operation.prepare.v1` (dropped reply, coordinator retry) reaches the same pooled entry rather than
   * spawning a second one, because `createProxyAppServerHostAuthority` pools by executable identity (and, for
   * job-exclusive hosts, by job) — the same identity `host.start` below resolves to when it later opens its
   * own session on the same spec.
   */
  ensureProviderRoot(
    key: ProviderOperationKey,
    prepared: ProxyPreparedAppServerOperation,
  ): Promise<SemanticOperationStageResult>;
  /**
   * Stops every kernel this runtime is running and releases every staged-but-never-started provider root —
   * this runtime's own half of a graceful proxy shutdown (`role-main.ts`'s SIGTERM handler). Nothing else
   * drains what `ensureProviderRoot`/`host.start` accumulated in this runtime's own staging table: without
   * it, closing only the control endpoint leaves every kernel running and every app-server child alive until
   * the enforcers escalate to a hard kill, and no provider ever receives its own graceful-shutdown RPC.
   * Best-effort per operation — one kernel's stop failing must not stop this from still stopping every other
   * one — through the same stop and abortable stage handles the supervisor owns.
   */
  shutdown(cause: ProviderStopCause): Promise<void>;
}

export function createSemanticOperationRuntime(options: SemanticOperationRuntimeOptions): SemanticOperationRuntime {
  const { runtime, hostAuthority, getProxy } = options;
  const staged = new Map<string, StagedOperation>();

  const requireStaged = (key: ProviderOperationKey): StagedOperation => {
    const entry = staged.get(operationKeyString(key));
    if (entry === undefined) {
      throw new Error(`No staged provider root for ${key.jobId}/${key.operationId}.`);
    }
    return entry;
  };

  const closeStaged = (entry: StagedOperation): void => {
    if (entry.closed) return;
    entry.closed = true;
    entry.staged?.close();
  };

  const trackHostRef = (entry: StagedOperation, hostRef: HostRef): void => {
    if (entry.hostRef !== null) {
      if (isSameHostRef(entry.hostRef, hostRef)) return;
      throw new Error(`Provider operation ${operationKeyString(entry.key)} reported more than one host reference.`);
    }
    entry.hostRef = hostRef;
    const closed = hostAuthority.closed(hostRef);
    if (closed === null) {
      entry.resolveTransportClosed(new Error('Provider transport closed before a completion event.'));
      return;
    }
    void closed.then(entry.resolveTransportClosed, (error: unknown) => {
      entry.resolveTransportClosed(error instanceof Error ? error : new Error(errorMessage(error)));
    });
  };

  const cancelAndAwait = async (
    entry: StagedOperation,
    reason: Readonly<{ kind: 'release'; cause: Error }> | Readonly<{ kind: 'stop'; cause: ProviderStopCause }>,
  ): Promise<void> => {
    if (reason.kind === 'release') entry.releaseRequested = true;
    else entry.pendingStopCause = reason.cause;
    entry.abortController.abort(reason.cause);

    const completion =
      entry.done ??
      entry.stageHandle?.result.then(
        () => undefined,
        () => undefined,
      ) ??
      Promise.resolve();
    const initialHostRef = entry.hostRef;
    const initialForceClose = initialHostRef === null ? Promise.resolve() : hostAuthority.forceClose(initialHostRef);
    const cancellation = Promise.all([completion, initialForceClose]).then(async () => {
      if (initialHostRef === null && entry.hostRef !== null) await hostAuthority.forceClose(entry.hostRef);
    });
    const deadlineController = new AbortController();
    const deadline = runtime.time
      .sleep(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS, { signal: deadlineController.signal })
      .then(() => {
        if (!deadlineController.signal.aborted) throw new SemanticOperationCancellationTimeoutError();
      });

    try {
      await Promise.race([cancellation, deadline]);
    } finally {
      deadlineController.abort();
    }
    closeStaged(entry);
    const key = operationKeyString(entry.key);
    if (staged.get(key) === entry) staged.delete(key);
  };

  const synthesizeAndEmitFailure = async (
    key: ProviderOperationKey,
    provider: string,
    error: unknown,
  ): Promise<void> => {
    const proxy = getProxy();
    const event: ProviderEventBody = {
      kind: 'terminal',
      terminal: {
        content: '',
        durationMs: 0,
        outcome: { kind: 'failed' },
      },
      diagnostics: {},
      failureCause: providerRequestFailed({ provider, message: errorMessage(error) }),
    };
    try {
      await proxy.emitProviderEvent(key, event);
    } catch {
      /* the ledger entry is gone (already released); nothing left to notify */
    }
  };

  const emitAbortedTerminal = async (key: ProviderOperationKey, cause: ProviderStopCause): Promise<void> => {
    if (!isAbortStopCause(cause)) return;
    const proxy = getProxy();
    const event: ProviderEventBody = {
      kind: 'terminal',
      terminal: { content: '', durationMs: 0, outcome: { kind: 'aborted', reason: cause } },
      diagnostics: {},
    };
    try {
      await proxy.emitProviderEvent(key, event);
    } catch {
      /* ledger entry already gone */
    }
  };

  const runPump = async (
    key: ProviderOperationKey,
    entry: StagedOperation,
    provider: string,
    iterable: AsyncIterable<ProviderEventBody>,
    settleStart: (result: SemanticOperationStartResult) => void,
  ): Promise<void> => {
    const proxy = getProxy();
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      // The stored activation ACK makes a retry return before reaching `host.start`, so nothing outside this
      // single call ever resolves `entry.done` concurrently with it.
      while (true) {
        entry.abortController.signal.throwIfAborted();
        const step = await Promise.race([
          iterator.next(),
          entry.transportClosed.then((error) => {
            throw error ?? new Error('Provider transport closed before a completion event.');
          }),
        ]);
        if (step.done) throw new Error('Provider event stream ended without terminal or suspension.');
        await proxy.emitProviderEvent(key, step.value, entry.abortController.signal);

        if (step.value.kind === 'terminal') {
          try {
            await iterator.return?.();
          } catch (error: unknown) {
            // The terminal already names the outcome; iterator cleanup cannot replace it with another one.
            backendLog.error(
              `semantic operation runtime: terminal iterator cleanup failed for ${operationKeyString(key)}`,
              error,
            );
          }
          break;
        }
        if (step.value.kind === 'suspended') {
          try {
            await iterator.return?.();
          } catch (error: unknown) {
            // Suspension is already durable work; iterator cleanup cannot turn it into a terminal.
            backendLog.error(
              `semantic operation runtime: suspended iterator cleanup failed for ${operationKeyString(key)}`,
              error,
            );
          }
          break;
        }
      }
    } catch (error: unknown) {
      if (!entry.startCommitted) {
        settleStart({ kind: 'never-started', reason: errorMessage(error) });
        return;
      }
      if (entry.releaseRequested) return;
      const cause = entry.pendingStopCause;
      if (cause !== null) {
        // A `stop()` was already in flight when the kernel unwound — trust why we asked it to stop rather
        // than the shape of what it threw. Interruption causes (restart/handoff) emit nothing: the coordinator
        // synthesizes `session.interrupted` itself from `operation.stop.v1`'s own `suspended-awaiting-durable-
        // decision` reply, not from a provider event this proxy would have to invent.
        if (isAbortStopCause(cause)) await emitAbortedTerminal(key, cause);
        return;
      }
      // Nobody asked this operation to stop; the kernel unwound on its own. A terminal must still reach the
      // coordinator (see the task report's "kernel throws mid-stream" judgement) — synthesize one rather than
      // leaving the ledger entry executing forever with nothing to end it.
      await synthesizeAndEmitFailure(key, provider, error);
    } finally {
      if (!entry.startCommitted) {
        settleStart({ kind: 'never-started', reason: 'The provider ended before its start boundary.' });
      }
      if (!entry.releaseRequested && entry.pendingStopCause === null) closeStaged(entry);
    }
  };

  const host: SemanticOperationHost = {
    start: ({ key, prepared }) => {
      const entry = requireStaged(key);
      if (entry.startHandle !== null) return entry.startHandle;
      let settled = false;
      let settle!: (result: SemanticOperationStartResult) => void;
      const result = new Promise<SemanticOperationStartResult>((resolve) => {
        settle = (outcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
      });
      entry.done = Promise.resolve().then(async () => {
        const bound = entry.bound;
        if (bound === null) {
          settle({ kind: 'never-started', reason: 'The provider stage did not finish.' });
          return;
        }
        try {
          const preparedExecution = bound.prepareExecution(executionInput(runtime, prepared));
          if (preparedExecution.kind !== 'app-server') {
            throw new Error(
              `Provider '${bound.name}' prepared a standalone execution; this proxy runs app-server operations only.`,
            );
          }
          const executionRuntime = buildExecutionRuntime(
            runtime,
            key,
            prepared,
            entry.abortController.signal,
            (hostRef) => {
              trackHostRef(entry, hostRef);
              entry.abortController.signal.throwIfAborted();
              entry.startCommitted = true;
              settle({ kind: 'started', hostRef });
            },
          );
          const iterable = preparedExecution.execute(executionRuntime);
          await runPump(key, entry, bound.name, iterable, settle);
        } catch (error: unknown) {
          if (!entry.startCommitted) settle({ kind: 'never-started', reason: errorMessage(error) });
          else if (!entry.releaseRequested) await synthesizeAndEmitFailure(key, bound.name, error);
        }
      });
      const abortAndRelease = (): Promise<void> =>
        cancelAndAwait(entry, {
          kind: 'release',
          cause: new Error('Provider operation activation was released.'),
        });
      const handle: SemanticOperationStartHandle = Object.freeze({ result, abortAndRelease });
      entry.startHandle = handle;
      return handle;
    },

    stop: async ({ key, cause }) => {
      const entry = requireStaged(key);
      await cancelAndAwait(entry, { kind: 'stop', cause });
    },
  };

  const stage = (
    key: ProviderOperationKey,
    prepared: ProxyPreparedAppServerOperation,
  ): SemanticOperationStageHandle => {
    const keyStr = operationKeyString(key);
    const existing = staged.get(keyStr);
    if (existing?.stageHandle !== null && existing?.stageHandle !== undefined) return existing.stageHandle;

    const abortController = new AbortController();
    let resolveTransportClosed!: (error?: Error | void) => void;
    const transportClosed = new Promise<Error | void>((resolve) => {
      resolveTransportClosed = resolve;
    });
    const entry: StagedOperation = {
      key,
      abortController,
      bound: null,
      staged: null,
      root: null,
      stageHandle: null,
      startHandle: null,
      startCommitted: false,
      releaseRequested: false,
      closed: false,
      hostRef: null,
      transportClosed,
      resolveTransportClosed,
      pendingStopCause: null,
      done: null,
    };
    staged.set(keyStr, entry);
    const result = Promise.resolve().then(async () => {
      const rebuilt = rebuildBoundProvider(prepared, hostAuthority);
      if (rebuilt.state === 'permanent-refusal') return rebuilt;
      const bound = rebuilt.bound;
      entry.bound = bound;
      const appServer = bound.appServer;
      if (appServer === undefined) {
        return prepareRefusal(
          'provider_reconstruction_refused',
          'local-fallback',
          `Provider '${bound.name}' has no app-server capability; this proxy runs app-server operations only.`,
        );
      }
      let input: BoundProviderHostPreparationInput;
      try {
        input = stagingInput(runtime, prepared);
      } catch (error: unknown) {
        return prepareRefusal(
          'provider_reconstruction_refused',
          'local-fallback',
          boundedRefusalReason(error, 'The provider operation could not be reconstructed.'),
        );
      }
      let openedStaging: Awaited<ReturnType<typeof appServer.openReplacement>>;
      try {
        openedStaging = await appServer.openReplacement(input, {
          jobId: key.jobId,
          signal: abortController.signal,
        });
      } catch (error: unknown) {
        if (abortController.signal.aborted) throw error;
        return prepareRefusal(
          'provider_creation_refused',
          'local-fallback',
          boundedRefusalReason(error, 'The provider root could not be created.'),
        );
      }
      entry.staged = openedStaging;
      trackHostRef(entry, openedStaging.hostRef);
      abortController.signal.throwIfAborted();
      const root = hostAuthority.rootIdentity(openedStaging.hostRef);
      if (root === null) {
        closeStaged(entry);
        return prepareRefusal(
          'provider_creation_refused',
          'local-fallback',
          `Staged provider root for ${key.jobId}/${key.operationId} vanished before it could be reported.`,
        );
      }
      entry.root = root;
      return { state: 'staged' as const, providerRoot: root };
    });
    const abortAndRelease = (): Promise<void> =>
      cancelAndAwait(entry, { kind: 'release', cause: new Error('Provider operation stage was released.') });
    const handle: SemanticOperationStageHandle = Object.freeze({ result, abortAndRelease });
    entry.stageHandle = handle;
    return handle;
  };

  return {
    stage,

    ensureProviderRoot: (key, prepared) => stage(key, prepared).result,

    host,

    async shutdown(cause) {
      // Snapshot first: `host.stop`/`host.releaseStaged` both delete from `staged` as they settle, and
      // iterating a `Map` while deleting from it under concurrent `Promise.all` settlement is exactly the
      // kind of thing this snapshot exists to rule out.
      const entries = [...staged.values()];
      await Promise.all(
        entries.map(async (entry) => {
          try {
            await cancelAndAwait(
              entry,
              entry.done === null
                ? { kind: 'release', cause: new Error('Provider operation shutdown released its stage.') }
                : { kind: 'stop', cause },
            );
          } catch (error: unknown) {
            backendLog.error(
              `semantic operation runtime: shutdown could not stop ${operationKeyString(entry.key)}`,
              error,
            );
          }
        }),
      );
    },
  };
}
