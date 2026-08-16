import type { AppServerProxyRoute, AppServerProxyRouteRequest } from '../../jobs/contracts/app-server-proxy-route.js';
import {
  operationIdentitySchema,
  proxyPreparedAppServerOperationSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
} from '../../provider-proxy/protocol.js';
import {
  providerOperationRecordSchema,
  PROVIDER_OPERATION_RECORD_VERSION,
} from '../../store/provider-operation-record.js';
import type { ProviderHostManager } from '../live/provider-hosts/index.js';
import { isProviderProxyOperationAuthority } from '../live/provider-proxy/operation-route.js';
import { providerOperationPrepareAttempt, providerOperationSetLocator } from './provider-proxy-operation-activation.js';
import type { ProviderOperationReconciler } from './provider-operation-reconciler.js';

export function createAppServerProxyRoute(deps: {
  readonly hostManager: Pick<ProviderHostManager, 'routeAppServerOperation'>;
  readonly reconciler: Pick<ProviderOperationReconciler, 'begin'>;
  readonly now: () => number;
}): AppServerProxyRoute {
  return {
    async activate(request: AppServerProxyRouteRequest, signal: AbortSignal) {
      const authority = deps.hostManager.routeAppServerOperation(request.hostSpec);
      if (authority === null) {
        return {
          kind: 'local-authorized',
          reason: 'No live proxy set was selected before any journal row or remote mutation existed.',
        };
      }
      if (!isProviderProxyOperationAuthority(authority)) {
        throw new Error('The selected proxy set does not support durable operation replay.');
      }

      const parsedOperation = operationIdentitySchema.safeParse({
        jobId: request.jobId,
        operationId: request.operationId,
        proxyInstanceId: authority.proxyInstanceId,
        buildSetId: authority.setIdentity.buildSetId,
      });
      if (!parsedOperation.success) {
        const issues = parsedOperation.error.issues
          .map((issue) => `${issue.path.join('.') || 'identity'}: ${issue.message}`)
          .join('; ');
        throw new Error(
          `Provider proxy launch rejected operation identity for job '${request.jobId}'. Invalid fields: ${issues || 'unknown schema violation'}. ` +
            'If this is a queued workflow child created before the job-id upgrade, restart it under the upgraded coordinator; verified legacy workflow-slot children are recovered with local placement.',
          { cause: parsedOperation.error },
        );
      }
      const operation: OperationIdentity = parsedOperation.data;
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
      const prepareAttemptNumber = 1;
      const attempt = providerOperationPrepareAttempt(authority, operation, prepared, prepareAttemptNumber);
      const record = providerOperationRecordSchema.parse({
        version: PROVIDER_OPERATION_RECORD_VERSION,
        operation,
        locator: providerOperationSetLocator(authority.setIdentity),
        prepareAttemptNumber,
        prepareAttemptKey: attempt.prepareAttemptKey,
        phase: 'prepare-pending',
        prepareSource: {
          jobLaunchEventSeq: request.jobLaunchEventSeq,
          sessionId: request.sessionId,
          sessionVersion: request.sessionVersion,
          platform: request.platform,
          childAuthorization: request.childAuthorization,
        },
        revision: 0,
        retryNotBeforeMs: deps.now(),
        retryCount: 0,
        lastError: null,
      });
      if (record.phase !== 'prepare-pending') throw new Error('Prepare-pending journal record failed validation.');

      return deps.reconciler.begin({ record, attempt, authority, signal });
    },
  };
}
