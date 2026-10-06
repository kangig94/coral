import assert from 'node:assert/strict';
import { z } from 'zod';
import { decodeWaitCursor, waitJobHash, serializeWaitCursor } from './cursor.js';
import {
  WAIT_PROGRESS_BYTES,
  WAIT_PROGRESS_LINES,
  WAIT_SNAPSHOT_BYTES,
  type WaitCursor,
  type ProgressVisit,
} from './contract.js';
import { resultAvailabilitySchema } from './stream-event.js';
import type { WaitAdmission, WaitSession, WaitSnapshot, WaitSnapshotJob, WaitTerminalSummary } from './session.js';
import { WaitSessionError, waitTerminalExitCode } from './session.js';

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function preview(text: string, budget: number): { text: string; omitted: boolean } {
  const window = text.slice(0, budget);
  if (window.length === text.length && encodedBytes(window) <= budget) return { text, omitted: false };
  let start = 0;
  let end = window.length;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (encodedBytes(window.slice(0, middle)) <= budget - 100) start = middle;
    else end = middle - 1;
  }
  if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
  const selected = text.slice(0, start);
  return { text: `${selected}[preview shortened: content omitted]`, omitted: true };
}

/** One poll: the outcome of a job is summarized, and so collected, only once its readable progress is delivered. */
export function selectWaitSnapshot(session: WaitSession, lines = 20, visit: ProgressVisit): WaitSnapshot {
  return session.withProgress(visit, (sources) => {
    const selection = session.select(sources, { lines: WAIT_PROGRESS_LINES, bytes: WAIT_PROGRESS_BYTES }, lines);
    session.commit(selection);
    const jobs = session.admissions.map((admission) => snapshotJob(session, admission));
    for (const row of selection.rows) {
      const job = jobs.find((job) => job.jobId === row.jobId);
      assert(job);
      job.progress.push(...row.message.split('\n'));
    }
    const notices = [...session.notices];
    if (session.hasProgress()) notices.push('Progress truncated; run the continuation to collect the remaining lines.');
    const remainingJobIds = session.remaining();
    const snapshot: WaitSnapshot = {
      jobs,
      notices,
      cursor: session.cursor(remainingJobIds),
      remainingJobIds,
      exitCode: session.exitCode(),
    };
    fitSnapshotResponse(snapshot, session);
    return snapshot;
  });
}

function snapshotJob(session: WaitSession, admission: WaitAdmission): WaitSnapshotJob {
  const { jobId, disposition, message, detail, availability } = admission;
  const row: WaitSnapshotJob = { jobId, disposition, ...(message === undefined ? {} : { message }), progress: [] };
  if (disposition !== 'admitted') return row;
  row.phase = detail?.status.phase ?? 'unresolved';
  if (!detail?.exit || !session.terminalDeliverable(admission)) return row;
  row.availability = availability;
  row.alreadyCollected = session.collected(admission);
  if (!row.alreadyCollected) {
    row.terminal = terminalSummary(detail, detail.exit);
    session.collect(admission);
  }
  return row;
}

function terminalSummary(
  detail: NonNullable<WaitAdmission['detail']>,
  terminal: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
): WaitTerminalSummary {
  const content = preview(terminal.content, 2048);
  let diagnosticOmitted = false;
  function boundedDiagnostic(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
      const selected = preview(value, 256);
      diagnosticOmitted ||= selected.omitted;
      return selected.text;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth === 4) {
      diagnosticOmitted = true;
      return '[preview omitted]';
    }
    if (Array.isArray(value)) {
      diagnosticOmitted ||= value.length > 8;
      return value.slice(0, 8).map((item) => boundedDiagnostic(item, depth + 1));
    }
    const selected: Record<string, unknown> = {};
    let count = 0;
    for (const key in value) {
      if (count++ === 8) {
        diagnosticOmitted = true;
        break;
      }
      selected[key] = boundedDiagnostic((value as Record<string, unknown>)[key], depth + 1);
    }
    return selected;
  }
  const diagnostic = preview(
    JSON.stringify(boundedDiagnostic({ outcome: terminal.outcome, diagnostics: terminal.diagnostics })),
    2048,
  );
  return {
    seq: detail.terminalSeq ?? detail.status.lastSeq ?? 0,
    outcomeKind: terminal.outcome.kind,
    exitCode: waitTerminalExitCode(terminal),
    durationMs: terminal.durationMs,
    contentPreview: content.text,
    contentOmitted: content.omitted,
    diagnosticPreview: diagnostic.text,
    diagnosticOmitted: diagnosticOmitted || diagnostic.omitted,
  };
}

/** The one snapshot size policy: a JSON-RPC envelope at most this large, whatever carries it. */
export function waitSnapshotEnvelopeFits(encodedBytes: number): boolean {
  return encodedBytes <= WAIT_SNAPSHOT_BYTES;
}

function snapshotEnvelopeBytes(snapshot: unknown): number {
  return encodedBytes({ jsonrpc: '2.0', id: 'x'.repeat(1024), result: snapshot });
}

/** An oversized snapshot never advances the input cursor; each subset retry repeats that unchanged cursor. */
export function waitSnapshotTooLarge(jobIds: readonly string[], input: WaitCursor | undefined): WaitSessionError {
  const retries = jobIds.map(
    (jobId) =>
      `coral-cli wait jobs '${jobId.replaceAll("'", "'\\''")}' --now${input ? ` --cursor ${serializeWaitCursor(input)}` : ''}`,
  );
  return new WaitSessionError(
    'wait_snapshot_too_large',
    `Snapshot exceeds the response size budget. Retry subsets with the original cursor: ${retries.join('; ')}. The input cursor has not advanced.`,
  );
}

function fitSnapshotResponse(snapshot: WaitSnapshot, session: WaitSession): void {
  if (waitSnapshotEnvelopeFits(snapshotEnvelopeBytes(snapshot))) return;
  for (const job of snapshot.jobs)
    if (job.terminal) {
      job.terminal.contentOmitted = true;
      job.terminal.contentPreview = '[preview omitted: response size budget]';
      job.terminal.diagnosticOmitted = true;
      job.terminal.diagnosticPreview = '[diagnostics omitted: response size budget]';
    }
  if (!waitSnapshotEnvelopeFits(snapshotEnvelopeBytes(snapshot)))
    throw waitSnapshotTooLarge(session.jobIds, session.input);
}

/** A partial or malformed unary response must not advance collection state. */
export function parseWaitSnapshot(value: unknown, jobIds?: readonly string[]): WaitSnapshot {
  const snapshot = waitSnapshotSchema.parse(value);
  if (
    jobIds &&
    (jobIds.length !== snapshot.jobs.length || jobIds.some((id, index) => id !== snapshot.jobs[index].jobId))
  )
    throw new WaitSessionError('wait_snapshot_malformed', 'Snapshot membership does not match the requested jobs.');
  return snapshot;
}

const waitSnapshotSchema = z
  .object({
    jobs: z
      .array(
        z
          .object({
            jobId: z.string().min(1),
            disposition: z.enum(['admitted', 'missing', 'scope-mismatch', 'unknown', 'unreadable']),
            message: z.string().optional(),
            phase: z.string().optional(),
            alreadyCollected: z.boolean().optional(),
            progress: z.array(z.string()),
            terminal: z
              .object({
                seq: z.number().int().safe().nonnegative(),
                outcomeKind: z.enum(['completed', 'aborted', 'provider_exit', 'failed', 'job_fault']),
                exitCode: z.number().int().min(0).max(255),
                durationMs: z.number().nonnegative(),
                contentPreview: z.string(),
                contentOmitted: z.boolean(),
                diagnosticPreview: z.string(),
                diagnosticOmitted: z.boolean(),
              })
              .strip()
              .optional(),
            availability: resultAvailabilitySchema.optional(),
          })
          .strip(),
      )
      .max(128),
    notices: z.array(z.string()),
    cursor: z.custom<WaitCursor>((value) => decodeWaitCursor(value).kind === 'decoded'),
    remainingJobIds: z.array(z.string()).max(128),
    exitCode: z.number().int().min(0).max(255),
  })
  .strip()
  .superRefine((snapshot, ctx) => {
    const lines = snapshot.jobs.flatMap((job) => job.progress);
    if (
      encodedBytes(snapshot) > WAIT_SNAPSHOT_BYTES ||
      lines.length > WAIT_PROGRESS_LINES ||
      lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0) > WAIT_PROGRESS_BYTES ||
      new Set(snapshot.jobs.map((job) => job.jobId)).size !== snapshot.jobs.length ||
      new Set(snapshot.remainingJobIds).size !== snapshot.remainingJobIds.length ||
      snapshot.remainingJobIds.some((id) => {
        const job = snapshot.jobs.find((row) => row.jobId === id);
        return !job || (job.disposition !== 'admitted' && job.disposition !== 'unknown');
      }) ||
      snapshot.cursor.jobs.some((entry) => !snapshot.remainingJobIds.some((id) => waitJobHash(id) === entry.hash)) ||
      snapshot.jobs.some((job) =>
        job.disposition === 'admitted'
          ? !job.phase || (job.terminal !== undefined && !job.availability)
          : job.terminal !== undefined ||
            job.alreadyCollected !== undefined ||
            job.availability !== undefined ||
            job.progress.length > 0,
      ) ||
      lines.some((line) => Buffer.byteLength(line) > 4096) ||
      snapshot.jobs.some(
        (job) =>
          job.terminal &&
          (encodedBytes(job.terminal.contentPreview) + encodedBytes(job.terminal.diagnosticPreview) > 4096 ||
            job.alreadyCollected === true),
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid snapshot delivery contract' });
  });
