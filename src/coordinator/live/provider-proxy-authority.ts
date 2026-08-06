/**
 * What coordinated shutdown needs from the live guardian/reaper/proxy sets.
 *
 * The contract is written from the consumer's side on purpose. Shutdown is the only caller, and every method
 * here exists because one row of the plan's fault matrix demands it — not because a set happens to be able
 * to do it. The concrete implementation belongs to the lazy provider-host acquisition path that creates the
 * sets; nothing else may reach a set through this surface.
 */

/** One live set, as shutdown sees it. */
export interface ProviderProxySetAuthority {
  /** Names the set in failure reports, so an aggregate says which carrier could not be released. */
  readonly proxyInstanceId: string;
  /**
   * The operations this proxy still carries, byte-sorted. Taken once per proxy so the whole sequence reasons
   * about a fixed set: a grant installed over one snapshot and a capsule written from another would hand the
   * successor a set neither authority agreed to.
   */
  snapshotOperations(signal: AbortSignal): Promise<readonly string[]>;
  /**
   * Installs one grant across guardian, reaper and proxy over the exact snapshot, then writes and fsyncs the
   * successor capsule. Both halves are meant to be one step, because a grant with no capsule is unredeemable
   * and a capsule with no grant is a secret nobody honours — either alone strands the set.
   *
   * Not implemented yet: today's only implementation refuses unconditionally, with
   * `ProviderProxyHandoffGrantUnavailableError`. The reaper has no install RPC and no successor capsule is
   * ever written, so there is no way to honour the contract above without half-installing a grant nothing
   * could redeem. Wiring both is the coordinated-shutdown / operation-ledger work (plan item W2.3); until
   * then, refusing is what this method guarantees.
   */
  installHandoffGrant(operationIds: readonly string[], signal: AbortSignal): Promise<void>;
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
}

export interface ProviderProxyAuthorityRegistry {
  /**
   * Every live set, as a query snapshot at the moment of the call — not a live cursor. Calling it again after
   * the caller has stopped and reaped some of what it returned is not guaranteed to exclude those sets: a
   * caller that reaps a set itself owns retiring it from further use and must not rely on a later
   * `liveSets()` call to do that for it. An empty list is the ordinary case before any provider work runs.
   */
  liveSets(): readonly ProviderProxySetAuthority[];
}
