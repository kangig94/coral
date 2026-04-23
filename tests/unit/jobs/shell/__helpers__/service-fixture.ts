import type { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProgressStore } from '#src/jobs/job-store.js';
import type { SessionManager } from '#src/sessions/shell/store.js';
import type { ExecutionService } from '#src/coordinator/execution-service.js';

export type ServiceInternals = {
  abortRegistry: AbortRegistry;
  progressStore: ProgressStore;
  sessionManager: SessionManager;
};

export function getInternals(service: ExecutionService): ServiceInternals {
  return service as unknown as ServiceInternals;
}
