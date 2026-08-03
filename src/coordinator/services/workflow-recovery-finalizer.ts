import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitEventsFn } from '../../store/append.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import { writeResultArtifact } from '../../jobs/terminal/export.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';
import type {
  WorkflowRecoveryAtomicClose,
  WorkflowRecoveryDescendantRelease,
  WorkflowRecoveryFinalizer,
} from '../../workflow/recover.js';
import { serializeWorkflowResult } from './execution-policies.js';
import { composeWorkflowFinalization } from './workflow-finalization.js';

function exportRecoveredWorkflowResult(
  options: {
    runtime: Runtime;
    log?: (message: string) => void;
  },
  intent: WorkflowFinalizationIntent,
): void {
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
}

export function createWorkflowRecoveryFinalizer(options: {
  runtime: Runtime;
  progressStore: Pick<JobProgressStore, 'readStatus' | 'readRuntimeProjection'>;
  coordinatorCommit: CommitEventsFn;
  log?: (message: string) => void;
}): WorkflowRecoveryFinalizer {
  const finalize = ((intent: WorkflowFinalizationIntent) => {
    const status = options.progressStore.readStatus(intent.workflowJobId);
    const namespace = status?.backendNamespace;
    const project = status?.projectRoot;
    const runtime = options.progressStore.readRuntimeProjection(intent.workflowJobId);
    if (runtime?.transport !== 'workflow') {
      throw new Error(`Workflow '${intent.workflowJobId}' has no workflow runtime start.`);
    }
    const startedAt = Date.parse(runtime.startTime);
    if (!Number.isFinite(startedAt)) {
      throw new Error(`Workflow '${intent.workflowJobId}' has an invalid runtime start timestamp.`);
    }
    const durationMs = Math.max(0, options.runtime.time.now() - startedAt);

    options.coordinatorCommit((c) => {
      composeWorkflowFinalization(c, intent.workflowJobId, intent, { namespace, project, durationMs });
      return undefined;
    });

    exportRecoveredWorkflowResult(options, intent);
  }) as WorkflowRecoveryFinalizer;

  finalize.atomicClose = (request: WorkflowRecoveryAtomicClose) => {
    const startedAt = Date.parse(request.recording.startedAt);
    if (!Number.isFinite(startedAt)) {
      throw new Error(`Workflow '${request.intent.workflowJobId}' has an invalid runtime start timestamp.`);
    }
    const durationMs = Math.max(0, options.runtime.time.now() - startedAt);
    let releases: readonly WorkflowRecoveryDescendantRelease[] = [];
    options.coordinatorCommit((c) => {
      composeWorkflowFinalization(c, request.intent.workflowJobId, request.intent, {
        namespace: request.recording.namespace,
        project: request.recording.project,
        durationMs,
      });
      releases = request.releaseDescendants.composeAtomic(c, request.descendants);
      if (!request.clearContinuation()) {
        throw new Error(`Workflow recovery continuation changed for '${request.intent.workflowJobId}'.`);
      }
      return undefined;
    });
    exportRecoveredWorkflowResult(options, request.intent);
    return releases;
  };

  return finalize;
}
