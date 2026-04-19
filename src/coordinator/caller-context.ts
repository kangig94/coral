import { AsyncLocalStorage } from 'node:async_hooks';

import type { CoralEventInput } from '../store/envelope.js';

export type CoordinatorCallerContext = {
  namespace: string;
  project: string;
  correlationId: string;
};

const callerContextStorage = new AsyncLocalStorage<CoordinatorCallerContext>();

export function withCallerContext<T>(
  context: CoordinatorCallerContext,
  run: () => T,
): T {
  return callerContextStorage.run(context, run);
}

export function getCallerContext(): CoordinatorCallerContext | null {
  return callerContextStorage.getStore() ?? null;
}

export function requireCallerContext(): CoordinatorCallerContext {
  const context = getCallerContext();
  if (!context) {
    throw new Error('Coordinator caller context is not active');
  }
  return context;
}

export function currentEventMetadata(): Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> {
  const context = requireCallerContext();
  return {
    namespace: context.namespace,
    project: context.project,
    correlationId: context.correlationId,
  };
}
