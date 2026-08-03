import type { ProjectRequestPort } from '../contracts.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitContext, CommitEventsFn } from '../../store/append.js';
import { releaseSessionJobClaim } from '../../sessions/job-release.js';
import { readProjectionProviderSession } from '../../sessions/projections.js';
import type {
  AtomicFailedWorkflowDescendantReleaser,
  WorkflowRecoveryDescendant,
  WorkflowRecoveryDescendantRelease,
} from '../../workflow/recover.js';

type FailedWorkflowDescendantReleaserDeps = {
  progressStore: Pick<JobStore, 'getDb'>;
  runtime: Runtime;
  coordinatorCommit: CommitEventsFn;
  getExecutionService: (ctx: InvocationContext) => Pick<ProjectRequestPort, 'abort'>;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  releaseAdoptedJob: (jobId: string) => void;
  emitSessionReleased: (payload: { sessionId: string; jobId: string }) => void;
  log: (message: string) => void;
};

function nestedCommit<Scope>(commit: CommitContext<Scope>): CommitEventsFn {
  return (append) => {
    append(commit);
    return [];
  };
}

/** Creates the exact-envelope descendant release and process-cleanup capability. */
export function createFailedWorkflowDescendantReleaser(
  deps: FailedWorkflowDescendantReleaserDeps,
): AtomicFailedWorkflowDescendantReleaser {
  const pendingEmits = new Set<string>();
  const release = (() => []) as unknown as AtomicFailedWorkflowDescendantReleaser;

  release.composeAtomic = <Scope>(
    commit: CommitContext<Scope>,
    descendants: readonly WorkflowRecoveryDescendant[],
  ): readonly WorkflowRecoveryDescendantRelease[] => {
    const releases: WorkflowRecoveryDescendantRelease[] = [];
    for (const descendant of descendants) {
      const entry = readProjectionProviderSession(deps.progressStore.getDb(), descendant.sessionId);
      if (
        entry === null ||
        entry.version !== descendant.expectedSessionVersion ||
        entry.activeJobId !== descendant.jobId
      ) {
        throw new Error(
          `Workflow recovery descendant claim changed for '${descendant.jobId}' session '${descendant.sessionId}'.`,
        );
      }
      const sessionClaimRelease = releaseSessionJobClaim({
        projectRoot: descendant.projectRoot,
        runtime: deps.runtime,
        db: deps.progressStore.getDb(),
        commitEvents: nestedCommit(commit),
        emitSessionReleased: ({ sessionId, jobId }) => pendingEmits.add(`${sessionId}\u0000${jobId}`),
        sessionId: descendant.sessionId,
        jobId: descendant.jobId,
      });
      if (sessionClaimRelease !== 'released') {
        throw new Error(`Workflow recovery could not release '${descendant.jobId}' session '${descendant.sessionId}'.`);
      }
      releases.push({
        jobId: descendant.jobId,
        sessionId: descendant.sessionId,
        sessionClaimRelease,
      });
    }
    return releases;
  };

  release.cleanup = (descendants) => {
    for (const descendant of descendants) {
      deps.getExecutionService(deps.createInvocationContext(descendant.projectRoot)).abort([descendant.jobId]);
      deps.releaseAdoptedJob(descendant.jobId);
      const emitKey = `${descendant.sessionId}\u0000${descendant.jobId}`;
      if (pendingEmits.delete(emitKey)) {
        deps.emitSessionReleased({ sessionId: descendant.sessionId, jobId: descendant.jobId });
      }
    }
  };

  return release;
}
