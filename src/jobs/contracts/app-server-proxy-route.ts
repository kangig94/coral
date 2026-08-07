import type { ProviderRequest, ProviderServerSpec } from '../../providers/contract.js';
import type { ProviderBindingEnvelope } from '../../infra/provider-binding-envelope.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';

/**
 * What `LaunchOrchestrator` needs to try routing one app-server operation through a live, detached provider
 * proxy set before falling back to running the provider's kernel in this process (W2.3).
 *
 * `src/jobs/` may not import `src/provider-proxy/**` (`tests/invariants/architecture-layering.test.ts`), so
 * this contract carries only plain provider/domain vocabulary jobs already depends on. The coordinator
 * supplies the implementation that actually speaks the W2 control protocol and owns the live set registry —
 * see `src/coordinator/services/provider-proxy-launch-route.ts`.
 */
export interface AppServerProxyRoute {
  /**
   * Attempts to activate `request`'s operation on whatever live proxy set already exists for
   * `request.hostSpec`'s executable identity.
   *
   * Returns `null` immediately — never waiting on a background acquisition — whenever no such set is usable:
   * no live set for this identity, the proxy's ledger is at capacity, or activation failed and was cleanly
   * compensated. Acquisition is deliberately fire-and-forget (up to 45s), so the caller's only obligation on
   * `null` is to fall back to in-process execution exactly as if this method had never been called. `release`
   * is not called on this path — the launcher still owns everything it built at the moment of delegation.
   *
   * Returns `'executing'` once `operation.activate.v1` has ACKed. From that point on, `applyProviderEventAtSeq`
   * (wired as the proxy's `onProviderEvent` handler on the same live control connection) is the sole and
   * exclusive applier of this operation's durable effects — progress, continuity, artifacts, and its terminal.
   * The caller must not separately consume or re-apply an event stream for it; there is none to consume; the
   * proxy owns the live generator and the coordinator owns only the RPC stream adapter and durable effects.
   * Ownership of `release` moves forward with the operation the instant this returns `'executing'`: it will be
   * called exactly once, whenever this operation's terminal durably commits, by whatever the coordinator's
   * `provider.event.v1` applier holds at that later moment — not by this caller, and not synchronously here.
   */
  activate(request: AppServerProxyRouteRequest, release: () => void, signal: AbortSignal): Promise<'executing' | null>;
}

export interface AppServerProxyRouteRequest {
  readonly jobId: string;
  readonly operationId: string;
  /** The compiled stable host specification this execution would run against — the executable identity a
   *  live proxy set is keyed by. */
  readonly hostSpec: ProviderServerSpec;
  readonly provider: string;
  readonly binding: ProviderBindingEnvelope;
  readonly request: ProviderRequest;
  /** Provider-opaque continuity, `null` when the session has none. */
  readonly persistedContinuity: ProviderContinuityBlob | null;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly protectedEnv: Readonly<Record<string, string>>;
  readonly platform: string;
}
