import type { Database } from '../../store/db.js';
import type { ControlClient } from '../../provider-proxy/control-client.js';
import type { OperationIdentity, ProxyPreparedAppServerOperation } from '../../provider-proxy/protocol.js';
import {
  activateProviderOperation,
  type ActivateProviderOperationResult,
  type ProviderProxySetIdentity,
} from '../services/provider-proxy-operation-activation.js';
import type { ProviderProxySetAuthority } from './provider-proxy-authority.js';

/**
 * What launching an app-server operation through a live proxy set needs, beyond what coordinated shutdown
 * needs (`ProviderProxySetAuthority`, `provider-proxy-authority.ts`). A strict superset of the same concrete
 * set, built at the exact same `establishControl` construction site (`provider-proxy-acquisition-steps.ts`)
 * — not a second registry, and not a widening of `ProviderProxySetAuthority` itself, which stays exactly as
 * documented there: written from coordinated shutdown's side, on purpose.
 */
export interface ProviderProxyOperationAuthority extends ProviderProxySetAuthority {
  /** This set's fixed set-level identity — the same tuple `operation.prepare.v1` reports and the coordinator
   *  commits into `provider_operation.v1` runtime meta. Fixed for the whole lifetime of this set. */
  readonly setIdentity: ProviderProxySetIdentity;
  /** Runs the closed W2.3 publication order (`operation.prepare.v1` → runtime-meta commit →
   *  `guardian.operation-activate.v1` → `operation.activate.v1`) for one operation against this exact set. */
  activateOperation(
    db: Database,
    operation: OperationIdentity,
    prepared: ProxyPreparedAppServerOperation,
  ): Promise<ActivateProviderOperationResult>;
}

/**
 * Wraps an already-built `ProviderProxySetAuthority` with the operation-routing capability. `base`'s methods
 * are preserved as-is (spread, not re-implemented) so a caller holding this value as a plain
 * `ProviderProxySetAuthority` — shutdown — sees exactly the behavior `createProviderProxySetAuthority` gave it.
 */
export function createProviderProxyOperationAuthority(deps: {
  base: ProviderProxySetAuthority;
  setIdentity: ProviderProxySetIdentity;
  proxyClient: ControlClient;
  guardianClient: ControlClient;
  mutationRpcTimeoutMs: number;
}): ProviderProxyOperationAuthority {
  return {
    ...deps.base,
    setIdentity: deps.setIdentity,
    activateOperation: (db, operation, prepared) =>
      activateProviderOperation(
        {
          db,
          proxyClient: deps.proxyClient,
          guardianClient: deps.guardianClient,
          setIdentity: deps.setIdentity,
          mutationRpcTimeoutMs: deps.mutationRpcTimeoutMs,
        },
        operation,
        prepared,
      ),
  };
}
