import { dirname } from 'node:path';

import type { StoragePort } from '../infra/port-types.js';
import type { JobExportPaths } from '../infra/path/index.js';
import type { Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { readLatestEvent } from '../store/event-queries.js';
import { workflowCompletedBodySchema } from './events.js';
import type { StepDetail } from './execution-contract.js';

/** Serializes the durable workflow step report used by immediate and recovery materialization. */
export function serializeWorkflowResult(details: readonly StepDetail[]): { markdown: string } {
  const lines: string[] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex}.${detail.atomIndex}: ${detail.label}`);
    lines.push('');
    lines.push(...detail.output.split('\n'));
    lines.push('');
  }

  return { markdown: lines.join('\n') };
}

/**
 * Workflow roots export a synthesized multi-step report rather than a provider terminal payload.
 * Keeping this writer in the workflow module prevents provider terminal paths from bypassing the
 * durable terminal materializer in `jobs/terminal/export.ts`.
 */
export function writeWorkflowResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  paths: JobExportPaths,
  workflowJobId: string,
  markdown: string,
): string {
  const targetPath = paths.resultMarkdown;
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  if (!storage.writeAtomicSync(targetPath, markdown, { encoding: 'utf-8' })) {
    throw new Error(`Failed to write workflow result artifact for ${workflowJobId}`);
  }
  return targetPath;
}

/** Rebuilds a workflow-root report from its durable completion event. */
export function materializeWorkflowResultArtifact(
  db: Database,
  workflowJobId: string,
  paths: JobExportPaths,
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
): string {
  const row = readLatestEvent(db, workflowJobId, 'workflow.completed');
  if (row === null || row.stream_kind !== 'workflow') {
    throw new Error(`Cannot materialize workflow result artifact for ${workflowJobId}: completion is missing.`);
  }
  const completion = decodeBody(row, workflowCompletedBodySchema, ctx);
  return writeWorkflowResultArtifact(
    storage,
    paths,
    workflowJobId,
    serializeWorkflowResult(completion.stepDetails).markdown,
  );
}
