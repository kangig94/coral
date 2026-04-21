import type { AbortRegistry } from '../../abort-registry.js';
import type { ProgressStore } from '../../../job-store.js';
import type { SessionManager } from '../../../../sessions/shell/store.js';
import type { ExecutionService } from '../../../../coordinator/execution-service.js';

export type ServiceInternals = {
  abortRegistry: AbortRegistry;
  progressStore: ProgressStore;
  sessionManager: SessionManager;
};

export function getInternals(service: ExecutionService): ServiceInternals {
  return service as unknown as ServiceInternals;
}
