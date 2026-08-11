import type { ProviderRequest, ProviderServerSpec } from '../../providers/contract.js';
import type { ProviderBindingEnvelope } from '../../infra/provider-binding-envelope.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { ProviderOperationChildAuthorization } from './provider-operation-lifecycle.js';

export type AppServerProxyPlacementResult =
  | Readonly<{ kind: 'remote-executing' }>
  | Readonly<{ kind: 'local-authorized'; reason: string }>
  | Readonly<{ kind: 'terminalized' }>;

export interface AppServerProxyRoute {
  /**
   * A non-local result cannot permit an in-process start because, once journalled, the same operation identity
   * may still acquire remote execution until reconciliation proves release or publishes the activation ACK.
   */
  activate(request: AppServerProxyRouteRequest, signal: AbortSignal): Promise<AppServerProxyPlacementResult>;
}

export interface AppServerProxyRouteRequest {
  readonly jobId: string;
  readonly operationId: string;
  readonly jobLaunchEventSeq: number;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly childAuthorization: ProviderOperationChildAuthorization;
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
