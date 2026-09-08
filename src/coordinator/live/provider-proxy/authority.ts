import { errorMessage } from '../../../infra/error-format.js';
import type { ControlClient, ControlExchange } from '../../../provider-proxy/control-client.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import {
  guardianContainmentCommitParamsSchema,
  guardianContainmentCommitResultSchema,
  type ProviderHostInventoryRecordWire,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../../provider-proxy/protocol.js';
import type { ProviderProxyHeartbeatHoldBound } from '../../../provider-proxy/orphan-deadline.js';
import type {
  HostRef,
  ProviderHostEvictionDisposition,
  ProviderHostTerminalEvictionDisposition,
} from '../../../providers/contract.js';

/**
 * What coordinated shutdown needs from the live guardian/reaper/proxy sets.
 *
 * The contract is written from its consumers' side: publication needs standing succession membership and
 * shutdown needs ordered relinquishment, while neither should reach into role clients directly.
 */

/** Commit results must distinguish confirmed absence, proven non-attempt, and unknown outcome. */
export type ContainmentCommitOutcome =
  | Readonly<{ kind: 'containment-absent'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'not-sent'; error: string }>
  | Readonly<{ kind: 'outcome-unknown'; error: string }>;

export interface ProviderProxyContainmentAuthority {
  commitContainment(signal: AbortSignal): Promise<ContainmentCommitOutcome>;
  /** Heartbeats must stop before control closes so no lease is renewed during relinquishment. */
  stopHeartbeats(): void;
  /** All owned control closes must be initiated before the returned confirmation settles. */
  initiateControlClose(): Promise<void>;
}

function raceContainmentCommitAgainstAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('the caller deadline elapsed before the containment commit resolved'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    pending.then(resolve, reject);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function commitProviderProxyGuardianContainment(
  control: Readonly<{
    client: ControlClient;
    guardian: GuardianIdentity;
    reaper: ReaperIdentity;
    proxy: ProxyIdentity;
  }>,
  signal: AbortSignal,
): Promise<ContainmentCommitOutcome> {
  const payload = guardianContainmentCommitParamsSchema.parse({
    guardian: control.guardian,
    reaper: control.reaper,
    proxy: control.proxy,
  });
  let exchange: ControlExchange;
  try {
    exchange = await raceContainmentCommitAgainstAbort(
      control.client.exchange('guardian.containment-commit.v1', payload, PROXY_TEARDOWN_RESERVE_MS),
      signal,
    );
  } catch (error: unknown) {
    return { kind: 'outcome-unknown', error: error instanceof Error ? error.message : String(error) };
  }
  if (exchange.kind === 'not-sent') {
    return { kind: 'not-sent', error: errorMessage(exchange.error) };
  }
  if (exchange.kind === 'response') {
    if (exchange.response.kind === 'refusal') {
      if (
        exchange.response.failure.kind === 'json-rpc-error' &&
        exchange.response.failure.protocolCode === 'invalid_state' &&
        exchange.response.error.message === 'A containment commit is already in progress.'
      ) {
        return { kind: 'outcome-unknown', error: exchange.response.error.message };
      }
      return { kind: 'not-sent', error: exchange.response.error.message };
    }
    const parsed = guardianContainmentCommitResultSchema.safeParse(exchange.response.value);
    if (!parsed.success) {
      return {
        kind: 'outcome-unknown',
        error: `guardian.containment-commit.v1 replied with an undecodable result: ${parsed.error.message}`,
      };
    }
    if (parsed.data.state === 'teardown-latched-absence-unconfirmed') {
      return { kind: 'outcome-unknown', error: parsed.data.reason };
    }
    return { kind: 'containment-absent', disappearanceReceipt: parsed.data.disappearanceReceipt };
  }
  return { kind: 'outcome-unknown', error: errorMessage(exchange.error) };
}

/** One live set, as shutdown sees it. */
export interface ProviderProxySetAuthority extends ProviderProxyContainmentAuthority {
  /** Names the set in failure reports, so an aggregate says which carrier could not be released. */
  readonly proxyInstanceId: string;
  /**
   * Stops and reaps this set, returning only once the recorded containment and every recorded provider root
   * are confirmed absent. Observing the proxy leader's exit is not that confirmation.
   */
  stopAndReap(signal: AbortSignal): Promise<Readonly<{ disappearanceReceipt: string } | { unconfirmed: string }>>;
  readonly providerHosts?: Readonly<{
    list(): Promise<readonly ProviderHostInventoryRecordWire[]>;
    inspect(hostRef: HostRef): Promise<ProviderHostInventoryRecordWire | null>;
    terminalEviction(hostRef: HostRef): Promise<ProviderHostTerminalEvictionDisposition | null>;
    evict(hostRef: HostRef): Promise<ProviderHostEvictionDisposition>;
  }>;
}

export type ProviderProxyAutonomousDeadline = Readonly<{
  orphanTimeoutMs: number;
  adoptionWindowMs: number;
  heartbeatHoldBound: ProviderProxyHeartbeatHoldBound;
}>;

export interface ProviderProxyAuthorityRegistry {
  /**
   * Every live set, as a query snapshot at the moment of the call — not a live cursor. Calling it again after
   * the caller has stopped and reaped some of what it returned is not guaranteed to exclude those sets: a
   * caller that reaps a set itself owns retiring it from further use and must not rely on a later
   * `liveSets()` call to do that for it. An empty list is the ordinary case before any provider work runs.
   */
  liveSets(): readonly ProviderProxySetAuthority[];
}
