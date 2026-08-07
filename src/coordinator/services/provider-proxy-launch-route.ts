import type { Database } from '../../store/db.js';
import type { AppServerProxyRoute, AppServerProxyRouteRequest } from '../../jobs/contracts/app-server-proxy-route.js';
import type { ProviderHostManager } from '../live/provider-hosts/index.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { HostRef } from '../../providers/contract.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import {
  operationIdentitySchema,
  proxyPreparedAppServerOperationSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
} from '../../provider-proxy/protocol.js';
import type { LocalOperationRegistry } from './operation-registry.js';

/**
 * The compiled `providerMeta.hostRef` for an activated proxied operation: names the proxy instance and host
 * fingerprint that actually own it, rather than any local `ProviderHostManager` entry. `meta.hostFingerprint`
 * is `hostFingerprintFromSpec(hostSpec)` — the exact function a genuinely local `HostRef.fingerprint` would
 * also use for this same spec — so a later reader can cross-check journal against meta the way
 * `durableCliEvidence()` already checks `meta.pid !== journalPid`. This is also the hazard the W2.3 design
 * doc calls out by name: `ProviderHostManager.attachSession` and `interruptAppServerJob` both assume an
 * `acquired` `hostRef` names a *local* host entry, and this one deliberately never will — see
 * `hasProviderOperationRuntimeMetaForJob`'s callers for the gate that gives those two mistaking it for one.
 */
function proxiedHostRef(
  request: AppServerProxyRouteRequest,
  meta: Readonly<{ proxyInstanceId: string; hostFingerprint: string }>,
): HostRef {
  return request.hostSpec.leaseMode === 'job-exclusive'
    ? {
        provider: request.provider,
        fingerprint: meta.hostFingerprint,
        instanceId: meta.proxyInstanceId,
        leaseMode: 'job-exclusive',
        ownerJobId: request.jobId,
      }
    : {
        provider: request.provider,
        fingerprint: meta.hostFingerprint,
        instanceId: meta.proxyInstanceId,
        leaseMode: 'shared',
      };
}

/**
 * The production `AppServerProxyRoute` (W2.3): the coordinator-side half of `LaunchOrchestrator`'s proxy-
 * routing seam. Looks up whether a live guardian/reaper/proxy set already exists for the job's executable
 * identity via `ProviderHostManager.routeAppServerOperation`, and if so runs the closed W2.3 publication
 * order against it. Composes a domain contract (`jobs/contracts/`) with a coordinator registry, which is
 * exactly what `coordinator/services/` exists for.
 */
export function createAppServerProxyRoute(deps: {
  readonly hostManager: Pick<ProviderHostManager, 'routeAppServerOperation'>;
  /** Resolved lazily, once per `activate()` call, not captured at construction: this port is built before
   *  the store is guaranteed open (`execution-services.ts` composes it per invocation), and by the time a job
   *  is actually being launched the store is certainly ready. */
  readonly getDb: () => Database;
  readonly progressStore: Pick<JobProgressStore, 'appendRuntimeStarted'>;
  readonly now: () => number;
  /** Where this coordinator generation's live app-server operations get registered the instant activation
   *  ACKs — the one write site for `jobs/carrier-observation.ts`'s `LocalOperationRegistryState`. */
  readonly registry: Pick<LocalOperationRegistry, 'activate'>;
}): AppServerProxyRoute {
  return {
    async activate(
      request: AppServerProxyRouteRequest,
      release: () => void,
      signal: AbortSignal,
    ): Promise<'executing' | null> {
      if (signal.aborted) return null;
      const authority = deps.hostManager.routeAppServerOperation(request.hostSpec);
      if (authority === null) return null;

      const operation: OperationIdentity = operationIdentitySchema.parse({
        jobId: request.jobId,
        operationId: request.operationId,
        proxyInstanceId: authority.proxyInstanceId,
        buildSetId: authority.setIdentity.buildSetId,
      });
      const prepared: ProxyPreparedAppServerOperation = proxyPreparedAppServerOperationSchema.parse({
        version: 1,
        provider: request.provider,
        binding: request.binding,
        request: request.request,
        persistedContinuity: request.persistedContinuity,
        baseEnv: request.baseEnv,
        protectedEnv: request.protectedEnv,
        platform: request.platform,
      });

      // `activateOperation` (`activateProviderOperation`) only wraps steps 3-4 (guardian/proxy activation) in
      // compensation; a step-1 (`operation.prepare.v1`) RPC failure — timeout, dropped connection, malformed
      // reply — rejects instead of returning a typed result, because nothing was written yet for it to
      // compensate. That is indistinguishable from "no usable set" from this caller's side: no meta was
      // committed and semantic execution was never authorized (`operation.prepare.v1` forbids it until step
      // 4), so falling back to in-process execution below is exactly as safe as the `authority === null`
      // case. The proxy's own pending reservation, if step 1 itself did succeed before some later failure,
      // self-expires from its `PROXY_PENDING_ACTIVATION_LEASE_MS` lease without ever having run anything.
      let result;
      try {
        result = await authority.activateOperation(deps.getDb(), operation, prepared);
      } catch (error: unknown) {
        backendLog.warn(
          `Provider proxy activation failed for job '${request.jobId}'; falling back to in-process execution: ${errorMessage(error)}`,
        );
        return null;
      }
      if (result.kind !== 'executing') return null;

      // From here the operation is durably executing on the proxy no matter what happens below — a failure
      // recording that fact locally must never be reported back as "not usable", or the caller would fall
      // back to a second, in-process execution of work already running remotely.
      try {
        deps.progressStore.appendRuntimeStarted(request.jobId, {
          transport: 'app-server',
          startTime: nowIsoString(deps.now()),
          providerMeta: {
            provider: request.provider,
            leaseState: 'acquired',
            hostRef: proxiedHostRef(request, result.meta),
          },
        });
      } catch (error: unknown) {
        backendLog.warn(
          `Failed to record app-server runtime start for proxied job '${request.jobId}': ${errorMessage(error)}`,
        );
      }
      deps.registry.activate(result.meta, result.control, release);
      return 'executing';
    },
  };
}
