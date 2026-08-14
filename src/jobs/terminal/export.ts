import { dirname, join } from 'node:path';

import type { Database } from '../../store/db.js';

import type { StoragePort } from '../../infra/port-types.js';
import { decodeBody, type StoreReadContext } from '../../store/body-codec.js';
import { getEvent } from '../../store/event-queries.js';
import type { EventsRow } from '../../store/schema.js';
import { extractCauseRef, renderCauseRefFallback, type CauseRef } from '../../causality/cause-ref.js';
import type { CoralEvent } from '../../store/envelope.js';
import { isRecord } from '../../infra/json.js';
import { jobTerminalRecordedBodySchema } from './result.js';
import { describeTerminalOutcome } from '../outcome.js';
import { readProjectionJobRow } from '../projection-row.js';

export function resultPathFor(jobsRoot: string, jobId: string): string {
  return join(jobsRoot, jobId, 'result.md');
}

export function writeResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  jobsRoot: string,
  jobId: string,
  markdown: string,
): string {
  const targetPath = resultPathFor(jobsRoot, jobId);
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  if (!storage.writeAtomicSync(targetPath, markdown, { encoding: 'utf-8' })) {
    throw new Error(`Failed to write result artifact for ${jobId}`);
  }
  return targetPath;
}

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

  if (event.type === 'job.terminal.recorded') {
    const parsed = jobTerminalRecordedBodySchema.safeParse(body);
    if (parsed.success) {
      return describeTerminalOutcome(parsed.data.terminal.outcome, {
        describeCauseRef: renderCauseRefFallback,
      });
    }
  }

  return event.type;
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

  const event = getEvent(db, ref.stream, ref.seq, ctx);
  if (!event) {
    return null;
  }

  const localDescription = describeKnownEvent(event);
  const nextRef = extractCauseRef(event.body);
  if (!nextRef) {
    return localDescription;
  }

  const nextDescription = describeCauseRefChain(db, ctx, nextRef, visited);
  return nextDescription === null ? null : `${localDescription} Caused by: ${nextDescription}`;
}

function describeResolvedCauseRef(db: Database, ctx: StoreReadContext, ref: CauseRef): string {
  return describeCauseRefChain(db, ctx, ref, new Set()) ?? renderCauseRefFallback(ref);
}

function workflowIdentityMarkdown(db: Database, jobId: string): string {
  const projection = readProjectionJobRow(db, jobId);
  if (projection === null || projection.parent_workflow_job_id === null) {
    return '';
  }

  const lines = [
    `> Parent workflow: ${projection.parent_workflow_job_id}`,
    `> Workflow slot: ${projection.workflow_slot}`,
    `> Workflow generation: ${projection.workflow_slot_generation}`,
    projection.replaces_workflow_job_id === null
      ? undefined
      : `> Replaces workflow job: ${projection.replaces_workflow_job_id}`,
  ].filter((line): line is string => line !== undefined);
  return `${lines.join('\n')}\n\n`;
}

function buildResultMarkdown(db: Database, jobId: string, ctx: StoreReadContext): string {
  const event = db
    .prepare(
      `SELECT type, body, stream_kind, stream_id
         FROM events
        WHERE stream_id = ?
          AND type = 'job.terminal.recorded'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(jobId) as Pick<EventsRow, 'type' | 'body' | 'stream_kind' | 'stream_id'> | undefined;
  const body = event ? decodeBody(event, jobTerminalRecordedBodySchema, ctx) : null;
  const workflowIdentity = workflowIdentityMarkdown(db, jobId);

  const content = body?.terminal.content.trimEnd();
  if (content && content.length > 0) {
    return `${workflowIdentity}${content}\n`;
  }

  if (body?.terminal.outcome) {
    return `${workflowIdentity}${describeTerminalOutcome(body.terminal.outcome, {
      describeCauseRef: (ref) => describeResolvedCauseRef(db, ctx, ref),
    })}\n`;
  }

  return '';
}

function materializeResultMarkdown(
  db: Database,
  jobId: string,
  jobsRoot: string,
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
): string {
  const markdown = buildResultMarkdown(db, jobId, ctx);
  writeResultArtifact(storage, jobsRoot, jobId, markdown);
  return markdown;
}

export function ensureResultMarkdownArtifact(
  db: Database,
  jobId: string,
  jobsRoot: string,
  storage: Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
): string {
  const targetPath = resultPathFor(jobsRoot, jobId);
  if (storage.existsSync(targetPath)) {
    return targetPath;
  }

  materializeResultMarkdown(db, jobId, jobsRoot, storage, ctx);
  return targetPath;
}
