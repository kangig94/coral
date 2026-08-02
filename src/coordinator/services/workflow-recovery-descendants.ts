import type { ProjectRequestPort } from '../contracts.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitEventsFn } from '../../store/append.js';
import { releaseSessionJobClaim } from '../../sessions/job-release.js';
import type { WorkflowRecoveryDescendantRelease } from '../../workflow/recover.js';

type FailedWorkflowDescendantReleaserDeps = {
  progressStore: Pick<JobStore, 'getDb' | 'listJobIds' | 'readStatus'>;
  runtime: Runtime;
  coordinatorCommit: CommitEventsFn;
  getExecutionService: (ctx: InvocationContext) => Pick<ProjectRequestPort, 'abort'>;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  releaseAdoptedJob: (jobId: string) => void;
  emitSessionReleased: (payload: { sessionId: string; jobId: string }) => void;
};

export function createFailedWorkflowDescendantReleaser(
  deps: FailedWorkflowDescendantReleaserDeps,
): (workflowId: string) => readonly WorkflowRecoveryDescendantRelease[] {
  return (workflowId) => {
    const releases: WorkflowRecoveryDescendantRelease[] = [];
    const descendantPrefix = `${workflowId}:`;

    for (const jobId of deps.progressStore.listJobIds()) {
      if (!jobId.startsWith(descendantPrefix)) {
        continue;
      }

      const status = deps.progressStore.readStatus(jobId);
      if (status === null || status.owner.kind !== 'workflow' || status.owner.id !== workflowId) {
        continue;
      }

      try {
        deps.getExecutionService(deps.createInvocationContext(status.projectRoot)).abort([jobId]);
      } finally {
        deps.releaseAdoptedJob(jobId);
      }

      if (status.sessionId === null) {
        continue;
      }

      releases.push({
        jobId,
        sessionId: status.sessionId,
        sessionClaimRelease: releaseSessionJobClaim({
          projectRoot: status.projectRoot,
          runtime: deps.runtime,
          emitSessionReleased: deps.emitSessionReleased,
          db: deps.progressStore.getDb(),
          commitEvents: deps.coordinatorCommit,
          sessionId: status.sessionId,
          jobId,
        }),
      });
    }

    return releases;
  };
}
