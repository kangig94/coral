import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CommitEventsFn } from '../../store/append.js';
import type { JobProgressStore } from '../../jobs/contracts/progress-store.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../../jobs/terminal/recording.js';
import { writeResultArtifact } from '../../jobs/terminal/export.js';
import { workflowCompletedEvent, workflowLifecycleFaultEvent } from '../../workflow/events.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';
import { releaseSessionJobClaim } from '../../sessions/job-release.js';
import { serializeWorkflowResult } from './execution-policies.js';

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
      if (intent.outcome === 'completed') {
        c.append(
          workflowCompletedEvent(intent.workflowJobId, {
            outcome: 'completed',
            stepDetails: intent.stepDetails,
          }),
        );
        appendJobTerminalRecorded(c, {
          jobId: intent.workflowJobId,
          sessionId,
          namespace,
          project,
          terminal: {
            content: intent.finalOutput,
            outcome: { kind: 'completed' },
          },
          continuity: null,
        });
        return undefined;
      }

      if (intent.outcome === 'aborted') {
        c.append(
          workflowCompletedEvent(intent.workflowJobId, {
            outcome: 'aborted',
            stepDetails: intent.stepDetails,
          }),
        );
        appendJobTerminalRecorded(c, {
          jobId: intent.workflowJobId,
          sessionId,
          namespace,
          project,
          terminal: {
            content: '',
            outcome: { kind: 'aborted', reason: intent.reason },
          },
          continuity: null,
        });
        return undefined;
      }

      const workflowCauseRef =
        intent.causeRef ??
        c.append(workflowLifecycleFaultEvent(intent.workflowJobId, intent.lifecycleFault));
      const workflowCompleted = c.append(
        workflowCompletedEvent(intent.workflowJobId, {
          outcome: 'failed',
          causeRef: workflowCauseRef,
          stepDetails: intent.stepDetails,
        }),
      );
      appendJobTerminalRecorded(c, {
        jobId: intent.workflowJobId,
        sessionId,
        namespace,
        project,
        terminal: {
          content: '',
          outcome: failedTerminalOutcome(workflowCompleted),
        },
        continuity: null,
      });
      return undefined;
    });

    try {
      const serialized = serializeWorkflowResult(intent.stepDetails);
      writeResultArtifact(options.runtime.storage, intent.workflowJobId, serialized.markdown);
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
