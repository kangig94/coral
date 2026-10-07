import type { WorkflowReportPort } from '../jobs/terminal/export.js';
import { describeTerminalOutcome } from '../jobs/outcome.js';
import { workflowCompletedBodySchema } from './events.js';
import type { StepDetail } from './execution-contract.js';
import type { EventsRow } from '../store/schema.js';

/** Workflow rendering facts must belong to the accepted terminal's epoch and workflow. */
export const renderWorkflowReport: WorkflowReportPort = ({ db, jobId, accepted, terminal }) => {
  const launch = db
    .prepare<
      [string],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.launch.requested' ORDER BY seq LIMIT 1")
    .get(jobId);
  if (!launch) return null;
  const body = JSON.parse(Buffer.from(launch.body).toString('utf8')) as { jobKind?: string };
  if (body.jobKind !== 'workflow') return null;
  const completed = db
    .prepare<
      [string, number],
      EventsRow
    >("SELECT * FROM events WHERE stream_kind = 'workflow' AND stream_id = ? AND type = 'workflow.completed' AND seq < ? ORDER BY seq DESC LIMIT 1")
    .get(jobId, accepted.seq);
  if (!completed) return `${describeTerminalOutcome(terminal.outcome)}\n`;
  const parsed = workflowCompletedBodySchema.safeParse(JSON.parse(Buffer.from(completed.body).toString('utf8')));
  if (!parsed.success || parsed.data.outcome !== terminal.outcome.kind) return null;
  if (
    terminal.outcome.kind === 'failed' &&
    (terminal.outcome.causeRef.stream.kind !== 'workflow' ||
      terminal.outcome.causeRef.stream.id !== jobId ||
      terminal.outcome.causeRef.seq !== completed.seq)
  )
    return null;
  const { stepDetails } = parsed.data;
  const markdown = serializeWorkflowResult(stepDetails);
  return markdown.trim().length > 0 ? markdown : `${describeTerminalOutcome(terminal.outcome)}\n`;
};

function serializeWorkflowResult(details: StepDetail[]): string {
  const lines: string[] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex}.${detail.atomIndex}: ${detail.label}`);
    lines.push('');
    const contentLines = detail.output.split('\n');
    lines.push(...contentLines);
    lines.push('');
  }

  return lines.join('\n');
}
