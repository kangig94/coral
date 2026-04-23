import { AsyncLocalStorage } from 'node:async_hooks';

import type { CoralEventInput } from '../store/envelope.js';

export type CoordinatorInvocationScope = {
  namespace: string;
  project: string;
  correlationId: string;
};

const invocationScopeStorage = new AsyncLocalStorage<CoordinatorInvocationScope>();

export function withInvocationScope<T>(
  scope: CoordinatorInvocationScope,
  run: () => T,
): T {
  return invocationScopeStorage.run(scope, run);
}

export function getInvocationScope(): CoordinatorInvocationScope | null {
  return invocationScopeStorage.getStore() ?? null;
}

export function requireInvocationScope(): CoordinatorInvocationScope {
  const scope = getInvocationScope();
  if (!scope) {
    throw new Error('Coordinator invocation scope is not active');
  }
  return scope;
}

export function currentEventMetadata(): Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> {
  const scope = requireInvocationScope();
  return {
    namespace: scope.namespace,
    project: scope.project,
    correlationId: scope.correlationId,
  };
}
