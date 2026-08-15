import { dirname } from 'node:path';

import type { Database } from '../../store/db.js';

import type { StoragePort } from '../../infra/port-types.js';
import { decodeBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import type { CauseRef } from '../../causality/cause-ref.js';
import type { JobExportPaths } from '../../infra/path/index.js';
import { jobTerminalRecordedBodySchema } from './result.js';
import { describeTerminalOutcome } from '../outcome.js';
import { readProjectionJobRow } from '../projection-row.js';

function writeResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  paths: JobExportPaths,
  jobId: string,
  markdown: string,
): string {
  const targetPath = paths.resultMarkdown;
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  if (!storage.writeAtomicSync(targetPath, markdown, { encoding: 'utf-8' })) {
    throw new Error(`Failed to write result artifact for ${jobId}`);
  }
  return targetPath;
}

function workflowMetadataJson(db: Database, jobId: string): string | null {
  const projection = readProjectionJobRow(db, jobId);
  if (projection === null || projection.parent_workflow_job_id === null) {
    return null;
  }

  // `result.md` is intentionally result-only. Workflow identity belongs beside it so consumers that diff or
  // parse job results never receive coordinator metadata mixed into the payload.
  return `${JSON.stringify(
    {
      parentWorkflowJobId: projection.parent_workflow_job_id,
      workflowSlotId: projection.workflow_slot,
      workflowSlotGeneration: projection.workflow_slot_generation,
      ...(projection.replaces_workflow_job_id === null
        ? {}
        : { replacesWorkflowJobId: projection.replaces_workflow_job_id }),
    },
    null,
    2,
  )}\n`;
}

function buildResultMarkdown(
  db: Database,
  jobId: string,
  ctx: StoreReadContext,
  describeCauseRef: (ref: CauseRef) => string,
): string | null {
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
  if (event === undefined) {
    return null;
  }
  const body = decodeBody(event, jobTerminalRecordedBodySchema, ctx);

  const content = body.terminal.content.trimEnd();
  if (content && content.length > 0) {
    return `${content}\n`;
  }

  return `${describeTerminalOutcome(body.terminal.outcome, {
    describeCauseRef,
  })}\n`;
}

export function materializeResultMarkdownArtifact(
  db: Database,
  jobId: string,
  paths: JobExportPaths,
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
  describeCauseRef: (ref: CauseRef) => string,
): string {
  const markdown = buildResultMarkdown(db, jobId, ctx, describeCauseRef);
  if (markdown === null) {
    throw new Error(`Cannot materialize result artifact for ${jobId}: terminal record is missing.`);
  }
  writeResultArtifact(storage, paths, jobId, markdown);
  const workflowMetadata = workflowMetadataJson(db, jobId);
  if (workflowMetadata !== null) {
    const metadataPath = paths.workflowMetadata;
    storage.mkdirSync(dirname(metadataPath), { recursive: true });
    if (!storage.writeAtomicSync(metadataPath, workflowMetadata, { encoding: 'utf-8' })) {
      throw new Error(`Failed to write workflow metadata artifact for ${jobId}`);
    }
  }
  return paths.resultMarkdown;
}

export function ensureResultMarkdownArtifact(
  db: Database,
  jobId: string,
  paths: JobExportPaths,
  storage: Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
  describeCauseRef: (ref: CauseRef) => string,
): string {
  const targetPath = paths.resultMarkdown;
  if (storage.existsSync(targetPath)) {
    const projection = readProjectionJobRow(db, jobId);
    if (projection === null || projection.parent_workflow_job_id === null) {
      return targetPath;
    }
  }

  return materializeResultMarkdownArtifact(db, jobId, paths, storage, ctx, describeCauseRef);
}
