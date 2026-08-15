import type { ProjectRequestPort } from '../contracts.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitContext, CommitEventsFn } from '../../store/append.js';
import { releaseSessionJobClaim } from '../../sessions/job-release.js';
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
      // `releaseJob` owns this decision and already separates the two cases that matter: `already_absent`
      // when nothing holds the claim, `owned_by_another_job` when someone else does. An earlier revision
      // re-derived that judgement here from a projection read and got it wrong in both directions — it
      // treated an already-released claim as a conflict, and it compared a session version captured when
      // recovery started against one that recovery's own lawful work had since moved. Waiting for a child
      // to terminate releases its claim; completing a replacement intent swaps it. Both are this pass
      // doing its job, and both failed a check meant to catch foreign change.
      //
      // The obligation is per-job and idempotent: what must hold afterwards is that `jobId` does not hold
      // `sessionId`. Already true is satisfied, not violated.
      const sessionClaimRelease = releaseSessionJobClaim({
        projectRoot: descendant.projectRoot,
        runtime: deps.runtime,
        db: deps.progressStore.getDb(),
        commitEvents: nestedCommit(commit),
        emitSessionReleased: ({ sessionId, jobId }) => pendingEmits.add(`${sessionId}\u0000${jobId}`),
        sessionId: descendant.sessionId,
        jobId: descendant.jobId,
      });
      if (sessionClaimRelease === 'owned_by_another_job') {
        throw new Error(
          `Workflow recovery descendant claim for '${descendant.jobId}' session '${descendant.sessionId}' now belongs to another job.`,
        );
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
