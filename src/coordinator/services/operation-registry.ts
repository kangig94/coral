import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { LocalOperationRegistryState } from '../../jobs/carrier-observation.js';
import type { ProviderOperationEventIdentity } from '../../jobs/provider-event.js';
import type { ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type {
  ProviderOperationCleanupIdentity,
  ProviderOperationCleanupPort,
} from '../../jobs/contracts/provider-operation-lifecycle.js';

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
  readonly cleanup: ProviderOperationCleanupIdentity;
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
 * `register` (private) takes the durable meta row itself rather than a hand-assembled identity because both
 * live activation and restart/handoff adoption have that same record in hand. `activate` and `adopt` remain
 * thin entry points onto this one builder; only their local-state classification differs.
 */
export class LocalOperationRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private cleanupPort: ProviderOperationCleanupPort = { release: () => undefined };
  // A job carries at most one live operation at a time, so a job id alone finds "whichever operation is
  // currently live for it" — the shape `stop()` needs, since the abort registry only ever knows a job id
  // (registration happens in `activateCommittedProviderLaunch`, before an operation id even exists — see
  // `jobs/shell/launch.ts`).
  private readonly liveJobIndex = new Map<string, string>();

  connectCleanup(port: ProviderOperationCleanupPort): void {
    this.cleanupPort = port;
  }

  private register(
    meta: ProviderOperationRuntimeMeta,
    control: OperationStopControl,
    cleanup: ProviderOperationCleanupIdentity,
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
    this.entries.set(key, { identity, providerRoot, control, cleanup, state, stopCause: null });
    this.liveJobIndex.set(identity.jobId, key);
  }

  /**
   * Registers a live operation only after the activation ACK and runtime-started event commit together — see
   * `ProviderOperationReconciler`, the only production caller. The cleanup identity comes from the immutable
   * job launch, so the same registration path remains available after coordinator restart.
   */
  activate(
    meta: ProviderOperationRuntimeMeta,
    control: OperationStopControl,
    cleanup: ProviderOperationCleanupIdentity,
  ): void {
    this.register(meta, control, cleanup, 'activated');
  }

  /**
   * W2.5's second thin entry point onto the same private builder: registers an operation this coordinator
   * generation never activated but adopted from a predecessor's bequeathed proxy set, via
   * `guardian.handoff-redeem.v1` → `reaper.handoff-rotate.v1` → `handoff.redeem.v1` → `operation.adopt.v1`
   * (`provider-proxy-set-inheritance.ts`, the only production caller). `meta` is the exact row that
   * caller already read back from the store — the same "meta row is what both a live activation and a later
   * adoption equally have in hand" contract this class's own header doc promises.
   *
   * A generation that restored local admission state can resolve the same identity; one that did not has a
   * natural no-op at the jobs-layer cleanup port.
   */
  adopt(
    meta: ProviderOperationRuntimeMeta,
    control: OperationStopControl,
    cleanup: ProviderOperationCleanupIdentity,
  ): void {
    this.register(meta, control, cleanup, 'adopted');
  }

  /**
   * Ends this coordinator's live tracking of one operation and addresses local cleanup once. Remote and
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
    this.cleanupPort.release(entry.cleanup);
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
   * Every operation this coordinator currently tracks against one proxy set. This is a live-runtime view;
   * durable handoff membership comes from the provider-operation journal because publication can precede
   * registration here.
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
 * What a set authority needs from the live registry for `stopAndReap`. `operationsFor` remains optional for
 * callers that also expose the diagnostic live view; handoff membership never reads it.
 */
export type ProviderProxyOperationSnapshot = Pick<LocalOperationRegistry, 'providerRootsFor'> &
  Partial<Pick<LocalOperationRegistry, 'operationsFor'>>;
