import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitEventsFn } from '../../store/append.js';
import type { JobProgressStore } from '../../jobs/contracts/progress-store.js';
import { writeResultArtifact } from '../../jobs/terminal/export.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';
import { releaseSessionJobClaim } from '../../sessions/job-release.js';
import { serializeWorkflowResult } from './execution-policies.js';
import { composeWorkflowFinalization } from './workflow-finalization-helper.js';

export type WorkflowRecoveryFinalizer = (intent: WorkflowFinalizationIntent) => void;

export function createWorkflowRecoveryFinalizer(options: {
  runtime: Runtime;
  progressStore: Pick<JobProgressStore, 'readStatus' | 'getDb'>;
  coordinatorCommit: CommitEventsFn;
  log?: (message: string) => void;
  emitSessionReleased?: (payload: { sessionId: string; jobId: string }) => void;
}): WorkflowRecoveryFinalizer {
  return (intent) => {
    const status = options.progressStore.readStatus(intent.workflowJobId);
    const namespace = status?.backendNamespace;
    const project = status?.projectRoot;
    const sessionId = status?.sessionId ?? null;

    options.coordinatorCommit((c) => {
      composeWorkflowFinalization(c, intent.workflowJobId, intent, { sessionId, namespace, project });
      return undefined;
    });

    try {
      const serialized = serializeWorkflowResult(intent.stepDetails);
      writeResultArtifact(
        options.runtime.storage,
        options.runtime.paths.coral.exports.jobsRoot,
        intent.workflowJobId,
        serialized.markdown,
      );
    } catch (error: unknown) {
      const message = `Writing recovered workflow artifact failed for ${intent.workflowJobId}: ${errorMessage(error)}`;
      if (options.log) {
        options.log(`${message}\n`);
      } else {
        backendLog.warn(message);
      }
    }

    if (status?.sessionId) {
      releaseSessionJobClaim({
        projectRoot: status.projectRoot,
        runtime: options.runtime,
        emitSessionReleased: options.emitSessionReleased ?? (() => {}),
        db: options.progressStore.getDb(),
        sessionId: status.sessionId,
        jobId: status.jobId,
      });
    }
  };
}
