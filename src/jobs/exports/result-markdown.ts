import type { Database } from 'better-sqlite3';

import type { StoragePort } from '../../runtime/ports.js';
import { decodeBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import { jobTerminalRecordedBodySchema } from '../events.js';
import { describeTerminalOutcome } from '../outcome.js';

type JobProjectionEntry = {
  terminal: string | null;
};

export function buildResultMarkdown(db: Database, jobId: string, ctx: StoreReadContext): string {
  const projection = db
    .prepare(`SELECT terminal FROM projection_jobs WHERE job_id = ?`)
    .get(jobId) as JobProjectionEntry | undefined;
  const terminal = projection?.terminal ? (JSON.parse(projection.terminal) as { outcome: Parameters<typeof describeTerminalOutcome>[0] }) : null;
  const event = db
    .prepare(
      `SELECT type, body, body_version, stream_kind, stream_id
         FROM events
        WHERE stream_kind = 'job'
          AND stream_id = ?
          AND type = 'job.terminal.recorded'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(jobId) as Pick<EventsRow, 'type' | 'body' | 'body_version' | 'stream_kind' | 'stream_id'> | undefined;
  const body = event ? decodeBody(event, jobTerminalRecordedBodySchema, ctx) : null;

  const content = body?.content?.trimEnd();
  if (content && content.length > 0) {
    return `${content}\n`;
  }

  if (terminal?.outcome) {
    return `${describeTerminalOutcome(terminal.outcome)}\n`;
  }

  return '';
}

export function materializeResultMarkdown(
  db: Database,
  jobId: string,
  outputPath: string,
  storage: Pick<StoragePort, 'mkdirSync' | 'writeFileSync'>,
  ctx: StoreReadContext,
): string {
  const markdown = buildResultMarkdown(db, jobId, ctx);
  storage.mkdirSync(outputPath.slice(0, Math.max(0, outputPath.lastIndexOf('/'))), { recursive: true });
  storage.writeFileSync(outputPath, markdown);
  return markdown;
}
