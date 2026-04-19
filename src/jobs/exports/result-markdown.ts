import type { Database } from 'better-sqlite3';

import type { StoragePort } from '../../runtime/ports.js';
import { decodeEventBody } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import { describeTerminalOutcome } from '../outcome.js';

type JobProjectionRow = {
  terminal: string | null;
};

export function buildResultMarkdown(db: Database, jobId: string): string {
  const projection = db
    .prepare(`SELECT terminal FROM projection_jobs WHERE job_id = ?`)
    .get(jobId) as JobProjectionRow | undefined;
  const terminal = projection?.terminal ? (JSON.parse(projection.terminal) as { outcome: Parameters<typeof describeTerminalOutcome>[0] }) : null;
  const event = db
    .prepare(`SELECT body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.terminal.recorded' ORDER BY seq DESC LIMIT 1`)
    .get(jobId) as Pick<EventsRow, 'body'> | undefined;
  const body = event ? (decodeEventBody(event.body) as { content?: string }) : null;

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
): string {
  const markdown = buildResultMarkdown(db, jobId);
  storage.mkdirSync(outputPath.slice(0, Math.max(0, outputPath.lastIndexOf('/'))), { recursive: true });
  storage.writeFileSync(outputPath, markdown);
  return markdown;
}
