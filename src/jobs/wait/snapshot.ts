import { z } from 'zod';
import { decodeWaitCursor, waitJobHash, serializeWaitCursor } from './cursor.js';
import { WAIT_SNAPSHOT_BYTES, type WaitCursorV3 } from './contract.js';
import { resultAvailabilitySchema } from './stream-event.js';
import type { WaitAdmission, WaitSession, WaitSnapshot, WaitSnapshotJob, WaitTerminalSummary } from './session.js';
import { WaitSessionError, waitTerminalExitCode } from './session.js';

export const WAIT_PROGRESS_LINES = 500;
export const WAIT_PROGRESS_BYTES = 64 * 1024;

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function preview(text: string, budget: number): { text: string; omitted: number } {
  if (encodedBytes(text) <= budget) return { text, omitted: 0 };
  let start = 0;
  let end = text.length;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (encodedBytes(text.slice(0, middle)) <= budget - 100) start = middle;
    else end = middle - 1;
  }
  if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1])) start--;
  const selected = text.slice(0, start);
  const omitted = Buffer.byteLength(text) - Buffer.byteLength(selected);
  return { text: `${selected}[preview shortened: ${omitted} bytes omitted]`, omitted };
}

/** Summary delivery acknowledges the outcome, independently of progress or full text retrieval. */
export function selectWaitSnapshot(session: WaitSession, lines?: number): WaitSnapshot {
  const notices = [...session.notices];
  const jobs = session.admissions.map((admission) => snapshotJob(session, admission, notices));
  const originalProgress = session.cursor();
  validateSnapshotMetadata(session, jobs, notices);
  const selectedCount = selectSnapshotProgress(session, jobs, notices, lines);
  const remainingJobIds = session.remaining();
  const snapshot: WaitSnapshot = {
    version: 'jobs.wait.v3',
    jobs,
    notices,
    remainingJobIds,
    cursor: session.cursor(remainingJobIds),
    exitCode: session.exitCode(),
  };
  fitSnapshotResponse(session, snapshot, originalProgress, selectedCount);
  return snapshot;
}

function snapshotJob(session: WaitSession, admission: WaitAdmission, notices: string[]): WaitSnapshotJob {
  const { jobId, disposition, message, detail, availability } = admission;
  const row: WaitSnapshotJob = { jobId, disposition, ...(message === undefined ? {} : { message }), progress: [] };
  if (disposition !== 'admitted') return row;
  row.epochToken = session.cursor([jobId]).epochs[0]?.token;
  row.phase = detail?.status.phase ?? 'unresolved';
  if (admission.progressUnknown)
    notices.push(`Earlier progress for ${jobId} could not be read; retry the continuation.`);
  if (admission.progressLost) notices.push(`earlier progress for ${jobId} is no longer kept`);
  if (detail?.exit) {
    row.availability = availability;
    row.alreadyCollected = session.acknowledged(jobId);
    row.artifactFollowUp = row.alreadyCollected && session.artifactPending(jobId);
    if (!row.alreadyCollected) {
      row.terminal = terminalSummary(detail, detail.exit);
      session.acknowledge(admission);
    } else if (row.artifactFollowUp && availability?.kind !== 'repair-pending') session.settleArtifact(jobId);
  }
  return row;
}

function terminalSummary(
  detail: NonNullable<WaitAdmission['detail']>,
  terminal: NonNullable<NonNullable<WaitAdmission['detail']>['exit']>,
): WaitTerminalSummary {
  const content = preview(terminal.content, 2048);
  const diagnostic = preview(JSON.stringify({ outcome: terminal.outcome, diagnostics: terminal.diagnostics }), 2048);
  return {
    seq: detail.events.find((event) => event.type === 'terminal')?.seq ?? detail.status.lastSeq ?? 0,
    outcomeKind: terminal.outcome.kind,
    exitCode: waitTerminalExitCode(terminal),
    durationMs: terminal.durationMs,
    contentPreview: content.text,
    contentOmittedBytes: content.omitted,
    diagnosticPreview: diagnostic.text,
    diagnosticOmittedBytes: diagnostic.omitted,
  };
}

function validateSnapshotMetadata(session: WaitSession, jobs: WaitSnapshotJob[], notices: string[]): void {
  const mandatory = {
    version: 'jobs.wait.v3',
    jobs: jobs.map((job) => ({
      ...job,
      terminal: job.terminal ? { ...job.terminal, contentPreview: '', diagnosticPreview: '' } : undefined,
    })),
    cursor: session.cursor(session.remaining()),
    remainingJobIds: session.remaining(),
    notices,
    exitCode: session.exitCode(),
  };
  assertSnapshotFits(mandatory, session);
}

function lastLinesPerJob(available: ReturnType<WaitSession['progress']>, count: number): typeof available {
  const offsets = new Map<string, number>();
  for (const line of available) offsets.set(line.jobId, (offsets.get(line.jobId) ?? 0) + 1);
  const seen = new Map<string, number>();
  return available.filter((line) => {
    const index = (seen.get(line.jobId) ?? 0) + 1;
    seen.set(line.jobId, index);
    return index > (offsets.get(line.jobId) ?? 0) - count;
  });
}

function selectSnapshotProgress(
  session: WaitSession,
  jobs: WaitSnapshotJob[],
  notices: string[],
  lines?: number,
): number {
  const available = session.progress();
  let selected: typeof available;
  if (lines !== undefined) {
    let low = 0;
    let high = Math.min(lines, WAIT_PROGRESS_LINES);
    const tails = lastLinesPerJob(available, high);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = lastLinesPerJob(tails, middle);
      if (
        candidate.length <= WAIT_PROGRESS_LINES &&
        candidate.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0) <= WAIT_PROGRESS_BYTES
      )
        low = middle;
      else high = middle - 1;
    }
    selected = lastLinesPerJob(tails, low);
    if (selected.length < available.length)
      notices.push(`${available.length - selected.length} earlier progress lines were not shown.`);
    session.skipEarlierProgress();
  } else {
    let bytes = 0;
    selected = [];
    for (const line of available) {
      if (selected.length === WAIT_PROGRESS_LINES || bytes + Buffer.byteLength(line.text) > WAIT_PROGRESS_BYTES) break;
      selected.push(line);
      bytes += Buffer.byteLength(line.text);
      session.consume(line);
    }
    if (selected.length < available.length)
      notices.push('Progress truncated; run the continuation to collect the remaining lines.');
  }
  for (const line of selected) jobs.find((job) => job.jobId === line.jobId)?.progress.push(line.text);
  return selected.length;
}

function fitSnapshotResponse(
  session: WaitSession,
  snapshot: WaitSnapshot,
  originalProgress: WaitCursorV3,
  selectedCount: number,
): void {
  if (encodedBytes({ jsonrpc: '2.0', id: 'x'.repeat(1024), result: snapshot }) > WAIT_SNAPSHOT_BYTES) {
    for (const job of snapshot.jobs) {
      if (job.terminal) {
        job.terminal.contentOmittedBytes += Buffer.byteLength(job.terminal.contentPreview);
        job.terminal.contentPreview = '[preview omitted: response size budget]';
        job.terminal.diagnosticOmittedBytes += Buffer.byteLength(job.terminal.diagnosticPreview);
        job.terminal.diagnosticPreview = '[diagnostics omitted: response size budget]';
      }
    }
    if (
      encodedBytes({ jsonrpc: '2.0', id: 'x'.repeat(1024), result: snapshot }) > WAIT_SNAPSHOT_BYTES &&
      selectedCount > 0
    ) {
      for (const job of snapshot.jobs) job.progress = [];
      session.restoreProgress(originalProgress);
      snapshot.notices.push('Progress omitted to fit the complete response; run the continuation.');
      snapshot.remainingJobIds = session.remaining();
      snapshot.cursor = session.cursor(snapshot.remainingJobIds);
      snapshot.exitCode = session.exitCode();
    }
    assertSnapshotFits(snapshot, session);
  }
}

function assertSnapshotFits(snapshot: unknown, session: WaitSession): void {
  if (encodedBytes({ jsonrpc: '2.0', id: 'x'.repeat(1024), result: snapshot }) <= WAIT_SNAPSHOT_BYTES) return;
  const retries = session.jobIds.map(
    (jobId) =>
      `coral-cli wait jobs '${jobId.replaceAll("'", "'\\''")}' --now${session.input ? ` --cursor ${serializeWaitCursor(session.input)}` : ''}`,
  );
  const retry = retries.join('; ');
  throw new WaitSessionError(
    'wait_snapshot_too_large',
    `Snapshot identity metadata exceeds the response size budget. Retry a smaller job set: ${retry}. The input cursor has not advanced.`,
  );
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
    version: z.literal('jobs.wait.v3'),
    jobs: z
      .array(
        z
          .object({
            jobId: z.string().min(1),
            disposition: z.enum([
              'admitted',
              'missing',
              'discovery-unknown',
              'pre-epoch-history',
              'outcome-unrecoverable',
              'scope-mismatch',
            ]),
            message: z.string().optional(),
            epochToken: z
              .string()
              .regex(/^[a-f0-9]{32}$/)
              .optional(),
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
                contentOmittedBytes: z.number().int().nonnegative(),
                diagnosticPreview: z.string(),
                diagnosticOmittedBytes: z.number().int().nonnegative(),
              })
              .strip()
              .optional(),
            availability: resultAvailabilitySchema.optional(),
            artifactFollowUp: z.boolean().optional(),
          })
          .strip(),
      )
      .max(128),
    notices: z.array(z.string()),
    cursor: z.custom<WaitCursorV3>((value) => {
      const decoded = decodeWaitCursor(value);
      return decoded.kind === 'decoded' && decoded.cursor.version === 'jobs.wait.v3';
    }),
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
      snapshot.cursor.jobs.length !== snapshot.remainingJobIds.length ||
      snapshot.remainingJobIds.some((id) => {
        const job = snapshot.jobs.find((row) => row.jobId === id);
        return (
          !job ||
          (job.disposition !== 'admitted' && job.disposition !== 'discovery-unknown') ||
          !snapshot.cursor.jobs.some((entry) => entry.hash === waitJobHash(id))
        );
      }) ||
      snapshot.jobs.some((job) =>
        job.disposition === 'admitted'
          ? !job.epochToken || !job.phase || (job.terminal !== undefined && !job.availability)
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
