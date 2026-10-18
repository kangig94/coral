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
  const hasNonterminalChild = (jobId: string): boolean => {
    const child = deps.progressStore
      .getDb()
      .prepare<[string], { terminal: string | null }>('SELECT terminal FROM projection_jobs WHERE job_id = ?')
      .get(jobId);
    return child !== undefined && child.terminal === null;
  };
  const pendingEmits = new Set<string>();
  const release = (() => []) as unknown as AtomicFailedWorkflowDescendantReleaser;

  release.composeAtomic = <Scope>(
    commit: CommitContext<Scope>,
    descendants: readonly WorkflowRecoveryDescendant[],
  ): readonly WorkflowRecoveryDescendantRelease[] => {
    const releases: WorkflowRecoveryDescendantRelease[] = [];
    for (const descendant of descendants) {
      // Non-terminal children retain their claim and adoption until their own recovery finalizes.
      if (hasNonterminalChild(descendant.jobId)) continue;
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
      if (hasNonterminalChild(descendant.jobId)) continue;
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
