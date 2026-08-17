import type { ProcessIncarnation } from '../../infra/node-process.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { LocalOperationRegistryState } from '../../jobs/carrier-observation.js';
import type { ProviderOperationEventIdentity } from '../../jobs/provider-event.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
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
 * `provider-proxy-operation-activation.ts` is there: it composes jobs-domain vocabulary with a live control
 * capability and the durable saga record, which
 * `coordinator/live/**` may not do freely (`architecture-layering.test.ts`'s coordinator-contract-entrypoint
 * rule).
 */

export interface OperationStopControl {
  stop(cause: ProviderStopCause): Promise<void>;
}

interface RegistryEntry {
  readonly identity: ProviderOperationEventIdentity;
  readonly providerRoot: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
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
 * provider-operation saga record each entry is built from. Both live activation and restart attachment already
 * hold the executing record, so registration does not flatten it into a second locator shape.
 */
export class LocalOperationRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private cleanupPort: ProviderOperationCleanupPort = { release: () => undefined };
  private settlementObserver: (jobId: string) => void = () => undefined;
  // A job carries at most one live operation at a time, so a job id alone finds "whichever operation is
  // currently live for it" — the shape `stop()` needs, since the abort registry only ever knows a job id
  // (registration happens in `activateCommittedProviderLaunch`, before an operation id even exists — see
  // `jobs/shell/launch.ts`).
  private readonly liveJobIndex = new Map<string, string>();

  connectCleanup(port: ProviderOperationCleanupPort): void {
    this.cleanupPort = port;
  }

  connectSettlementObserver(observer: (jobId: string) => void): void {
    this.settlementObserver = observer;
  }

  private register(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    control: OperationStopControl,
    cleanup: ProviderOperationCleanupIdentity,
    state: LocalOperationRegistryState,
  ): void {
    const identity: ProviderOperationEventIdentity = record.operation;
    const key = registryKey(identity.jobId, identity.operationId);
    const providerRoot = record.providerRoot;
    const stopCause = record.controlIntent.kind === 'stop' ? record.controlIntent.cause : null;
    this.entries.set(key, { identity, providerRoot, control, cleanup, state, stopCause });
    this.liveJobIndex.set(identity.jobId, key);
  }

  /**
   * Registers a live operation only after the activation ACK and runtime-started event commit together — see
   * `ProviderOperationReconciler`, the only production caller. The cleanup identity comes from the immutable
   * job launch, so the same registration path remains available after coordinator restart.
   */
  activate(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    control: OperationStopControl,
    cleanup: ProviderOperationCleanupIdentity,
  ): void {
    this.register(record, control, cleanup, 'activated');
  }

  /** A generation that restored local admission state can release the same identity; one that did not has a
   * natural no-op at the jobs-layer cleanup port. */
  attach(
    record: Extract<ProviderOperationRecord, { phase: 'executing' }>,
    control: OperationStopControl,
    cleanup: ProviderOperationCleanupIdentity,
  ): void {
    this.register(record, control, cleanup, 'attached');
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
    try {
      this.cleanupPort.release(entry.cleanup);
    } finally {
      this.settlementObserver(identity.jobId);
    }
  }

  /**
   * The durable reconciler calls this only after the saga records the stop. A missing entry therefore delays
   * the effect until attachment rather than losing the request; local execution still observes the shared
   * `AbortSignal` directly.
   *
   * Records `cause` before sending so a racing suspended event has the same durable disposition the caller
   * already committed. Fire-and-forget keeps a slow reply from blocking the synchronous abort callback; the
   * executing saga retries the effect.
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
  providerRootsFor(proxyInstanceId: string): readonly Readonly<{ pid: number; incarnation: ProcessIncarnation }>[] {
    const seen = new Map<string, Readonly<{ pid: number; incarnation: ProcessIncarnation }>>();
    for (const entry of this.entries.values()) {
      if (entry.identity.proxyInstanceId !== proxyInstanceId) continue;
      const key = `${entry.providerRoot.pid}@${entry.providerRoot.incarnation}`;
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
