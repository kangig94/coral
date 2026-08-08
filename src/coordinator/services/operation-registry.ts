import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { LocalOperationRegistryState } from '../../jobs/carrier-observation.js';
import type { ProviderOperationEventIdentity } from '../../jobs/provider-event.js';
import type { ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import type { ProviderStopCause } from '../../providers/contract.js';

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

export interface OperationStopControl {
  stop(cause: ProviderStopCause): Promise<void>;
}

interface RegistryEntry {
  readonly identity: ProviderOperationEventIdentity;
  readonly providerRoot: Readonly<{ pid: number; processStartedAtSeconds: number }>;
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
    const providerRoot = {
      pid: meta.providerRootPid,
      processStartedAtSeconds: meta.providerRootProcessStartedAtSeconds,
    };
    this.entries.set(key, { identity, providerRoot, control, release, state, stopCause: null });
    this.liveJobIndex.set(identity.jobId, key);
  }

  /**
   * Registers a live operation only after the activation ACK and runtime-started event commit together — see
   * `ProviderOperationReconciler`, the only production caller. `release` is the launcher's own closure for
   * letting go of the in-process bookkeeping (admission slot, abort registration, job pool entry) it built at
   * the moment of delegation; this registry only ever calls it once, from `settled()`.
   */
  activate(meta: ProviderOperationRuntimeMeta, control: OperationStopControl, release: () => void): void {
    this.register(meta, control, release, 'activated');
  }

  /**
   * W2.5's second thin entry point onto the same private builder: registers an operation this coordinator
   * generation never activated but adopted from a predecessor's bequeathed proxy set, via
   * `guardian.handoff-redeem.v1` → `reaper.handoff-rotate.v1` → `handoff.redeem.v1` → `operation.adopt.v1`
   * (`provider-proxy-set-inheritance.ts`, the only production caller). `meta` is the exact row that
   * caller already read back from the store — the same "meta row is what both a live activation and a later
   * adoption equally have in hand" contract this class's own header doc promises.
   *
   * `release` is almost always a no-op: this coordinator never built any local admission/abort/pool
   * bookkeeping for a job it did not launch, so there is nothing of its own to let go of when the operation
   * later settles. It is still a parameter, not a hardcoded no-op, so a future caller with real local state to
   * release is not blocked from supplying one.
   */
  adopt(meta: ProviderOperationRuntimeMeta, control: OperationStopControl, release: () => void): void {
    this.register(meta, control, release, 'adopted');
  }

  /**
   * Ends this coordinator's live tracking of one operation and runs its local `release()` once. Remote and
   * guardian release stay with the durable settlement reconciler, so this method retains no dead control
   * client after the terminal commit.
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

  /**
   * Every operation this coordinator currently tracks against one proxy set — `installHandoffGrant`'s
   * snapshot (W2.7): a grant installed over a set neither authority agreed to would strand it, so shutdown
   * takes this exactly once per proxy and installs the grant over that fixed list, never a later re-read.
   * A settled entry is already gone from `entries` (see `settled()`), so this can never report one that no
   * longer exists.
   */
  operationsFor(proxyInstanceId: string): readonly ProviderOperationEventIdentity[] {
    const found: ProviderOperationEventIdentity[] = [];
    for (const entry of this.entries.values()) {
      if (entry.identity.proxyInstanceId === proxyInstanceId) found.push(entry.identity);
    }
    return found;
  }

  /**
   * Every distinct provider root this coordinator's own live operations hold against one proxy set —
   * `guardian.stop-and-reap.v1`/`reaper.stop-and-reap.v1`'s own `providerRoots` argument
   * (`provider-proxy/set-authority.ts`'s `stopAndReap`): both enforcers refuse a teardown that claims a root
   * they never recorded (`assertRecordedSetAgreement`), so this is the coordinator's own half of that
   * agreement. An empty (or partial) claim against an enforcer that has actually staged a root is not itself a
   * disagreement — `settled()` drops an operation's root from here the moment its terminal commits, which can
   * race a concurrent teardown reading the enforcer's own, still-recorded set, and `assertRecordedSetAgreement`
   * accepts exactly that undershoot. Deduped by process identity, mirroring `ArmedEnforcer.recordedRoots()`: a
   * shared host serving more than one activated operation is one teardown target, not one per operation.
   */
  providerRootsFor(proxyInstanceId: string): readonly Readonly<{ pid: number; processStartedAtSeconds: number }>[] {
    const seen = new Map<string, Readonly<{ pid: number; processStartedAtSeconds: number }>>();
    for (const entry of this.entries.values()) {
      if (entry.identity.proxyInstanceId !== proxyInstanceId) continue;
      const key = `${entry.providerRoot.pid}@${entry.providerRoot.processStartedAtSeconds}`;
      if (!seen.has(key)) seen.set(key, entry.providerRoot);
    }
    return [...seen.values()];
  }
}

/**
 * What a `stopAndReap`-adjacent caller (`provider-proxy/acquisition-steps.ts`'s `ProviderProxyAcquisitionSteps
 * Options`, `provider-proxy/set-authority.ts`'s `ProviderProxySetAuthorityDependencies`,
 * `provider-hosts/proxy-set-acquisition.ts`'s `ProviderProxySetAcquisitionConfig`,
 * `provider-proxy-set-inheritance.ts`'s `ProviderProxySetInheritanceDeps`)
 * needs from this registry: `operationsFor` and `providerRootsFor`, always. Named once here so every call site
 * stays the identical type rather than independently-drifting `Pick`s. Both are required — `providerRootsFor`
 * is this coordinator's own honest half of `assertRecordedSetAgreement` (an enforcer never faults a claim for
 * naming *fewer* roots than it recorded, only for naming one it never recorded), so there is no caller for
 * which silently falling back to a fixed answer instead of this live one is correct.
 */
export type ProviderProxyOperationSnapshot = Pick<LocalOperationRegistry, 'operationsFor' | 'providerRootsFor'>;
