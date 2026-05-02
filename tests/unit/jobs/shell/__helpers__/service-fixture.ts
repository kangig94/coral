import type { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { JobStore } from '#src/jobs/store.js';
import type { SessionManager } from '#src/sessions/shell.js';
import type { ExecutionService } from '#src/coordinator/execution-service.js';

export type ServiceInternals = {
  abortRegistry: AbortRegistry;
  progressStore: JobStore;
  sessionManager: SessionManager;
};

export function getInternals(service: ExecutionService): ServiceInternals {
  return service as unknown as ServiceInternals;
}
