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
import { writeResultArtifact, type DecodedResultArtifact } from './terminal/artifact.js';
import { describeTerminalOutcome } from './outcome.js';
import { jobRetentionCutoff } from './export-retention.js';
import { sameEpoch } from '../store/epoch/identity.js';
import { dirname, join } from 'node:path';

/** Current epochs retain complete per-execution evidence, independently of the latest projection. */
export function loadRetainedCurrentJob(
  db: Database,
  epochKey: string,
  jobId: string,
  jobsRoot: string,
): JobLocation | null {
  const ctx = { ...composeReducers(jobsRegistry), bodyCodec: createEventBodyCodec() };
  const details = loadJobExecutionDetails(db, jobId, ctx);
  const latest = details.at(-1);
  if (latest === undefined) {
    const opened = loadJobProjectionDetail(db, jobId, ctx);
    if (opened.status === null) return null;
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
  const executions: JobExecutionLocation[] = details.flatMap(({ execution, requestedSeq, detail }) => {
    const terminal = detail.events.find((event) => event.type === 'terminal');
    return terminal === undefined
      ? []
      : [
          {
            execution,
            requestedSeq,
            seq: terminal.seq,
            resultPath: join(jobsRoot, jobId, 'executions', String(execution), 'result.md'),
            detail: { ...detail, epochKey },
          },
        ];
  });
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
    detail: { kind: 'recorded', value: { ...latest.detail, epochKey } },
  };
}

function executionAge(
  db: Database,
  jobId: string,
  requestedSeq: number,
  seq: number,
  ts: string,
): DecodedResultArtifact['age'] {
  const preceding = db
    .prepare<
      [string, number, number],
      { ts: string }
    >("SELECT ts FROM events WHERE stream_kind = 'job' AND stream_id = ? AND seq >= ? AND seq < ? ORDER BY ts DESC LIMIT 1")
    .get(jobId, requestedSeq, seq);
  const at = Date.parse(ts);
  const before = Date.parse(preceding?.ts ?? '');
  return !Number.isFinite(at) || !Number.isFinite(before) ? 'unknown' : at < before ? 'regression' : at;
}

export function currentResultInput(
  db: Database,
  epochKey: string,
  jobId: string,
  jobsRoot: string,
): DecodedResultArtifact | null {
  const location = loadRetainedCurrentJob(db, epochKey, jobId, jobsRoot);
  if (location === null || !hasReadableTerminalDetail(location)) return null;
  const entry = location.executions?.at(-1);
  if (entry === undefined || entry.detail.exit === null) return null;
  const accepted = db.prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?').get(entry.seq);
  if (accepted === undefined) return null;
  const exit = entry.detail.exit;
  return {
    accepted,
    terminal: { content: exit.content, outcome: exit.outcome, durationMs: exit.durationMs },
    markdown: `${exit.content.trimEnd() || describeTerminalOutcome(exit.outcome)}\n`,
    age: executionAge(db, jobId, entry.requestedSeq, entry.seq, accepted.ts),
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
  const location = loadRetainedCurrentJob(db, epochKey, jobId, jobsRoot);
  if (location === null || location.detail.kind !== 'recorded') return;
  index.register(jobId, epochKey, location.subject);
  index.recordExecutionDetails(jobId, location.executions ?? [], location.detail.value);
  for (const entry of location.executions ?? []) {
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
      executionAge(db, jobId, entry.requestedSeq, entry.seq, entry.detail.exit?.endTime ?? ''),
    );
  }
}

/** Complete durable evidence can repair an execution after its journal has been retired. */
export function repairRetainedExecution(
  runtime: Pick<Runtime, 'storage' | 'time' | 'env'>,
  entry: JobExecutionLocation,
  authorized: () => boolean,
  sourceAge?: DecodedResultArtifact['age'],
): void {
  if (entry.detail.exit === null) return;
  try {
    const stat = runtime.storage.lstatSync(entry.resultPath, { bigint: true });
    if (stat.isFile() && stat.size > 0n) return;
  } catch {
    /* Only a missing artifact is eligible for publication. */
  }
  const age = sourceAge ?? Date.parse(entry.detail.exit.endTime);
  if (typeof age === 'number' && Number.isFinite(age) && age < jobRetentionCutoff(runtime)) return;
  const terminal = entry.detail.exit;
  const markdown = `${terminal.content.trimEnd() || describeTerminalOutcome(terminal.outcome)}\n`;
  writeResultArtifact(
    runtime.storage,
    entry.resultPath,
    markdown,
    authorized,
    dirname(dirname(dirname(dirname(entry.resultPath)))),
  );
}

export function currentResultsDurable(
  runtime: Pick<Runtime, 'storage' | 'time' | 'env'>,
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
  if (location.pendingAdmission !== undefined) return false;
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
      const end = source
        .prepare<
          [number, string],
          { ts: string }
        >("SELECT ts FROM events WHERE seq = ? AND stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.ended'")
        .get(entry.seq, location.jobId);
      const age =
        end === undefined ? 'unknown' : executionAge(source, location.jobId, entry.requestedSeq, entry.seq, end.ts);
      if (end?.ts === entry.detail.exit?.endTime && typeof age === 'number' && age < jobRetentionCutoff(runtime))
        return true;
    }
    const fd = runtime.storage.openSync(entry.resultPath, 'r');
    try {
      const file = runtime.storage.fstatSync(fd, { bigint: true });
      if (!file.isFile() || file.size === 0n) return false;
      runtime.storage.fdatasyncSync(fd);
      const directory = dirname(entry.resultPath);
      return (
        runtime.storage.syncDirectoryDurableSync(directory) &&
        runtime.storage.syncDirectoryDurableSync(dirname(directory))
      );
    } finally {
      runtime.storage.closeSync(fd);
    }
  });
}
