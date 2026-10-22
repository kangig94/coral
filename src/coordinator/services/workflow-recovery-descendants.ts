import type { ProjectRequestPort } from '../contracts.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitContext, CommitEventsFn } from '../../store/append.js';
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
  log: (message: string) => void;
};

export function createFailedWorkflowDescendantReleaser(
  deps: FailedWorkflowDescendantReleaserDeps,
): AtomicFailedWorkflowDescendantReleaser {
  const hasEndedChildExecution = ({ jobId, execution }: WorkflowRecoveryDescendant): boolean => {
    const child = deps.progressStore
      .getDb()
      .prepare<[string], { execution: number | null; terminal: string | null }>('SELECT execution, terminal FROM projection_jobs WHERE job_id = ?')
      .get(jobId);
    return child?.execution === execution && child.terminal !== null;
  };
  const release = (() => []) as unknown as AtomicFailedWorkflowDescendantReleaser;

  release.composeAtomic = <Scope>(
    commit: CommitContext<Scope>,
    descendants: readonly WorkflowRecoveryDescendant[],
  ): readonly WorkflowRecoveryDescendantRelease[] => {
    const releases: WorkflowRecoveryDescendantRelease[] = [];
    for (const descendant of descendants) {
      if (!hasEndedChildExecution(descendant)) continue;
      releases.push({
        jobId: descendant.jobId,
        execution: descendant.execution,
      });
    }
    return releases;
  };

  release.cleanup = (descendants) => {
    for (const descendant of descendants) {
      if (!hasEndedChildExecution(descendant)) continue;
      deps.getExecutionService(deps.createInvocationContext(descendant.projectRoot)).abort([descendant.jobId]);
      deps.releaseAdoptedJob(descendant.jobId);
    }
  };

  return release;
}
