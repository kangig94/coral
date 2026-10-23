import { jobsEventDescribers } from '../event-describers.js';
import { readJobOpened, readJobOpenedEvent } from '../execution-journal.js';
import type { Database } from '../../store/db.js';
import type { StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import { rowToCoralEvent, type CoralEvent } from '../../store/envelope.js';
import { extractCauseRef, renderCauseRefFallback, type CauseRef } from '../../causality/cause-ref.js';
import { isRecord } from '../../infra/json.js';
import { backendLog } from '../../infra/backend-log.js';
import { jobExecutionOutcomeAcceptedBodySchema } from './result.js';
import { describeTerminalOutcome } from '../outcome.js';
import type { JobTerminal } from '../records.js';

function describeKnownEvent(event: CoralEvent): string {
  const body = event.body;
  if (event.type === 'workflow.completed' && isRecord(body) && typeof body.outcome === 'string') {
    return `Workflow ${body.outcome}.`;
  }

  if (
    event.type === 'workflow.lifecycle_fault' &&
    isRecord(body) &&
    typeof body.kind === 'string' &&
    typeof body.message === 'string'
  ) {
    return `Workflow lifecycle fault (${body.kind}): ${body.message}.`;
  }

  if (event.type === 'job.execution.outcome.accepted') {
    const parsed = jobExecutionOutcomeAcceptedBodySchema.safeParse(body);
    if (parsed.success) {
      return describeTerminalOutcome(parsed.data.terminal.outcome, {
        describeCauseRef: renderCauseRefFallback,
      });
    }
  }

  return jobsEventDescribers.get(`job:${event.type}`)?.(event) ?? event.type;
}

function describeCauseRefChain(
  db: Database,
  ctx: StoreReadContext,
  ref: CauseRef,
  visited: Set<string>,
): string | null {
  const key = `${ref.stream.kind}:${ref.stream.id}:${ref.seq}`;
  if (visited.has(key)) {
    return null;
  }
  visited.add(key);

  const row = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(ref.seq);
  if (!row || row.stream_kind !== ref.stream.kind || row.stream_id !== ref.stream.id) {
    return null;
  }

  const body: unknown = JSON.parse(Buffer.from(row.body).toString('utf8'));
  const event = rowToCoralEvent(row, body);
  const localDescription = describeKnownEvent(event);
  const nextRef = extractCauseRef(body);
  if (!nextRef) {
    return localDescription;
  }

  const nextDescription = describeCauseRefChain(db, ctx, nextRef, visited);
  return nextDescription === null ? null : `${localDescription} Caused by: ${nextDescription}`;
}

function describeResolvedCauseRef(db: Database, ctx: StoreReadContext, ref: CauseRef): string {
  try {
    return describeCauseRefChain(db, ctx, ref, new Set()) ?? renderCauseRefFallback(ref);
  } catch (error: unknown) {
    backendLog.warn(`Result cause evidence unavailable: ${String(error)}`);
    return renderCauseRefFallback(ref);
  }
}

function workflowIdentityMarkdown(db: Database, jobId: string): string {
  const opened = readJobOpenedEvent(db, jobId);
  if (!opened) return '';
  const refs: unknown = opened.refs ? JSON.parse(opened.refs) : null;
  if (!isRecord(refs) || typeof refs.parentJobId !== 'string') return '';
  return `> Parent workflow: ${refs.parentJobId}\n> Workflow slot: ${refs.workflowSlotId}\n\n`;
}

export type WorkflowReportPort = (
  input: Readonly<{
    db: Database;
    epochKey: string;
    jobId: string;
    accepted: EventsRow;
    terminal: JobTerminal;
  }>,
) => string | null;

export function renderResultMarkdown(
  terminal: JobTerminal,
  identity = '',
  report?: string | null,
  describeCauseRef?: (ref: CauseRef) => string,
): string {
  const content = report?.trimEnd() ?? terminal.content.trimEnd();
  return `${identity}${content.length > 0 ? content : describeTerminalOutcome(terminal.outcome, { describeCauseRef })}\n`;
}

export function renderJobResultMarkdown(
  db: Database,
  ctx: StoreReadContext,
  epochKey: string,
  jobId: string,
  accepted: EventsRow,
  terminal: JobTerminal,
  workflowReport?: WorkflowReportPort,
): string | null {
  const report = workflowReport?.({ db, epochKey, jobId, accepted, terminal });
  if (report === null && workflowReport !== undefined && readJobOpened(db, jobId, ctx)?.jobKind === 'workflow')
    return null;
  return renderResultMarkdown(terminal, workflowIdentityMarkdown(db, jobId), report, (ref) =>
    describeResolvedCauseRef(db, ctx, ref),
  );
}
