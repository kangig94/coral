import type { ProjectRequestPort } from '../contracts.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitEventsFn } from '../../store/append.js';
import { releaseSessionJobClaim } from '../../sessions/job-release.js';
import type { WorkflowRecoveryDescendantRelease } from '../../workflow/recover.js';
import { errorMessage } from '../../infra/error-format.js';

type FailedWorkflowDescendantReleaserDeps = {
  progressStore: Pick<JobStore, 'getDb' | 'listJobIds' | 'readStatus'>;
  runtime: Runtime;
  coordinatorCommit: CommitEventsFn;
  getExecutionService: (ctx: InvocationContext) => Pick<ProjectRequestPort, 'abort'>;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  releaseAdoptedJob: (jobId: string) => void;
  emitSessionReleased: (payload: { sessionId: string; jobId: string }) => void;
  log: (message: string) => void;
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

      let status: ReturnType<typeof deps.progressStore.readStatus>;
      try {
        status = deps.progressStore.readStatus(jobId);
      } catch (error: unknown) {
        deps.log(
          `Workflow recovery could not read child ${jobId}; did not change adopted runtime ownership or any session claim: ${errorMessage(error)}\n`,
        );
        continue;
      }
      if (status === null || status.owner.kind !== 'workflow' || status.owner.id !== workflowId) {
        continue;
      }

      try {
        deps.getExecutionService(deps.createInvocationContext(status.projectRoot)).abort([jobId]);
      } catch (error: unknown) {
        const claimDisposition =
          status.sessionId === null ? 'no session claim was recorded' : `session claim ${status.sessionId}`;
        deps.log(
          `Workflow recovery could not confirm child ${jobId} stopped; retained adopted runtime ownership and ${claimDisposition}: ${errorMessage(error)}\n`,
        );
        continue;
      }

      try {
        deps.releaseAdoptedJob(jobId);
      } catch (error: unknown) {
        deps.log(
          `Workflow recovery could not release adopted runtime ownership for stopped child ${jobId}: ${errorMessage(error)}\n`,
        );
      }

      if (status.sessionId === null) {
        continue;
      }

      try {
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
      } catch (error: unknown) {
        deps.log(
          `Workflow recovery session claim release did not complete normally for stopped child ${jobId} session ${status.sessionId}: ${errorMessage(error)}\n`,
        );
      }
    }

    return releases;
  };
}
