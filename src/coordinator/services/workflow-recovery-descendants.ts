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
      // The obligation is per-job and idempotent: what must hold afterwards is that `jobId` does not hold
      // `sessionId`. All three results say that it does not — `released` because we just released it,
      // `already_absent` because nothing held it, `owned_by_another_job` because someone else does. None
      // is a conflict, and the safety property is `releaseJob` itself refusing to touch another owner,
      // not a throw here. Throwing on the third only turned a benign state into a close this pass can
      // never satisfy, retried from the persisted `ready-to-close` record on every later pass.
      // The disposition is reported rather than swallowed: `describeSessionJobClaimReleaseResult`
      // renders all three, and workflow recovery logs whichever occurred.
      const sessionClaimRelease = releaseSessionJobClaim({
        projectRoot: descendant.projectRoot,
        runtime: deps.runtime,
        db: deps.progressStore.getDb(),
        commitEvents: nestedCommit(commit),
        emitSessionReleased: ({ sessionId, jobId }) => pendingEmits.add(`${sessionId}\u0000${jobId}`),
        sessionId: descendant.sessionId,
        jobId: descendant.jobId,
      });
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
