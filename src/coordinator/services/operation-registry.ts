import type { ProcessIncarnation } from '../../infra/node-process.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { LocalOperationRegistryState } from '../../jobs/carrier-observation.js';
import type { ProviderOperationEventIdentity } from '../../jobs/provider-event.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import type {
  ProviderOperationBindingPort,
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
  private bindingPort: ProviderOperationBindingPort | null = null;
  private settlementObserver: (jobId: string) => void = () => undefined;
  private readonly liveJobIndex = new Map<string, string>();

  connectCleanup(port: ProviderOperationCleanupPort): void {
    this.cleanupPort = port;
  }

  connectBinding(port: ProviderOperationBindingPort): void {
    this.bindingPort = port;
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
    const stopCause = record.controlIntent.kind === 'run' ? null : record.controlIntent.cause;
    const proxyCleanup: ProviderOperationCleanupIdentity = {
      kind: 'proxy-binding',
      jobId: identity.jobId,
      operationId: identity.operationId,
      pool: cleanup.pool,
    };
    this.entries.set(key, { identity, providerRoot, control, cleanup: proxyCleanup, state, stopCause });
    this.liveJobIndex.set(identity.jobId, key);
  }

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
   * Every settlement delivery must reach the generation-fenced binding mailbox, including an identity this
   * registry never activated or has already removed; a delivery that stops short leaves its binding
   * unretired. No control client may outlive the terminal commit.
   */
  settled(identity: ProviderOperationEventIdentity): void {
    const bindingPort = this.bindingPort;
    if (bindingPort === null) {
      throw new Error('Provider operation binding authority is not connected.');
    }
    const binding = bindingPort.settleProviderOperationBinding(identity);
    if (binding.kind === 'refused') return;

    const key = registryKey(identity.jobId, identity.operationId);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.settlementObserver(identity.jobId);
      return;
    }
    this.entries.delete(key);
    const isCurrentOperation = this.liveJobIndex.get(identity.jobId) === key;
    if (isCurrentOperation) this.liveJobIndex.delete(identity.jobId);
    try {
      if (isCurrentOperation) this.cleanupPort.release(entry.cleanup);
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

  /** Provider-root snapshots must include only live operations for the set and deduplicate process identity. */
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

export type ProviderProxyOperationSnapshot = Pick<LocalOperationRegistry, 'providerRootsFor'> &
  Partial<Pick<LocalOperationRegistry, 'operationsFor'>>;
