import type { ProviderHostInventoryRecordWire } from '../../../provider-proxy/protocol.js';
import type { ProviderProxyHeartbeatHoldBound } from '../../../provider-proxy/orphan-deadline.js';
import type { HostRef } from '../../../providers/contract.js';

/**
 * What coordinated shutdown needs from the live guardian/reaper/proxy sets.
 *
 * The contract is written from its consumers' side: publication needs standing succession membership and
 * shutdown needs ordered relinquishment, while neither should reach into role clients directly.
 */

/** One live set, as shutdown sees it. */
export interface ProviderProxySetAuthority {
  /** Names the set in failure reports, so an aggregate says which carrier could not be released. */
  readonly proxyInstanceId: string;
  /**
   * Stops and reaps this set, returning only once the recorded containment and every recorded provider root
   * are confirmed absent. Observing the proxy leader's exit is not that confirmation.
   */
  stopAndReap(signal: AbortSignal): Promise<Readonly<{ disappearanceReceipt: string } | { unconfirmed: string }>>;
  /**
   * Stops this set's heartbeat scheduler. Synchronous so the ordered release boundary can stop every one
   * before any close is initiated — a heartbeat that lands mid-release would renew the very lease the
   * shutdown is giving up.
   */
  stopHeartbeats(): void;
  /**
   * Initiates control close and returns its confirmation. It must not await internally: the boundary needs
   * every close *triggered* before it waits on any of them, so one slow set cannot delay the rest.
   */
  initiateControlClose(): Promise<void>;
  readonly providerHosts?: Readonly<{
    list(): Promise<readonly ProviderHostInventoryRecordWire[]>;
    inspect(hostRef: HostRef): Promise<ProviderHostInventoryRecordWire | null>;
    evict(hostRef: HostRef): Promise<boolean>;
  }>;
}

export type ProviderProxyAutonomousDeadline = Readonly<{
  orphanTimeoutMs: number;
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
