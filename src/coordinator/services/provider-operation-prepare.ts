import { resolveEquippedTools } from '../../expansion/equipped-tools.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import { applyInjectBundle } from '../../providers/inject.js';
import {
  proxyPreparedAppServerOperationSchema,
  type ProxyPreparedAppServerOperation,
} from '../../provider-proxy/protocol.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ProviderJobLaunch } from '../../jobs/records.js';
import { toProviderRequest } from '../../jobs/provider-request.js';
import type { ProviderSession } from '../../sessions/entry.js';
import { CORAL_CHILD_PRINCIPAL_HANDLE } from '../../security/child-principal-env.js';
import type { ChildPrincipalRegistry } from '../child-principal-registry.js';
import type {
  ProviderOperationIdentity,
  ProviderOperationPrepareSource,
} from '../../store/provider-operation-record.js';

export type ProviderOperationPrepareMaterializerDeps = Readonly<{
  runtime: Pick<Runtime, 'time' | 'env' | 'storage' | 'paths'>;
  providerRegistry: ProviderBindingCatalog;
  childPrincipalRegistry: Pick<ChildPrincipalRegistry, 'registerPersistedAuthorization'>;
  readJobLaunch(jobId: string, eventSeq: number): ProviderJobLaunch;
  readSession(sessionId: string): ProviderSession | null;
}>;

export function materializeProviderOperationPrepare(
  deps: ProviderOperationPrepareMaterializerDeps,
  operation: ProviderOperationIdentity,
  source: ProviderOperationPrepareSource,
): ProxyPreparedAppServerOperation {
  const launch = deps.readJobLaunch(operation.jobId, source.jobLaunchEventSeq);
  if (launch.jobId !== operation.jobId || launch.sessionId !== source.sessionId) {
    throw new Error('Provider operation prepare source does not match its durable job launch.');
  }
  if (launch.backendNamespace !== source.childAuthorization.namespace) {
    throw new Error('Provider operation child authorization namespace does not match its durable job launch.');
  }

  const session = deps.readSession(source.sessionId);
  if (session === null || session.version !== source.sessionVersion || session.activeJobId !== operation.jobId) {
    throw new Error('Provider operation session snapshot is unavailable at its journaled version.');
  }
  if (source.platform !== deps.runtime.env.platform()) {
    throw new Error('Provider operation platform no longer matches the coordinator runtime.');
  }
  if (source.childAuthorization.expiresAtMs <= deps.runtime.time.now()) {
    throw new Error('Provider operation child authorization has expired.');
  }

  const bound = deps.providerRegistry.rehydrateBinding(session.binding);
  if (!bound.ok || bound.value.name !== launch.provider) {
    throw new Error('Provider operation binding no longer matches its durable job launch.');
  }
  const continuity = bound.value.decodeContinuity(session.providerContinuity);
  if (!continuity.ok) {
    throw new Error('Provider operation continuity cannot be decoded from its durable session snapshot.');
  }

  const request = toProviderRequest(launch, session.conversationRef);
  const requestWithInject = applyInjectBundle(request, {
    storage: deps.runtime.storage,
    kbRoot: deps.runtime.paths.coral.corpus.kbRoot,
    equippedTools: resolveEquippedTools(deps.runtime),
    ...(request.cwd
      ? {
          coralProjects: deps.runtime.paths.projectData(request.cwd),
          projectSource: deps.runtime.paths.projectSource(request.cwd),
        }
      : {}),
  });
  const child = deps.childPrincipalRegistry.registerPersistedAuthorization({
    issuer: 'provider-operation-reprepare',
    authorization: source.childAuthorization,
    parentJobId: operation.jobId,
    parentSessionId: source.sessionId,
    nowMs: deps.runtime.time.now(),
  });

  return proxyPreparedAppServerOperationSchema.parse({
    version: 1,
    provider: launch.provider,
    binding: session.binding,
    request: requestWithInject,
    persistedContinuity: continuity.value ?? null,
    baseEnv: deps.runtime.env.fullSnapshot(),
    protectedEnv: {
      CORAL_JOB_ID: operation.jobId,
      CORAL_SESSION_ID: source.sessionId,
      [CORAL_CHILD_PRINCIPAL_HANDLE]: child.handle,
    },
    platform: source.platform,
  });
}
