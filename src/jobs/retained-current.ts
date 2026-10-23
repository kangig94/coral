import { readJobOpenedEvent } from './execution-journal.js';
import { JobEvidenceDecodeError } from './source-read.js';
import { readAcceptedTerminal } from './terminal/source.js';
import { decodeBody } from '../store/body-codec.js';
import { jobExecutionEndedBodySchema, jobExecutionOutcomeAcceptedBodySchema } from './terminal/result.js';
import type { EventsRow } from '../store/schema.js';
import type { Database } from '../store/db.js';
import type { Runtime } from '../runtime/ports.js';
import { composeReducers } from '../store/reducers.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { jobsRegistry } from './events.js';
import { deriveLaunchReadiness } from './launch-readiness.js';
import { loadJobExecutionDetails, loadJobProjectionDetail } from './read-queries.js';
import type { JobExecutionLocation, JobLocation, JobLocationIndex } from './location-index.js';
import { hasReadableTerminalDetail } from './terminal/identity.js';
import {
  ResultArtifactPublicationError,
  writeResultArtifact,
  type DecodedResultArtifact,
} from './terminal/artifact.js';
import { renderJobResultMarkdown, renderResultMarkdown, type WorkflowReportPort } from './terminal/render.js';
import { resultPathFor } from './paths.js';
import { readJobTerminalAge } from './terminal-age.js';
import { jobRetentionCutoff } from './export-retention.js';
import { sameEpoch } from '../store/epoch/identity.js';
import { dirname } from 'node:path';
import { backendLog } from '../infra/backend-log.js';

export function loadRetainedCurrentJob(
  db: Database,
  epochKey: string,
  jobId: string,
  jobsRoot: string,
  workflowReport?: WorkflowReportPort,
): JobLocation | null {
  const ctx = { ...composeReducers(jobsRegistry), bodyCodec: createEventBodyCodec() };
  const details = loadJobExecutionDetails(db, jobId, ctx);
  const latest = details.at(-1);
  if (latest === undefined) {
    const opened = loadJobProjectionDetail(db, jobId, ctx);
    if (opened.status === null) {
      if (readJobOpenedEvent(db, jobId) !== undefined)
        throw new JobEvidenceDecodeError('Opened job has no readable projection.');
      return null;
    }
    return {
      version: 'v1',
      jobId,
      epochKey,
      subject: {
        projectRoot: opened.status.projectRoot,
        workDir: opened.status.workDir,
        jobKind: opened.status.jobKind,
      },
      disposition: 'unresolved',
      executions: [],
      detail: {
        kind: 'recorded',
        value: {
          status: { ...opened.status, backendNamespace: opened.status.backendNamespace ?? '' },
          readiness: deriveLaunchReadiness(opened),
          events: [],
          exit: null,
          epochKey,
        },
      },
    };
  }
  const executions: JobExecutionLocation[] = [];
  for (const { execution, requestedSeq, detail } of details) {
    const terminal = detail.events.find((event) => event.type === 'terminal');
    if (terminal === undefined) continue;
    const end = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(terminal.seq);
    if (end === undefined) throw new JobEvidenceDecodeError('Retained execution end is unavailable.');
    const markdown = renderJobResultMarkdown(db, ctx, epochKey, jobId, end, terminal.result, workflowReport);
    executions.push({
      execution,
      requestedSeq,
      seq: terminal.seq,
      resultPath: resultPathFor(jobsRoot, jobId, execution),
      ...(markdown === null ? {} : { resultMarkdown: markdown }),
      detail: { ...detail, epochKey },
    });
  }
  const ended = latest.detail.exit !== null;
  const terminal = ended ? executions.at(-1) : undefined;
  return {
    version: 'v1',
    jobId,
    epochKey,
    subject: {
      projectRoot: latest.detail.status.projectRoot,
      workDir: latest.detail.status.workDir,
      jobKind: latest.detail.status.jobKind,
    },
    disposition: ended ? 'terminal' : 'unresolved',
    latestExecution: latest.execution,
    executions,
    ...(terminal === undefined ? {} : { terminalSeq: terminal.seq, resultPath: terminal.resultPath }),
    detail: {
      kind: 'recorded',
      value: {
        ...latest.detail,
        epochKey,
        resultPath: resultPathFor(jobsRoot, jobId, latest.execution),
      },
    },
  };
}

export function currentResultInput(
  db: Database,
  epochKey: string,
  jobId: string,
  execution?: number,
  workflowReport?: WorkflowReportPort,
): DecodedResultArtifact | null {
  const accepted = readAcceptedTerminal(db, jobId, execution);
  if (accepted === null) return null;
  const ctx = { ...composeReducers(jobsRegistry), bodyCodec: createEventBodyCodec() };
  const end = decodeBody(accepted, jobExecutionEndedBodySchema, ctx);
  const outcome = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(end.causeRef.seq);
  if (
    outcome === undefined ||
    outcome.stream_kind !== 'job' ||
    outcome.stream_id !== jobId ||
    outcome.type !== 'job.execution.outcome.accepted' ||
    end.causeRef.stream.kind !== 'job' ||
    end.causeRef.stream.id !== jobId
  )
    throw new JobEvidenceDecodeError('Execution end has no matching accepted outcome.');
  const body = decodeBody(outcome, jobExecutionOutcomeAcceptedBodySchema, ctx);
  if (body.execution !== end.execution) throw new JobEvidenceDecodeError('Execution end cites another execution.');
  return {
    accepted,
    terminal: body.terminal,
    markdown: renderJobResultMarkdown(db, ctx, epochKey, jobId, accepted, body.terminal, workflowReport),
    age: readJobTerminalAge(db, accepted),
  };
}

export function retainCurrentJob(
  index: JobLocationIndex,
  db: Database,
  epochKey: string,
  jobId: string,
  jobsRoot: string,
  runtime: Pick<Runtime, 'storage' | 'time' | 'env'>,
  verifySource: () => void,
): void {
  const location = loadRetainedCurrentJob(db, epochKey, jobId, jobsRoot, index.workflowReport);
  if (location === null || location.detail.kind !== 'recorded') return;
  index.register(jobId, epochKey, location.subject);
  index.recordExecutionDetails(jobId, location.executions ?? [], location.detail.value);
  for (const entry of location.executions ?? []) {
    const end = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(entry.seq);
    try {
      repairRetainedExecution(
        runtime,
        entry,
        () => {
          verifySource();
          const current = index.read(jobId);
          return (
            current !== null &&
            sameEpoch(current.epochKey, epochKey) &&
            current.executions?.some((known) => known.execution === entry.execution && known.seq === entry.seq) === true
          );
        },
        end === undefined ? 'unknown' : readJobTerminalAge(db, end),
        jobsRoot,
      );
    } catch (error: unknown) {
      if (!(error instanceof ResultArtifactPublicationError)) throw error;
      backendLog.warn(`Retained execution result publication remains pending: ${String(error)}`);
    }
  }
}

export function repairRetainedExecution(
  runtime: Pick<Runtime, 'storage' | 'time' | 'env'>,
  entry: JobExecutionLocation,
  authorized: () => boolean,
  sourceAge: DecodedResultArtifact['age'] | undefined,
  jobsRoot: string,
  sourceMarkdown?: string | null,
): void {
  if (entry.detail.exit === null) return;
  try {
    const stat = runtime.storage.lstatSync(entry.resultPath, { bigint: true });
    if (stat.isFile() && stat.size > 0n) return;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const age = sourceAge ?? Date.parse(entry.detail.exit.endTime);
  if (typeof age === 'number' && Number.isFinite(age) && age < jobRetentionCutoff(runtime)) return;
  const terminal = entry.detail.exit;
  const markdown = sourceMarkdown ?? entry.resultMarkdown ?? renderResultMarkdown(terminal);
  writeResultArtifact(runtime.storage, entry.resultPath, markdown, authorized, jobsRoot);
}

export function currentResultsDurable(
  runtime: Pick<Runtime, 'storage' | 'time' | 'env' | 'paths'>,
  location: JobLocation,
  source: Database | null,
): boolean {
  const executions = location.executions;
  if (
    !hasReadableTerminalDetail(location) ||
    location.latestExecution === undefined ||
    executions === undefined ||
    executions.length !== location.latestExecution
  )
    return false;
  if (location.pendingAdmission !== undefined || location.openExecution !== undefined) return false;
  if (source !== null) {
    const requests = source
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested'")
      .get(location.jobId)?.n;
    const ends = source
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.ended'")
      .get(location.jobId)?.n;
    if (requests !== executions.length || ends !== requests) return false;
  }
  return executions.every((entry) => {
    if (source !== null) {
      const request = source
        .prepare<
          [number, string, number],
          { seq: number }
        >("SELECT seq FROM events WHERE seq = ? AND stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
        .get(entry.requestedSeq, location.jobId, entry.execution);
      if (request === undefined) return false;
      const end = source
        .prepare<
          [number, string, number],
          EventsRow
        >("SELECT * FROM events WHERE seq = ? AND stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.ended' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
        .get(entry.seq, location.jobId, entry.execution);
      if (end === undefined || end.ts !== entry.detail.exit?.endTime) return false;
      const age = readJobTerminalAge(source, end);
      if (typeof age === 'number' && age < jobRetentionCutoff(runtime)) return true;
    }
    const fd = runtime.storage.openSync(entry.resultPath, 'r');
    try {
      const file = runtime.storage.fstatSync(fd, { bigint: true });
      if (!file.isFile() || file.size === 0n) return false;
      runtime.storage.fdatasyncSync(fd);
      const boundary = dirname(runtime.paths.coral.exports.jobsRoot);
      for (let directory = dirname(entry.resultPath); ; directory = dirname(directory)) {
        if (!runtime.storage.syncDirectoryDurableSync(directory)) return false;
        if (directory === boundary || directory === dirname(directory)) break;
      }
      return true;
    } finally {
      runtime.storage.closeSync(fd);
    }
  });
}
