import type { CauseRef, CauseRefToken } from '../../causality/cause-ref.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from '../../jobs/terminal/recording.js';
import type { CommitContext } from '../../store/append.js';
import { workflowCompletedEvent, workflowLifecycleFaultEvent } from '../../workflow/events.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';

export interface WorkflowFinalizationRecording {
  readonly namespace?: string;
  readonly project?: string;
  readonly durationMs: number;
}

/**
 * Spec §7.4 fault precedence: if `causeRef` is set the originating domain
 * event already exists, so we point at it directly. `lifecycleFault` is
 * reserved for wrapper-local failures with no originating domain event —
 * appended only when `causeRef` is absent.
 */
export function selectFinalCauseRef<Scope>(
  c: CommitContext<Scope>,
  workflowJobId: string,
  intent: Extract<WorkflowFinalizationIntent, { outcome: 'failed' }>,
): CauseRef | CauseRefToken<Scope> {
  return intent.causeRef ?? c.append(workflowLifecycleFaultEvent(workflowJobId, intent.lifecycleFault));
}

export function composeWorkflowFinalization<Scope>(
  c: CommitContext<Scope>,
  workflowJobId: string,
  intent: WorkflowFinalizationIntent,
  recording: WorkflowFinalizationRecording,
): void {
  if (intent.workflowJobId !== workflowJobId) {
    throw new Error(`Workflow finalization intent job '${intent.workflowJobId}' did not match '${workflowJobId}'.`);
  }

  if (intent.outcome === 'completed') {
    c.append(workflowCompletedEvent(workflowJobId, { outcome: 'completed', stepDetails: intent.stepDetails }));
    appendJobTerminalRecorded(c, {
      jobId: workflowJobId,
      namespace: recording.namespace,
      project: recording.project,
      terminal: {
        content: intent.finalOutput,
        outcome: { kind: 'completed' },
        durationMs: recording.durationMs,
      },
    });
    return;
  }

  if (intent.outcome === 'aborted') {
    c.append(workflowCompletedEvent(workflowJobId, { outcome: 'aborted', stepDetails: intent.stepDetails }));
    appendJobTerminalRecorded(c, {
      jobId: workflowJobId,
      namespace: recording.namespace,
      project: recording.project,
      terminal: {
        content: '',
        outcome: { kind: 'aborted', reason: intent.reason },
        durationMs: recording.durationMs,
      },
    });
    return;
  }

  const causeRef = selectFinalCauseRef(c, workflowJobId, intent);
  const workflowCompleted = c.append(
    workflowCompletedEvent(workflowJobId, {
      outcome: 'failed',
      causeRef,
      stepDetails: intent.stepDetails,
      ...(intent.failureLocation === undefined ? {} : { failureLocation: intent.failureLocation }),
    }),
  );
  appendJobTerminalRecorded(c, {
    jobId: workflowJobId,
    namespace: recording.namespace,
    project: recording.project,
    terminal: {
      content: '',
      outcome: failedTerminalOutcome(workflowCompleted),
      durationMs: recording.durationMs,
    },
  });
}
