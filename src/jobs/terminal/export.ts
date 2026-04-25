import { dirname, join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { jobsDir } from "../paths.js";
import type { StoragePort } from '../../runtime/ports.js';
import { decodeBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import { jobTerminalRecordedBodySchema } from './result.js';
import { describeTerminalOutcome } from '../outcome.js';

export function resultPathFor(jobId: string): string {
  return join(jobsDir(), jobId, 'result.md');
}

export function writeResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  jobId: string,
  markdown: string,
): string {
  const targetPath = resultPathFor(jobId);
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  if (!storage.writeAtomicSync(targetPath, markdown, { encoding: 'utf-8' })) {
    throw new Error(`Failed to write result artifact for ${jobId}`);
  }
  return targetPath;
}

export function buildResultMarkdown(db: Database, jobId: string, ctx: StoreReadContext): string {
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

  const content = body?.terminal.content.trimEnd();
  if (content && content.length > 0) {
    return `${content}\n`;
  }

  if (body?.terminal.outcome) {
    return `${describeTerminalOutcome(body.terminal.outcome)}\n`;
  }

  return '';
}

export function materializeResultMarkdown(
  db: Database,
  jobId: string,
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
): string {
  const markdown = buildResultMarkdown(db, jobId, ctx);
  writeResultArtifact(storage, jobId, markdown);
  return markdown;
}

export function ensureResultMarkdownArtifact(
  db: Database,
  jobId: string,
  storage: Pick<StoragePort, 'existsSync' | 'mkdirSync' | 'writeAtomicSync'>,
  ctx: StoreReadContext,
): string {
  const targetPath = resultPathFor(jobId);
  if (storage.existsSync(targetPath)) {
    return targetPath;
  }

  materializeResultMarkdown(db, jobId, storage, ctx);
  return targetPath;
}
