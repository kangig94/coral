import { hostFingerprintFromSpec } from '../providers/host-identity.js';
import { observePromise, raceWithSignal } from '../infra/promise-signal.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import { backendLog } from '../infra/backend-log.js';
import { errorMessage } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '../infra/process-constants.js';
import type { Runtime } from '../runtime/ports.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import { providerRequestFailed } from '../providers/fault.js';
import { providerProxyRekeyRefusalEvent } from '../providers/proxy-failure.js';
import {
  isAbortStopCause,
  type HostRef,
  type ProviderEventBody,
  type ProviderStopCause,
  type ProviderTurnTerminalEvidence,
  type ProviderTurnSettlement,
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
  type ProxyOperationCancellationHold,
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
const TURN_SETTLEMENT_OBSERVATION_ATTEMPTS = 3;

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

function stagingInput(
  runtime: Runtime,
  hostRoot: string,
  prepared: ProxyPreparedAppServerOperation,
): BoundProviderHostPreparationInput {
  return {
    hostRoot,
    request: prepared.request,
    persistedContinuity: derivePersistedContinuity(prepared),
    baseEnv: prepared.baseEnv,
    platform: prepared.platform,
    storage: runtime.storage,
  };
}

function executionInput(
  runtime: Runtime,
  hostRoot: string,
  prepared: ProxyPreparedAppServerOperation,
): BoundProviderExecutionPreparationInput {
  return {
    hostRoot,
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
  onProviderTurnSettlement: NonNullable<BoundProviderAppServerExecutionRuntime['onProviderTurnSettlement']>,
  onProviderTurnStart: NonNullable<BoundProviderAppServerExecutionRuntime['onProviderTurnStart']>,
  onProviderTurnNotSubmitted: NonNullable<BoundProviderAppServerExecutionRuntime['onProviderTurnNotSubmitted']>,
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
    onProviderTurnSettlement,
    onProviderTurnStart,
    onProviderTurnNotSubmitted,
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
  readonly cancellationDeadlineController: AbortController;
  cancellationExpired: Promise<SemanticOperationCancellationTimeoutError>;
  resolveCancellationExpired(error: SemanticOperationCancellationTimeoutError): void;
  turnSettlement: ProviderTurnSettlement | null;
  settlementRefusals: number;
  completionEmitted: boolean;
  staged: Readonly<{ hostRef: HostRef; close(): void }> | null;
  root: Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null;
  stageHandle: SemanticOperationStageHandle | null;
  startHandle: SemanticOperationStartHandle | null;
  startCommitted: boolean;
  providerTurnSubmission: 'unknown' | 'not-submitted' | 'submitted';
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
  | Readonly<{ kind: 'provider-turn-terminal'; terminal: ProviderTurnTerminalEvidence }>
  | Readonly<{ kind: 'interrupt-unconfirmed'; reason: string }>
  | Readonly<{ kind: 'isolated-root-closed' }>;

function currentTurnTerminalEvidence(entry: StagedOperation): ProviderTurnTerminalEvidence | null {
  const evidence = entry.cancellationEvidence;
  if (evidence?.kind !== 'provider-turn-terminal') return null;
  if (entry.turnSettlement !== null && evidence.terminal.providerTurnId !== entry.turnSettlement.providerTurnId)
    return null;
  return evidence.terminal;
}

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
  hostRoot: string;
  hostFingerprint: string;
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

type SemanticOperationRuntimeState = {
  staged: Map<string, StagedOperation>;
  closing: boolean;
  shutdownPromise: Promise<void> | null;
  relinquishmentFailure: SemanticOperationCancellationUnconfirmedError | null;
};

function createSemanticTerminalEvents(getProxy: SemanticOperationRuntimeOptions['getProxy']) {
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
      // Failure reporting must not throw out of the request-failure path.
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

  const emitRekeyRefusalTerminal = (entry: StagedOperation, provider: string, detail?: string): void => {
    getProxy().emitProviderEvent(entry.key, providerProxyRekeyRefusalEvent(provider, detail));
    entry.completionEmitted = true;
  };

  return { synthesizeAndEmitFailure, emitAbortedTerminal, emitRekeyRefusalTerminal };
}

async function closeSemanticEventIterator(
  iterator: AsyncIterator<ProviderEventBody>,
  key: ProviderOperationKey,
  phase: 'replay-refusal' | 'terminal' | 'suspended',
  cancellationExpired: StagedOperation['cancellationExpired'],
): Promise<void> {
  try {
    await Promise.race([iterator.return?.(), cancellationExpired]);
  } catch (error: unknown) {
    backendLog.error(
      `semantic operation runtime: ${phase} iterator cleanup failed for ${operationKeyString(key)}`,
      error,
    );
  }
}

function createSemanticOperationEventPump(
  getProxy: SemanticOperationRuntimeOptions['getProxy'],
  closeStaged: (entry: StagedOperation) => void,
) {
  const { synthesizeAndEmitFailure, emitAbortedTerminal, emitRekeyRefusalTerminal } =
    createSemanticTerminalEvents(getProxy);

  const runPump = async (
    key: ProviderOperationKey,
    entry: StagedOperation,
    provider: string,
    iterable: AsyncIterable<ProviderEventBody>,
    settleStart: (result: SemanticOperationStartResult) => void,
  ): Promise<void> => {
    const proxy = getProxy();
    const iterator = iterable[Symbol.asyncIterator]();
    const transport = observePromise(entry.transportClosed);
    const interrupted = AbortSignal.any([transport.signal, entry.cancellationDeadlineController.signal]);
    try {
      // The stored activation ACK makes a retry return before reaching `host.start`, so nothing outside this
      // single call ever resolves `entry.done` concurrently with it.
      while (true) {
        entry.cancellationDeadlineController.signal.throwIfAborted();
        // A started shared turn owns interrupt confirmation; drain its terminal or suspension under
        // driveCancellation's deadline rather than interrupting the pump between provider events.
        if (!entry.startCommitted || entry.cancellationMode !== 'shared-acknowledged-interrupt')
          entry.abortController.signal.throwIfAborted();
        const step = await raceWithSignal(iterator.next(), interrupted, () => {
          entry.cancellationDeadlineController.signal.throwIfAborted();
          throw transport.result() ?? new Error('Provider transport closed before a completion event.');
        });
        entry.cancellationDeadlineController.signal.throwIfAborted();
        if (step.done) throw new Error('Provider event stream ended without terminal or suspension.');
        if (step.value.kind === 'suspended' && currentTurnTerminalEvidence(entry) === null) {
          entry.cancellationEvidence = { kind: 'interrupt-unconfirmed', reason: step.value.reason };
        }
        const emission = proxy.emitProviderEvent(key, step.value);
        if (step.value.kind === 'terminal' || step.value.kind === 'suspended') {
          entry.completionEmitted = true;
        }

        if (emission.kind === 'proxy-emergency-terminal') {
          entry.completionEmitted = true;
          await closeSemanticEventIterator(iterator, key, 'replay-refusal', entry.cancellationExpired);
          break;
        }

        if (emission.kind === 'continuity-recorded') {
          const settlement = emission.settlement;
          entry.activeContinuitySettlement = settlement;
          try {
            await raceWithSignal(settlement.committed, entry.cancellationDeadlineController.signal, () =>
              entry.cancellationDeadlineController.signal.throwIfAborted(),
            );
          } finally {
            if (entry.activeContinuitySettlement === settlement) entry.activeContinuitySettlement = null;
          }
        }

        if (step.value.kind === 'terminal') {
          await closeSemanticEventIterator(iterator, key, 'terminal', entry.cancellationExpired);
          break;
        }
        if (step.value.kind === 'suspended') {
          await closeSemanticEventIterator(iterator, key, 'suspended', entry.cancellationExpired);
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
        if (entry.cancellationMode === 'shared-acknowledged-interrupt' && currentTurnTerminalEvidence(entry) === null) {
          entry.cancellationEvidence = { kind: 'interrupt-unconfirmed', reason: errorMessage(error) };
        }

        if (cause === 'coordinator_rekey_refused') {
          emitRekeyRefusalTerminal(entry, provider, errorMessage(error));
        } else if (isAbortStopCause(cause)) {
          emitAbortedTerminal(key, cause);
        }
        return;
      }

      synthesizeAndEmitFailure(key, provider, error);
    } finally {
      if (!entry.startCommitted) {
        settleStart({ kind: 'never-started', reason: 'The provider ended before its start boundary.' });
      }
      if (!entry.releaseRequested && entry.pendingStopCause === null && entry.turnSettlement === null)
        closeStaged(entry);
    }
  };

  return { synthesizeAndEmitFailure, emitRekeyRefusalTerminal, runPump };
}

async function withinSemanticCancellationDeadline(
  runtime: SemanticOperationRuntimeOptions['runtime'],
  entry: StagedOperation,
  operation: Promise<void>,
): Promise<void> {
  entry.cancellationDeadlineController.signal.throwIfAborted();
  const deadlineController = new AbortController();
  const deadline = runtime.time
    .sleep(SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS, { signal: deadlineController.signal })
    .then(() => {
      if (!deadlineController.signal.aborted) {
        const error = new SemanticOperationCancellationTimeoutError();
        entry.cancellationDeadlineController.abort(error);
        entry.resolveCancellationExpired(error);
        throw error;
      }
    });
  try {
    await Promise.race([operation, deadline]);
  } finally {
    deadlineController.abort();
  }
}

function createSemanticOperationCancellation(
  options: SemanticOperationRuntimeOptions,
  closeAndForget: (entry: StagedOperation) => void,
  requireSetRelinquishment: (entry: StagedOperation, reason: string) => SemanticOperationCancellationUnconfirmedError,
  emitRekeyRefusalTerminal: (entry: StagedOperation, provider: string, detail?: string) => void,
) {
  const { runtime, hostAuthority } = options;
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

    const forceClose = async (hostRef: HostRef): Promise<void> => {
      const cleanup = await hostAuthority.forceClose(hostRef);
      if (cleanup?.kind === 'held-alive' || cleanup?.kind === 'held-unobservable') {
        throw requireSetRelinquishment(entry, `${cleanup.subject.kind}:${cleanup.observation}`);
      }
      if (cleanup?.kind === 'provider-shutdown-held-alive' || cleanup?.kind === 'provider-shutdown-held-unobservable') {
        throw requireSetRelinquishment(entry, `${cleanup.subject.kind}:${cleanup.observation}`);
      }
    };

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
          await forceClose(entry.hostRef);
        }
      });
      await withinSemanticCancellationDeadline(runtime, entry, release).catch((error: unknown) => {
        throw requireSetRelinquishment(entry, errorMessage(error));
      });
      entry.cancellationEvidence = { kind: 'not-started' };
      closeAndForget(entry);
      return;
    }

    if (reason.kind === 'stop' && reason.cause === 'coordinator_rekey_refused') {
      await withinSemanticCancellationDeadline(runtime, entry, completion).catch((error: unknown) => {
        throw requireSetRelinquishment(entry, errorMessage(error));
      });
      if (entry.bound === null) {
        throw requireSetRelinquishment(entry, 'the accepted operation lost its provider binding');
      }
      if (!entry.completionEmitted) {
        try {
          emitRekeyRefusalTerminal(entry, entry.bound.name);
        } catch (error: unknown) {
          throw requireSetRelinquishment(entry, errorMessage(error));
        }
      }
      closeAndForget(entry);
      return;
    }

    if (entry.cancellationMode === 'shared-acknowledged-interrupt') {
      await withinSemanticCancellationDeadline(runtime, entry, completion).catch((error: unknown) => {
        throw requireSetRelinquishment(entry, errorMessage(error));
      });
      if (entry.providerTurnSubmission === 'not-submitted') {
        entry.cancellationEvidence = { kind: 'not-started' };
        closeAndForget(entry);
        return;
      }
      if (currentTurnTerminalEvidence(entry) === null && entry.turnSettlement !== null) {
        const terminal = await entry.turnSettlement.settle();
        if (terminal !== null && terminal.providerTurnId === entry.turnSettlement.providerTurnId)
          entry.cancellationEvidence = { kind: 'provider-turn-terminal', terminal };
        else {
          entry.settlementRefusals += 1;
          const reason = 'the inferred turn has no authoritative cessation evidence';

          if (entry.settlementRefusals >= TURN_SETTLEMENT_OBSERVATION_ATTEMPTS)
            throw requireSetRelinquishment(entry, reason);
          throw new SemanticOperationCancellationUnconfirmedError(entry.key, reason);
        }
      }
      const evidence = entry.cancellationEvidence;
      if (currentTurnTerminalEvidence(entry) === null) {
        const unconfirmedReason =
          evidence?.kind === 'interrupt-unconfirmed'
            ? evidence.reason
            : 'the provider settled without exact terminal confirmation';
        throw requireSetRelinquishment(entry, unconfirmedReason);
      }
      closeAndForget(entry);
      return;
    }

    if (entry.cancellationMode !== 'operation-isolated') {
      throw new Error(`Provider operation ${operationKeyString(entry.key)} has no cancellation mode.`);
    }
    const initialHostRef = entry.hostRef;
    const initialForceClose = initialHostRef === null ? Promise.resolve() : forceClose(initialHostRef);
    const isolatedCancellation = Promise.all([completion, initialForceClose]).then(async () => {
      if (initialHostRef === null && entry.hostRef !== null) await forceClose(entry.hostRef);
    });
    await withinSemanticCancellationDeadline(runtime, entry, isolatedCancellation).catch((error: unknown) => {
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
    entry.cancellationPromise = driveCancellation(entry, reason).catch((error: unknown) => {
      if (entry.turnSettlement !== null && entry.settlementRefusals < TURN_SETTLEMENT_OBSERVATION_ATTEMPTS) {
        entry.cancellationPromise = null;
      }
      throw error;
    });
    return entry.cancellationPromise;
  };

  return { cancelAndAwait };
}

function createSemanticOperationHost(
  options: SemanticOperationRuntimeOptions,
  assertAdmissionOpen: () => void,
  requireStaged: (key: ProviderOperationKey) => StagedOperation,
  trackHostRef: (entry: StagedOperation, hostRef: HostRef) => void,
  cancelAndAwait: (
    entry: StagedOperation,
    reason: Readonly<{ kind: 'release'; cause: Error }> | Readonly<{ kind: 'stop'; cause: ProviderStopCause }>,
  ) => Promise<void>,
  runPump: (
    key: ProviderOperationKey,
    entry: StagedOperation,
    provider: string,
    iterable: AsyncIterable<ProviderEventBody>,
    settleStart: (result: SemanticOperationStartResult) => void,
  ) => Promise<void>,
  synthesizeAndEmitFailure: (key: ProviderOperationKey, provider: string, error: unknown) => void,
  cancellationHold: NonNullable<SemanticOperationHost['cancellationHold']>,
): SemanticOperationHost {
  const { runtime } = options;
  const host: SemanticOperationHost = {
    cancellationHold,
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
          const preparedExecution = bound.prepareExecution(executionInput(runtime, options.hostRoot, prepared));
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
            (terminal) => {
              if (entry.cancellationDeadlineController.signal.aborted) return;
              entry.cancellationEvidence = { kind: 'provider-turn-terminal', terminal };
            },
            (settlement) => {
              if (entry.cancellationDeadlineController.signal.aborted) return;
              entry.turnSettlement = settlement;
              if (currentTurnTerminalEvidence(entry) === null) entry.cancellationEvidence = null;
              entry.settlementRefusals = 0;
            },
            () => {
              entry.providerTurnSubmission = 'submitted';
              if (entry.cancellationDeadlineController.signal.aborted) return;
              entry.cancellationEvidence = null;
              entry.settlementRefusals = 0;
            },
            () => {
              if (entry.providerTurnSubmission === 'unknown') entry.providerTurnSubmission = 'not-submitted';
            },
          );
          const iterable = preparedExecution.execute(executionRuntime);
          await runPump(key, entry, bound.name, iterable, settle);
        } catch (error: unknown) {
          if (!entry.startCommitted) settle({ kind: 'never-started', reason: errorMessage(error) });
          else if (!entry.releaseRequested) {
            if (entry.cancellationMode === 'shared-acknowledged-interrupt' && entry.pendingStopCause !== null) {
              if (currentTurnTerminalEvidence(entry) === null)
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

  return host;
}

function createStagedOperationEntry(
  key: ProviderOperationKey,
  abortController: AbortController,
  hostScope: ProxyOperationHostScope,
): StagedOperation {
  let resolveTransportClosed!: (error?: Error | void) => void;
  const transportClosed = new Promise<Error | void>((resolve) => {
    resolveTransportClosed = resolve;
  });
  let resolveCancellationExpired!: (error: SemanticOperationCancellationTimeoutError) => void;
  const cancellationExpired = new Promise<SemanticOperationCancellationTimeoutError>((resolve) => {
    resolveCancellationExpired = resolve;
  });
  const entry: StagedOperation = {
    key,
    abortController,
    hostScope,
    bound: null,
    cancellationMode: null,
    cancellationEvidence: null,
    cancellationPromise: null,
    cancellationDeadlineController: new AbortController(),
    cancellationExpired,
    resolveCancellationExpired,
    turnSettlement: null,
    settlementRefusals: 0,
    completionEmitted: false,
    staged: null,
    root: null,
    stageHandle: null,
    startHandle: null,
    startCommitted: false,
    providerTurnSubmission: 'unknown',
    releaseRequested: false,
    activeContinuitySettlement: null,
    closed: false,
    hostRef: null,
    transportClosed,
    resolveTransportClosed,
    pendingStopCause: null,
    done: null,
  };
  return entry;
}

function createSemanticOperationStager(
  options: SemanticOperationRuntimeOptions,
  state: SemanticOperationRuntimeState,
  assertAdmissionOpen: () => void,
  admissionCheckedHostScope: (scope: ProxyOperationHostScope) => ProxyOperationHostScope,
  trackHostRef: (entry: StagedOperation, hostRef: HostRef) => void,
  closeStaged: (entry: StagedOperation) => void,
  cancelAndAwait: (
    entry: StagedOperation,
    reason: Readonly<{ kind: 'release'; cause: Error }> | Readonly<{ kind: 'stop'; cause: ProviderStopCause }>,
  ) => Promise<void>,
) {
  const { runtime, hostAuthority } = options;
  const stage = (
    key: ProviderOperationKey,
    prepared: ProxyPreparedAppServerOperation,
  ): SemanticOperationStageHandle => {
    assertAdmissionOpen();
    const keyStr = operationKeyString(key);
    const existing = state.staged.get(keyStr);
    if (existing?.stageHandle !== null && existing?.stageHandle !== undefined) return existing.stageHandle;

    const abortController = new AbortController();
    const hostScope = admissionCheckedHostScope(hostAuthority.beginOperation(key));
    const entry = createStagedOperationEntry(key, abortController, hostScope);
    state.staged.set(keyStr, entry);
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
        input = stagingInput(runtime, options.hostRoot, prepared);
      } catch (error: unknown) {
        return prepareRefusal(
          'provider_reconstruction_refused',
          'local-fallback',
          boundedRefusalReason(error, 'The provider operation could not be reconstructed.'),
        );
      }
      const compiled = bound.prepareExecution(executionInput(runtime, options.hostRoot, prepared));
      if (compiled.kind !== 'app-server' || hostFingerprintFromSpec(compiled.hostSpec) !== options.hostFingerprint) {
        return prepareRefusal(
          'proxy_prepare_refused',
          'local-fallback',
          'provider_host_fingerprint_mismatch: compiled host identity differs from the requested proxy set; activation is refused.',
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

  return stage;
}

function createSemanticOperationShutdown(
  state: SemanticOperationRuntimeState,
  cancelAndAwait: (
    entry: StagedOperation,
    reason: Readonly<{ kind: 'release'; cause: Error }> | Readonly<{ kind: 'stop'; cause: ProviderStopCause }>,
  ) => Promise<void>,
): SemanticOperationRuntime['shutdown'] {
  return (cause) => {
    if (state.shutdownPromise !== null) return state.shutdownPromise;
    state.closing = true;
    const entries = [...state.staged.values()];
    for (const entry of entries) {
      entry.activeContinuitySettlement?.reject(
        new ContinuityCommitDeliveryError(
          'continuity_commit_proxy_shutdown',
          'The provider proxy shut down before the continuity checkpoint was committed.',
        ),
      );
    }
    state.shutdownPromise = (async () => {
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
      for (const [key, entry] of state.staged) {
        if (rejectedKeys.has(key)) continue;
        failures.push({
          key: entry.key,
          kind: 'operation-survived',
          reason: 'Operation remained staged after its shutdown cancellation fulfilled.',
        });
      }
      if (failures.length > 0) throw new SemanticOperationShutdownError(failures);
    })();
    return state.shutdownPromise;
  };
}

export function createSemanticOperationRuntime(options: SemanticOperationRuntimeOptions): SemanticOperationRuntime {
  const { runtime, hostAuthority, getProxy } = options;
  const state: SemanticOperationRuntimeState = {
    staged: new Map(),
    closing: false,
    shutdownPromise: null,
    relinquishmentFailure: null,
  };

  const assertAdmissionOpen = (): void => {
    if (state.closing) throw new SemanticOperationAdmissionClosedError();
  };

  const relinquishmentSiblings = new Set<StagedOperation>();
  let relinquishmentNotified = false;
  let relinquishmentState: ProxyOperationCancellationHold['state'] = 'draining';
  let relinquishmentTimer: ReturnType<typeof runtime.time.setTimeout> | null = null;

  const notifyRelinquishment = (): void => {
    if (state.relinquishmentFailure === null || relinquishmentNotified || relinquishmentSiblings.size > 0) return;
    relinquishmentNotified = true;
    relinquishmentState = 'relinquishing';
    if (relinquishmentTimer !== null) runtime.time.clearTimeout(relinquishmentTimer);
    relinquishmentTimer = null;
    options.onRelinquish?.(state.relinquishmentFailure);
  };

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
    state.closing = true;
    const failure = new SemanticOperationCancellationUnconfirmedError(entry.key, reason);
    if (state.relinquishmentFailure !== null) {
      relinquishmentSiblings.delete(entry);
      notifyRelinquishment();
      return failure;
    }
    state.relinquishmentFailure = failure;
    for (const sibling of state.staged.values()) {
      if (sibling === entry || sibling.abortController.signal.aborted || sibling.done === null) continue;
      relinquishmentSiblings.add(sibling);
      void Promise.allSettled([sibling.done]).then(() => {
        if (sibling.startCommitted) return;
        relinquishmentSiblings.delete(sibling);
        notifyRelinquishment();
      });
    }
    if (relinquishmentSiblings.size > 0) {
      relinquishmentTimer = runtime.time.setTimeout(() => {
        relinquishmentTimer = null;
        relinquishmentState = 'quarantined';
        backendLog.warn(`proxy: cancellation quarantine retains live siblings: ${failure.message}`);
      }, SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS);
      relinquishmentTimer.unref?.();
    }
    notifyRelinquishment();
    return failure;
  };

  const requireStaged = (key: ProviderOperationKey): StagedOperation => {
    const entry = state.staged.get(operationKeyString(key));
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
    entry.turnSettlement?.close();
    entry.turnSettlement = null;
    closeStaged(entry);
    const key = operationKeyString(entry.key);
    if (state.staged.get(key) === entry) state.staged.delete(key);
    relinquishmentSiblings.delete(entry);
    notifyRelinquishment();
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

  const { cancelAndAwait } = createSemanticOperationCancellation(
    options,
    closeAndForget,
    requireSetRelinquishment,
    (entry, provider, detail) => emitRekeyRefusalTerminal(entry, provider, detail),
  );

  const { synthesizeAndEmitFailure, emitRekeyRefusalTerminal, runPump } = createSemanticOperationEventPump(
    getProxy,
    closeStaged,
  );

  const host = createSemanticOperationHost(
    options,
    assertAdmissionOpen,
    requireStaged,
    trackHostRef,
    cancelAndAwait,
    runPump,
    synthesizeAndEmitFailure,
    (key) => {
      if (
        state.relinquishmentFailure === null ||
        operationKeyString(key) !== operationKeyString(state.relinquishmentFailure.key)
      ) {
        return null;
      }
      return {
        state: relinquishmentState,
        reason: state.relinquishmentFailure.message,
        drainTimeoutMs: SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
        pendingSiblings: relinquishmentSiblings.size,
        exit: 'sibling-settlement-or-cancellation',
      };
    },
  );

  const stage = createSemanticOperationStager(
    options,
    state,
    assertAdmissionOpen,
    admissionCheckedHostScope,
    trackHostRef,
    closeStaged,
    cancelAndAwait,
  );

  return {
    stage,

    ensureProviderRoot: (key, prepared) => stage(key, prepared).result,

    host,

    shutdown: createSemanticOperationShutdown(state, cancelAndAwait),
  };
}
