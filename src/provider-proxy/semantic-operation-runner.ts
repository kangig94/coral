import type { ProcessIncarnation } from '../infra/node-process.js';
import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { Runtime } from '../runtime/ports.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import { providerRequestFailed } from '../providers/fault.js';
import {
  isAbortStopCause,
  type HostRef,
  type ProviderEventBody,
  type ProviderStopCause,
} from '../providers/contract.js';
import type { AppServerHostAuthority } from '../providers/internal/app-server-host.js';
import { ProviderHostUnserviceableError } from '../providers/host-admission.js';
import type {
  BoundProvider,
  BoundProviderAppServerExecutionRuntime,
  BoundProviderExecutionPreparationInput,
  BoundProviderHostPreparationInput,
} from '../providers/bound-provider-contract.js';
import type { ProviderOperationKey, ProviderRootIdentity } from './ledger.js';
import {
  ContinuityCommitDeliveryError,
  type ContinuityCommitSettlement,
  type SemanticOperationHost,
  type SemanticOperationStartHandle,
  type SemanticOperationStartResult,
} from './operation-supervisor.js';
import {
  type ProxyAppServerHostAuthority,
  type ProxyHostCancellationMode,
  type ProxyOperationHostScope,
  ProxyProviderRootCapacityError,
} from './provider-root-authority.js';
import type { Proxy } from './proxy.js';
import {
  providerOperationPreparePermanentRefusalSchema,
  proxyOperationPrepareCapacityResultSchema,
  ProxyControlProtocolError,
  type ProviderOperationPreparePermanentRefusal,
  type ProxyOperationPrepareCapacityResult,
  type ProxyPreparedAppServerOperation,
} from './protocol.js';

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

/**
 * Reconstructs and runs the live Claude/Codex kernel inside the proxy process.
 *
 * The coordinator never runs a kernel after proxy admission (plan §"Process topology, endpoint, guardian, and
 * authentication"): it prepares strict data and transactionally applies acknowledged semantic events. This
 * module is where that data turns back into a running `BoundProvider` — the proxy-local mirror of what
 * `src/jobs/shell/launch.ts` does in-process, minus everything that only makes sense with store/journal access.
 *
 * Judgement call: a proxy-local `DefaultProviderHostManager`
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

export class SemanticOperationAdmissionClosedError extends ProxyControlProtocolError {
  constructor() {
    super(
      'semantic_operation_admission_closed',
      'semantic_operation_admission_closed: semantic operation runtime no longer accepts new work.',
    );
    this.name = 'SemanticOperationAdmissionClosedError';
    Object.setPrototypeOf(this, SemanticOperationAdmissionClosedError.prototype);
  }
}

export class SemanticOperationCancellationUnconfirmedError extends ProxyControlProtocolError {
  readonly key: ProviderOperationKey;

  constructor(key: ProviderOperationKey, reason: string) {
    super(
      'semantic_operation_cancellation_unconfirmed',
      `semantic_operation_cancellation_unconfirmed: cancellation of ${key.jobId}/${key.operationId} was not confirmed: ${reason}`,
    );
    this.name = 'SemanticOperationCancellationUnconfirmedError';
    this.key = key;
    Object.setPrototypeOf(this, SemanticOperationCancellationUnconfirmedError.prototype);
  }
}

export type SemanticOperationShutdownFailure = Readonly<{
  key: ProviderOperationKey;
  kind: 'cancellation-failed' | 'operation-survived';
  reason: string;
}>;

export class SemanticOperationShutdownError extends Error {
  readonly code = 'semantic_operation_shutdown_incomplete';
  readonly failures: readonly SemanticOperationShutdownFailure[];

  constructor(failures: readonly SemanticOperationShutdownFailure[]) {
    super(`semantic_operation_shutdown_incomplete: ${failures.length} provider operation(s) did not drain.`);
    this.name = 'SemanticOperationShutdownError';
    this.failures = Object.freeze([...failures]);
    Object.setPrototypeOf(this, SemanticOperationShutdownError.prototype);
  }
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

type BoundProviderReconstruction =
  | Readonly<{ state: 'reconstructed'; bound: BoundProvider }>
  | ProviderOperationPreparePermanentRefusal;

function prepareRefusal(
  code: Exclude<ProviderOperationPreparePermanentRefusal['code'], 'provider_host_unserviceable'>,
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

/**
 * A fresh built-in registry per call is cheap (pure registration, no I/O) and keeps this function free of
 * shared mutable module state; the host authority it connects is the one live thing every call shares.
 */
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
 *  `src/jobs/` is forbidden to this domain. The ack-gated checkpoint property the plan describes is not
 *  implementable through this seam at all — it is a property of who calls
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
  onProviderTurnTerminal: BoundProviderAppServerExecutionRuntime['onProviderTurnTerminal'],
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
    // (`src/expansion/equipped-tools.ts`), and this proxy has no store to resolve it from independently.
    // Reported gap, not a silent truncation.
    onAppServerWaiting: () => {},
    onHostRef,
    onProviderTurnTerminal,
  };
}

// --- per-operation kernel execution and event pumping ----------------------------------------------------

function operationKeyString(key: ProviderOperationKey): string {
  return `${key.jobId} ${key.operationId}`;
}

type StagedOperation = {
  readonly key: ProviderOperationKey;
  readonly abortController: AbortController;
  readonly hostScope: ProxyOperationHostScope;
  bound: BoundProvider | null;
  cancellationMode: ProxyHostCancellationMode | null;
  cancellationEvidence: OperationCancellationEvidence | null;
  cancellationPromise: Promise<void> | null;
  staged: Readonly<{ hostRef: HostRef; close(): void }> | null;
  root: Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null;
  stageHandle: SemanticOperationStageHandle | null;
  startHandle: SemanticOperationStartHandle | null;
  startCommitted: boolean;
  releaseRequested: boolean;
  activeContinuitySettlement: ContinuityCommitSettlement | null;
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

export type OperationCancellationEvidence =
  | Readonly<{ kind: 'not-started' }>
  | Readonly<{ kind: 'interrupt-confirmed' }>
  | Readonly<{ kind: 'interrupt-unconfirmed'; reason: string }>
  | Readonly<{ kind: 'isolated-root-closed' }>;

export type SemanticOperationStageResult =
  | Readonly<{ state: 'staged'; providerRoot: ProviderRootIdentity }>
  | ProviderOperationPreparePermanentRefusal
  | ProxyOperationPrepareCapacityResult;

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
  onRelinquish?(error: SemanticOperationCancellationUnconfirmedError): void;
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
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;

  const assertAdmissionOpen = (): void => {
    if (closing) throw new SemanticOperationAdmissionClosedError();
  };
  let relinquishmentFailure: SemanticOperationCancellationUnconfirmedError | null = null;

  const admissionCheckedHostScope = (scope: ProxyOperationHostScope): ProxyOperationHostScope => ({
    selectCancellationMode: (mode) => scope.selectCancellationMode(mode),
    openSession: (spec, hostOptions) => {
      assertAdmissionOpen();
      return scope.openSession(spec, hostOptions);
    },
    attachSession: (hostRef, expectation) => {
      assertAdmissionOpen();
      return scope.attachSession(hostRef, expectation);
    },
  });

  const requireSetRelinquishment = (
    entry: StagedOperation,
    reason: string,
  ): SemanticOperationCancellationUnconfirmedError => {
    closing = true;
    if (relinquishmentFailure !== null) return relinquishmentFailure;
    const failure = new SemanticOperationCancellationUnconfirmedError(entry.key, reason);
    relinquishmentFailure = failure;
    options.onRelinquish?.(failure);
    return failure;
  };

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

  const closeAndForget = (entry: StagedOperation): void => {
    closeStaged(entry);
    const key = operationKeyString(entry.key);
    if (staged.get(key) === entry) staged.delete(key);
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

  const withinCancellationDeadline = async (operation: Promise<void>): Promise<void> => {
    const deadlineController = new AbortController();
    const deadline = runtime.time
      .sleep(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS, { signal: deadlineController.signal })
      .then(() => {
        if (!deadlineController.signal.aborted) throw new SemanticOperationCancellationTimeoutError();
      });
    try {
      await Promise.race([operation, deadline]);
    } finally {
      deadlineController.abort();
    }
  };

  const driveCancellation = async (
    entry: StagedOperation,
    reason: Readonly<{ kind: 'release'; cause: Error }> | Readonly<{ kind: 'stop'; cause: ProviderStopCause }>,
  ): Promise<void> => {
    if (reason.kind === 'release') entry.releaseRequested = true;
    else entry.pendingStopCause = reason.cause;
    entry.activeContinuitySettlement?.reject(
      reason.kind === 'release'
        ? new ContinuityCommitDeliveryError(
            'continuity_commit_operation_released',
            'The operation was released before the continuity checkpoint was committed.',
          )
        : new ContinuityCommitDeliveryError(
            'continuity_commit_operation_cancelled',
            'The operation was cancelled before the continuity checkpoint was committed.',
          ),
    );
    entry.abortController.abort(reason.cause);

    const completion: Promise<void> =
      entry.done ??
      entry.stageHandle?.result.then(
        () => undefined,
        () => undefined,
      ) ??
      Promise.resolve();
    if (!entry.startCommitted) {
      const release = completion.then(async () => {
        if (entry.cancellationMode === 'operation-isolated' && entry.hostRef !== null) {
          await hostAuthority.forceClose(entry.hostRef);
        }
      });
      await withinCancellationDeadline(release).catch((error: unknown) => {
        throw requireSetRelinquishment(entry, errorMessage(error));
      });
      entry.cancellationEvidence = { kind: 'not-started' };
      closeAndForget(entry);
      return;
    }

    if (entry.cancellationMode === 'shared-acknowledged-interrupt') {
      await withinCancellationDeadline(completion).catch((error: unknown) => {
        throw requireSetRelinquishment(entry, errorMessage(error));
      });
      const evidence = entry.cancellationEvidence;
      if (evidence?.kind !== 'interrupt-confirmed') {
        const unconfirmedReason =
          evidence?.kind === 'interrupt-unconfirmed'
            ? evidence.reason
            : 'the provider settled without exact interrupt confirmation';
        throw requireSetRelinquishment(entry, unconfirmedReason);
      }
      closeAndForget(entry);
      return;
    }

    if (entry.cancellationMode !== 'operation-isolated') {
      throw new Error(`Provider operation ${operationKeyString(entry.key)} has no cancellation mode.`);
    }
    const initialHostRef = entry.hostRef;
    const initialForceClose = initialHostRef === null ? Promise.resolve() : hostAuthority.forceClose(initialHostRef);
    const isolatedCancellation = Promise.all([completion, initialForceClose]).then(async () => {
      if (initialHostRef === null && entry.hostRef !== null) await hostAuthority.forceClose(entry.hostRef);
    });
    await withinCancellationDeadline(isolatedCancellation).catch((error: unknown) => {
      throw requireSetRelinquishment(entry, errorMessage(error));
    });
    entry.cancellationEvidence = { kind: 'isolated-root-closed' };
    closeAndForget(entry);
  };

  const cancelAndAwait = (
    entry: StagedOperation,
    reason: Readonly<{ kind: 'release'; cause: Error }> | Readonly<{ kind: 'stop'; cause: ProviderStopCause }>,
  ): Promise<void> => {
    if (entry.cancellationPromise !== null) return entry.cancellationPromise;
    entry.cancellationPromise = driveCancellation(entry, reason);
    return entry.cancellationPromise;
  };

  const synthesizeAndEmitFailure = (key: ProviderOperationKey, provider: string, error: unknown): void => {
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
      proxy.emitProviderEvent(key, event);
    } catch {
      /* the ledger entry is gone (already released); nothing left to notify */
    }
  };

  const emitAbortedTerminal = (key: ProviderOperationKey, cause: ProviderStopCause): void => {
    if (!isAbortStopCause(cause)) return;
    const proxy = getProxy();
    const event: ProviderEventBody = {
      kind: 'terminal',
      terminal: { content: '', durationMs: 0, outcome: { kind: 'aborted', reason: cause } },
      diagnostics: {},
    };
    try {
      proxy.emitProviderEvent(key, event);
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
        if (step.value.kind === 'suspended') {
          entry.cancellationEvidence = { kind: 'interrupt-unconfirmed', reason: step.value.reason };
        }
        const emission = proxy.emitProviderEvent(key, step.value);

        if (emission.kind === 'proxy-emergency-terminal') {
          try {
            await iterator.return?.();
          } catch (error: unknown) {
            backendLog.error(
              `semantic operation runtime: replay-refusal iterator cleanup failed for ${operationKeyString(key)}`,
              error,
            );
          }
          break;
        }

        if (emission.kind === 'continuity-recorded') {
          const settlement = emission.settlement;
          entry.activeContinuitySettlement = settlement;
          try {
            await settlement.committed;
          } finally {
            if (entry.activeContinuitySettlement === settlement) entry.activeContinuitySettlement = null;
          }
        }

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
        if (entry.cancellationMode === 'shared-acknowledged-interrupt') {
          entry.cancellationEvidence = { kind: 'interrupt-unconfirmed', reason: errorMessage(error) };
        }
        // A `stop()` was already in flight when the kernel unwound — trust why we asked it to stop rather
        // than the shape of what it threw. Interruption causes (restart/handoff) emit nothing: the coordinator
        // synthesizes `session.interrupted` itself from `operation.stop.v1`'s own `suspended-awaiting-durable-
        // decision` reply, not from a provider event this proxy would have to invent.
        if (isAbortStopCause(cause)) emitAbortedTerminal(key, cause);
        return;
      }
      // Nobody asked this operation to stop; the kernel unwound on its own. A terminal must still reach the
      // coordinator — synthesize one rather than leaving the ledger entry executing forever with nothing to
      // end it.
      synthesizeAndEmitFailure(key, provider, error);
    } finally {
      if (!entry.startCommitted) {
        settleStart({ kind: 'never-started', reason: 'The provider ended before its start boundary.' });
      }
      if (!entry.releaseRequested && entry.pendingStopCause === null) closeStaged(entry);
    }
  };

  const host: SemanticOperationHost = {
    start: ({ key, prepared }) => {
      assertAdmissionOpen();
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
            () => {
              entry.cancellationEvidence = { kind: 'interrupt-confirmed' };
            },
          );
          const iterable = preparedExecution.execute(executionRuntime);
          await runPump(key, entry, bound.name, iterable, settle);
        } catch (error: unknown) {
          if (!entry.startCommitted) settle({ kind: 'never-started', reason: errorMessage(error) });
          else if (!entry.releaseRequested) {
            if (entry.cancellationMode === 'shared-acknowledged-interrupt' && entry.pendingStopCause !== null) {
              entry.cancellationEvidence = { kind: 'interrupt-unconfirmed', reason: errorMessage(error) };
            } else {
              synthesizeAndEmitFailure(key, bound.name, error);
            }
          }
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
    assertAdmissionOpen();
    const keyStr = operationKeyString(key);
    const existing = staged.get(keyStr);
    if (existing?.stageHandle !== null && existing?.stageHandle !== undefined) return existing.stageHandle;

    const abortController = new AbortController();
    const hostScope = admissionCheckedHostScope(hostAuthority.beginOperation(key));
    let resolveTransportClosed!: (error?: Error | void) => void;
    const transportClosed = new Promise<Error | void>((resolve) => {
      resolveTransportClosed = resolve;
    });
    const entry: StagedOperation = {
      key,
      abortController,
      hostScope,
      bound: null,
      cancellationMode: null,
      cancellationEvidence: null,
      cancellationPromise: null,
      staged: null,
      root: null,
      stageHandle: null,
      startHandle: null,
      startCommitted: false,
      releaseRequested: false,
      activeContinuitySettlement: null,
      closed: false,
      hostRef: null,
      transportClosed,
      resolveTransportClosed,
      pendingStopCause: null,
      done: null,
    };
    staged.set(keyStr, entry);
    const result = Promise.resolve().then(async () => {
      assertAdmissionOpen();
      const rebuilt = rebuildBoundProvider(prepared, hostScope);
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
      const cancellationMode: ProxyHostCancellationMode = appServer.supportsInterrupt
        ? 'shared-acknowledged-interrupt'
        : 'operation-isolated';
      hostScope.selectCancellationMode(cancellationMode);
      entry.cancellationMode = cancellationMode;
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
        assertAdmissionOpen();
        openedStaging = await appServer.openReplacement(input, {
          jobId: key.jobId,
          signal: abortController.signal,
        });
      } catch (error: unknown) {
        if (abortController.signal.aborted) throw error;
        if (error instanceof ProviderHostUnserviceableError) {
          return providerOperationPreparePermanentRefusalSchema.parse({
            state: 'permanent-refusal',
            code: error.code,
            disposition: 'terminal-failure',
            reason: error.message,
            hostRef: error.hostRef,
            remediation: error.remediation,
          });
        }
        if (error instanceof ProxyProviderRootCapacityError) {
          return proxyOperationPrepareCapacityResultSchema.parse({
            state: 'capacity',
            retryable: true,
            code: error.code,
            reason: error.message,
          });
        }
        return prepareRefusal(
          'provider_creation_refused',
          'local-fallback',
          boundedRefusalReason(error, 'The provider root could not be created.'),
        );
      }
      entry.staged = openedStaging;
      assertAdmissionOpen();
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

    shutdown: (cause) => {
      if (shutdownPromise !== null) return shutdownPromise;
      closing = true;
      const entries = [...staged.values()];
      for (const entry of entries) {
        entry.activeContinuitySettlement?.reject(
          new ContinuityCommitDeliveryError(
            'continuity_commit_proxy_shutdown',
            'The provider proxy shut down before the continuity checkpoint was committed.',
          ),
        );
      }
      shutdownPromise = (async () => {
        const results = await Promise.allSettled(
          entries.map((entry) =>
            cancelAndAwait(
              entry,
              entry.done === null
                ? { kind: 'release', cause: new Error('Provider operation shutdown released its stage.') }
                : { kind: 'stop', cause },
            ),
          ),
        );
        const failures: SemanticOperationShutdownFailure[] = [];
        const rejectedKeys = new Set<string>();
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') return;
          const entry = entries[index];
          if (entry === undefined) return;
          const key = operationKeyString(entry.key);
          rejectedKeys.add(key);
          failures.push({ key: entry.key, kind: 'cancellation-failed', reason: errorMessage(result.reason) });
        });
        for (const [key, entry] of staged) {
          if (rejectedKeys.has(key)) continue;
          failures.push({
            key: entry.key,
            kind: 'operation-survived',
            reason: 'Operation remained staged after its shutdown cancellation fulfilled.',
          });
        }
        if (failures.length > 0) throw new SemanticOperationShutdownError(failures);
      })();
      return shutdownPromise;
    },
  };
}
