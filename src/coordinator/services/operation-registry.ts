import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { ProviderOperationEventIdentity } from '../../jobs/provider-event.js';
import type { ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import type { ProviderStopCause } from '../../providers/contract.js';

/**
 * Mirrors `jobs/carrier-observation.ts`'s `LocalOperationRegistryState` exactly, restated rather than
 * imported: `tests/invariants/no-carrier-observation-in-action-paths.test.ts` permits that module's read-side
 * vocabulary to reach `coordinator/composition/` and a narrow allowlist, not `coordinator/services/`, and this
 * class's `provider-proxy/`-touching neighbors are exactly why the boundary exists. The two stay structurally
 * identical by construction, so TypeScript accepts this type wherever the canonical one is expected — the
 * same reason `provider-proxy-operation-activation.ts`'s `OperationControlClient` restates a shape instead of
 * importing a class. `jobs/carrier-observation.ts` remains the one place documenting what each value means.
 */
type LocalOperationRegistryState = 'activated' | 'adopted' | 'released' | 'inherited';

/**
 * The write half of `jobs/carrier-observation.ts`'s `LocalOperationRegistryState` (W2.3): the object nothing
 * in this codebase could previously produce. `composition/carrier-observation.ts`'s `evidenceFor` reads it;
 * this module is the only thing that may write it.
 *
 * Lives in `coordinator/services/`, not `coordinator/live/`, for the same reason
 * `provider-proxy-operation-activation.ts` is there: it composes jobs-domain vocabulary
 * (`ProviderOperationEventIdentity`, `ProviderOperationRuntimeMeta`) with a live control capability, which
 * `coordinator/live/**` may not do freely (`architecture-layering.test.ts`'s coordinator-contract-entrypoint
 * rule).
 */

/**
 * The one live capability an entry needs beyond its durable identity: send `operation.stop.v1` for exactly
 * this operation against the exact proxy connection that owns it. Built by `activateProviderOperation`
 * (`provider-proxy-operation-activation.ts`), which already holds the `proxyClient` and
 * `mutationRpcTimeoutMs` this needs — restated here as a shape rather than imported, the same reason
 * `provider-proxy-operation-activation.ts`'s own `OperationControlClient` exists.
 */
export interface OperationStopControl {
  stop(cause: ProviderStopCause): Promise<void>;
}

interface RegistryEntry {
  readonly identity: ProviderOperationEventIdentity;
  readonly control: OperationStopControl;
  readonly release: () => void;
  readonly state: LocalOperationRegistryState;
  stopCause: ProviderStopCause | null;
}

function registryKey(jobId: string, operationId: string): string {
  return `${jobId}:${operationId}`;
}

/**
 * One coordinator generation's live app-server operations, keyed exactly like the proxy ledger and the
 * `provider_operation.v1:<jobId>:<operationId>` meta row each entry is built from.
 *
 * `register` (private) takes the durable meta row itself rather than a hand-assembled identity, on purpose:
 * a meta row is the one thing both this session's live-activation caller (`activate`, which just wrote it)
 * and W2.5's future crash-recovery adoption (which would read it back from the store) equally have in hand.
 * W2.5 adds a second thin entry point — `adopt(meta, control, release)`, state `'adopted'` — calling this
 * same private builder instead of inventing a parallel structure. Not built here: recovery adoption of a live
 * proxied operation is explicitly out of this branch's scope.
 */
export class LocalOperationRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  // A job carries at most one live operation at a time, so a job id alone finds "whichever operation is
  // currently live for it" — the shape `stop()` needs, since the abort registry only ever knows a job id
  // (registration happens in `activateCommittedProviderLaunch`, before an operation id even exists — see
  // `jobs/shell/launch.ts`).
  private readonly liveJobIndex = new Map<string, string>();

  private register(
    meta: ProviderOperationRuntimeMeta,
    control: OperationStopControl,
    release: () => void,
    state: LocalOperationRegistryState,
  ): void {
    const identity: ProviderOperationEventIdentity = {
      jobId: meta.jobId,
      operationId: meta.operationId,
      proxyInstanceId: meta.proxyInstanceId,
      buildSetId: meta.buildSetId,
    };
    const key = registryKey(identity.jobId, identity.operationId);
    this.entries.set(key, { identity, control, release, state, stopCause: null });
    this.liveJobIndex.set(identity.jobId, key);
  }

  /**
   * Registers a live operation the instant `operation.activate.v1` ACKs `executing` — see
   * `createAppServerProxyRoute`, the only production caller. `release` is the launcher's own closure for
   * letting go of the in-process bookkeeping (admission slot, abort registration, job pool entry) it built at
   * the moment of delegation; this registry only ever calls it once, from `settled()`.
   */
  activate(meta: ProviderOperationRuntimeMeta, control: OperationStopControl, release: () => void): void {
    this.register(meta, control, release, 'activated');
  }

  /**
   * Ends this coordinator's tracking of one operation: runs its `release()` once, then forgets the entry.
   * `ProviderEventApplicationDeps.operations.settled` — the applier's only dependency on this registry.
   *
   * Idempotent: an identity this registry never activated, or already settled, is a silent no-op rather than
   * a fault, matching a replayed `provider.event.v1` terminal delivering the same settlement twice.
   */
  settled(identity: ProviderOperationEventIdentity): void {
    const key = registryKey(identity.jobId, identity.operationId);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    if (this.liveJobIndex.get(identity.jobId) === key) this.liveJobIndex.delete(identity.jobId);
    entry.release();
  }

  /**
   * The abort registry's `onAbort` action for every committed provider launch, wired once — unconditionally,
   * before this job's fate as local or proxied is even decided (`activateCommittedProviderLaunch`). A job
   * with no live entry here — local execution, an operation not yet activated, or one already settled — makes
   * this a safe no-op; local execution's own signal-observing interrupt path is unaffected, since it listens
   * on the shared `AbortSignal` directly rather than through this registry.
   *
   * Records `cause` on the entry before sending anything, so `recordedStopCauseFor` is correct the instant
   * this returns regardless of whether the RPC below has completed, or ever completes. Fire-and-forget by
   * design: the abort registry's `onAbort` contract is synchronous (`() => void`), and a dropped or slow
   * `operation.stop.v1` reply must not block or crash whatever triggered the abort.
   */
  stop(jobId: string, cause: ProviderStopCause): void {
    const key = this.liveJobIndex.get(jobId);
    if (key === undefined) return;
    const entry = this.entries.get(key);
    // Only the first recorded cause is sent — a second abort of an operation already being stopped has
    // nothing new to tell the proxy.
    if (entry === undefined || entry.stopCause !== null) return;
    entry.stopCause = cause;
    void entry.control.stop(cause).catch((error: unknown) => {
      backendLog.warn(`operation.stop.v1 failed for job '${jobId}': ${errorMessage(error)}`);
    });
  }

  /**
   * `ProviderEventApplicationDeps.recordedStopCauseFor`: the cause `stop()` most recently recorded for this
   * exact operation, or `null` if none was ever recorded — the one party that knows which.
   */
  recordedStopCauseFor(identity: ProviderOperationEventIdentity): ProviderStopCause | null {
    return this.entries.get(registryKey(identity.jobId, identity.operationId))?.stopCause ?? null;
  }

  /**
   * `composition/carrier-observation.ts`'s `evidenceFor`: this coordinator's local classification for
   * `jobId`'s currently live operation, or `null` when it has none. `null` is not `'inherited'` — the
   * composition layer, which owns interpreting what "no local entry" means for carrier classification, maps
   * it there.
   */
  stateForJob(jobId: string): LocalOperationRegistryState | null {
    const key = this.liveJobIndex.get(jobId);
    return key === undefined ? null : (this.entries.get(key)?.state ?? null);
  }
}
