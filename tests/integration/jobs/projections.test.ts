import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commit, type CommitEventsFn } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { EventsRow } from '#src/store/schema.js';
import type { Database } from '#src/store/db.js';
import { hashToken } from '#src/infra/hash.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { jobPhaseSchema } from '#src/jobs/phase.js';
import { readProjectionJobRow, decodeProjectionJobStoredRow } from '#src/jobs/projection-row.js';
import {
  listJobProjections,
  loadJobProjectionDetail,
  loadJobProjectionDetails,
  loadJobWaitDetail,
  readJobEvents,
} from '#src/jobs/read-queries.js';
import { hydrateJobRecoveryProjection } from '#src/jobs/store.js';
import {
  appendJobExecutionOutcomeAccepted,
  appendJobExecutionEnded,
  failedTerminalOutcome,
} from '#src/jobs/terminal/recording.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import {
  EXECUTION_JOB_ID as jobId,
  OTHER_EXECUTION_JOB_ID as otherJobId,
  EXECUTION_NOW as now,
  executionInput as input,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';

const databases = new Set<Database>();
const directories: string[] = [];
const schema = readFileSync(new URL('../../../src/store/schema.sql', import.meta.url), 'utf8');

function harness(path = ':memory:') {
  const db = newRawDatabase(path);
  databases.add(db);
  db.exec(schema);
  const reducers = composeReducers(jobsRegistry);
  const bodyCodec = createEventBodyCodec();
  let timestamp = now;
  const ctx = { now: () => new Date(timestamp), reducers, bodyCodec, providers: permissiveProviderLookupPort };
  const readCtx = { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec };
  const commitEvents: CommitEventsFn = (cb) => commit(db, cb, ctx);
  return {
    db,
    reducers,
    bodyCodec,
    readCtx,
    commit: commitEvents,
    at: (value: string) => {
      timestamp = value;
    },
    append: (...events: CoralEventInput[]) =>
      commitEvents((c) => {
        for (const event of events) c.append(event as Parameters<typeof c.append>[0]);
        return undefined;
      }),
    row: () => {
      const row = readProjectionJobRow(db, jobId);
      if (row === null) throw new Error('Missing job projection.');
      return row;
    },
    events: () => db.prepare<[], EventsRow>('SELECT * FROM events ORDER BY seq').all(),
    close: () => {
      db.close();
      databases.delete(db);
    },
  };
}

function start(h: ReturnType<typeof harness>, execution: number) {
  h.append(
    input('job.execution.started', {
      execution,
      transport: 'durable-cli',
      pid: execution,
      stdoutPath: `/stdout-${execution}`,
      stderrPath: `/stderr-${execution}`,
      startedAt: now,
    }),
  );
}

function accept(h: ReturnType<typeof harness>, execution: number) {
  h.commit((c) => {
    appendJobExecutionOutcomeAccepted(c, {
      jobId,
      execution,
      terminal: { content: `result #${execution}`, durationMs: execution, outcome: { kind: 'completed' } },
      diagnostics: { warnings: [`warning #${execution}`], usage: { outputTokens: execution } },
    });
    return undefined;
  });
}

function end(h: ReturnType<typeof harness>, execution: number) {
  const accepted = h
    .events()
    .filter((event) => event.type === 'job.execution.outcome.accepted')
    .at(-1);
  if (accepted === undefined) throw new Error('Missing accepted outcome.');
  h.commit((c) => {
    appendJobExecutionEnded(c, {
      jobId,
      execution,
      causeRef: { stream: { kind: 'job', id: jobId }, seq: accepted.seq },
    });
    return undefined;
  });
}

function recovery(h: ReturnType<typeof harness>) {
  return hydrateJobRecoveryProjection(
    { projection: h.row(), events: h.events().filter((row) => row.stream_id === jobId) },
    h.readCtx,
  );
}

function allDetails(h: ReturnType<typeof harness>) {
  return [
    loadJobProjectionDetail(h.db, jobId, h.readCtx),
    loadJobProjectionDetails(h.db, [jobId, otherJobId, jobId], h.readCtx).get(jobId)!,
    loadJobWaitDetail(h.db, jobId, h.readCtx),
    recovery(h),
  ];
}

afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('latest execution job projection', () => {
  it('folds conversation columns and removes the independent session and replacement schema', () => {
    const h = harness();
    const columns = h.db
      .prepare<[], { name: string }>('PRAGMA table_info(projection_jobs)')
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'controller',
        'resumable',
        'conversation_ref',
        'scope_key',
        'facet',
        'execution',
        'finishing',
      ]),
    );
    for (const column of ['session_id', 'workflow_slot_generation', 'replaces_workflow_job_id'])
      expect(columns).not.toContain(column);
    expect(
      h.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('projection_sessions', 'projection_jobs_session', 'projection_jobs_workflow_slot_generation')",
        )
        .all(),
    ).toEqual([]);
    h.append(openedJob());
    expect(h.row()).toMatchObject({
      execution: null,
      controller: 'default',
      resumable: 0,
      conversation_ref: null,
      scope_key: hashToken('/workspace', 12),
      phase: 'launching',
    });
    expect(JSON.parse(h.row().facet!)).toEqual(expect.objectContaining({ provider: 'codex', name: 'execution-order' }));
  });

  it('projects opened → #1 → ended → #2 → ended, resetting only execution state', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    start(h, 1);
    h.append(
      input('job.continuity.checkpointed', {
        execution: 1,
        snapshot: { conversationRef: 'conversation', resumable: true, providerContinuity: null },
      }),
      input('job.execution.progress', { execution: 1, kind: 'missing_launch_record' }),
    );
    accept(h, 1);
    expect(h.row()).toMatchObject({ execution: 1, phase: 'running', terminal: null, finishing: 1 });
    for (const detail of allDetails(h)) {
      expect(detail).toMatchObject({
        finishing: true,
        status: { execution: 1, phase: 'running', finishing: true },
        exit: null,
      });
      expect(detail.status?.result).toBeUndefined();
    }
    expect(listJobProjections(h.db, h.readCtx)[0]?.status.finishing).toBe(true);
    end(h, 1);
    expect(h.row()).toMatchObject({ execution: 1, phase: 'completed', finishing: 0 });
    expect(loadJobWaitDetail(h.db, jobId, h.readCtx).exit).toMatchObject({
      content: 'result #1',
      diagnostics: { progressFaults: [{ kind: 'missing_launch_record' }], usage: { outputTokens: 1 } },
    });
    const facet = h.row().facet;
    h.append(requestedExecution(2, { backendNamespace: 'new-build' }));
    expect(h.row()).toMatchObject({
      execution: 2,
      phase: 'launching',
      terminal: null,
      diagnostics: '{"progressFaults":[]}',
      finishing: 0,
      facet,
      resumable: 1,
      conversation_ref: 'conversation',
      backend_namespace: 'new-build',
    });
    for (const detail of allDetails(h))
      expect(detail).toMatchObject({ status: { execution: 2, phase: 'launching' }, runtime: null, exit: null });
    start(h, 2);
    accept(h, 2);
    end(h, 2);
    for (const detail of allDetails(h)) {
      expect(detail).toMatchObject({
        finishing: false,
        status: { execution: 2, phase: 'completed' },
        runtime: { pid: 2 },
        exit: {
          content: 'result #2',
          diagnostics: { progressFaults: [], warnings: ['warning #2'], usage: { outputTokens: 2 } },
        },
      });
    }
    expect(
      readJobEvents(h.db, jobId, h.readCtx, true).map((event) =>
        event.type === 'terminal' ? event.result.content : '',
      ),
    ).toEqual(['result #1', 'result #2']);
    expect(jobPhaseSchema.options).toEqual(['queued', 'launching', 'running', 'completed', 'error', 'aborted']);
  });

  it.each(['launching', 'queued', 'running'] as const)(
    'keeps %s phase while accepting an abort until ended',
    (phase) => {
      const h = harness();
      h.append(openedJob(), requestedExecution());
      if (phase === 'queued')
        h.append(input('job.execution.queued', { execution: 1, queuePosition: 1, runningJobIds: [] }));
      if (phase === 'running') start(h, 1);
      h.append(input('job.execution.aborted', { execution: 1, reason: 'user_abort' }));
      h.commit((c) => {
        appendJobExecutionOutcomeAccepted(c, {
          jobId,
          execution: 1,
          terminal: { content: '', durationMs: 0, outcome: { kind: 'aborted', reason: 'user_abort' } },
        });
        return undefined;
      });
      expect(h.row()).toMatchObject({ phase, finishing: 1, terminal: null });
      end(h, 1);
      expect(h.row()).toMatchObject({ phase: 'aborted', finishing: 0 });
    },
  );

  it('rebuilds each boundary from the journal to exactly the live row', () => {
    const h = harness();
    const rebuild = () => {
      const before = h.row();
      rebuildProjections({
        db: h.db,
        cutoffSeq: before.last_seq,
        reducers: h.reducers,
        bodyCodec: h.bodyCodec,
        batchSize: 1,
      });
      expect(h.row()).toEqual(before);
    };
    h.append(openedJob());
    rebuild();
    for (const execution of [1, 2]) {
      h.append(requestedExecution(execution));
      rebuild();
      h.append(input('job.execution.queued', { execution, queuePosition: 1, runningJobIds: [] }));
      rebuild();
      h.append(input('job.execution.admitted', { execution }));
      rebuild();
      start(h, execution);
      rebuild();
      accept(h, execution);
      rebuild();
      end(h, execution);
      rebuild();
    }
  });

  it.each(['requested', 'queued'] as const)(
    'reloads #2 %s after #1 ended without inheriting its runtime, rejection or end',
    (state) => {
      const directory = mkdtempSync(join(tmpdir(), 'coral-projection-reload-'));
      directories.push(directory);
      const path = join(directory, 'store.db');
      const first = harness(path);
      first.append(openedJob(), requestedExecution());
      start(first, 1);
      first.commit((c) => {
        const fault = c.append(
          input('job.provider_failed', {
            execution: 1,
            provider: 'codex',
            reason: 'request_failed',
            message: 'old rejection',
          }),
        );
        const accepted = appendJobExecutionOutcomeAccepted(c, {
          jobId,
          execution: 1,
          terminal: { content: 'old result', durationMs: 1, outcome: failedTerminalOutcome(fault) },
          diagnostics: { warnings: ['old warning'] },
        });
        appendJobExecutionEnded(c, { jobId, execution: 1, causeRef: accepted });
        return undefined;
      });
      const requestedAt = '2026-10-22T01:00:00.000Z';
      first.at(requestedAt);
      first.append(requestedExecution(2, { input: 'new input', createdAt: requestedAt }));
      if (state === 'queued')
        first.append(input('job.execution.queued', { execution: 2, queuePosition: 2, runningJobIds: [] }));
      const before = first.row();
      first.close();
      const loaded = harness(path);
      expect(loaded.row()).toEqual(before);
      for (const detail of allDetails(loaded)) {
        expect(detail).toMatchObject({
          finishing: false,
          status: { execution: 2, phase: state === 'queued' ? 'queued' : 'launching', updatedAt: requestedAt },
          runtime: null,
          exit: null,
        });
        expect(detail.status?.result).toBeUndefined();
      }
      expect(loadJobProjectionDetail(loaded.db, jobId, loaded.readCtx).launch).toMatchObject({
        request: { prompt: 'new input' },
        providerAction: 'resume',
      });
      expect(JSON.parse(loaded.row().diagnostics)).toEqual({ progressFaults: [] });
      expect(loadJobProjectionDetails(loaded.db, [otherJobId], loaded.readCtx).get(otherJobId)).toMatchObject({
        status: null,
        runtime: null,
        exit: null,
      });
    },
  );

  it('ends a rejected #2 without borrowing the started runtime of #1', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    start(h, 1);
    accept(h, 1);
    end(h, 1);
    h.append(requestedExecution(2));
    h.commit((c) => {
      const fault = c.append(
        input('job.provider_failed', {
          execution: 2,
          provider: 'codex',
          reason: 'request_failed',
          message: 'activation refused',
        }),
      );
      appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution: 2,
        terminal: { content: '', durationMs: 0, outcome: failedTerminalOutcome(fault) },
      });
      return undefined;
    });
    for (const detail of allDetails(h))
      expect(detail).toMatchObject({
        finishing: true,
        status: { execution: 2, phase: 'launching' },
        runtime: null,
        exit: null,
      });
    end(h, 2);
    for (const detail of allDetails(h))
      expect(detail).toMatchObject({
        finishing: false,
        status: { execution: 2, phase: 'error' },
        runtime: null,
        exit: { content: '', outcome: { kind: 'failed' } },
      });
  });

  it('scopes batched reads independently for jobs at different execution ordinals', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    accept(h, 1);
    end(h, 1);
    h.append(requestedExecution(2));
    const other = openedJob();
    other.stream.id = otherJobId;
    other.body.owner = { kind: 'provider-session', id: otherJobId };
    const request = requestedExecution();
    request.stream.id = otherJobId;
    h.append(
      other,
      request,
      input(
        'job.execution.started',
        {
          execution: 1,
          transport: 'durable-cli',
          pid: 99,
          stdoutPath: '/other-out',
          stderrPath: '/other-err',
          startedAt: now,
        },
        otherJobId,
      ),
    );
    const details = loadJobProjectionDetails(h.db, [jobId, otherJobId], h.readCtx);
    expect(details.get(jobId)).toMatchObject({ status: { execution: 2 }, runtime: null, exit: null });
    expect(details.get(otherJobId)).toMatchObject({ status: { execution: 1 }, runtime: { pid: 99 }, exit: null });
  });

  it('rejects corrupt authority and finishing rows at the persisted boundary', () => {
    const h = harness();
    h.append(openedJob(), requestedExecution());
    expect(() =>
      decodeProjectionJobStoredRow({
        ...h.row(),
        execution_owner: JSON.stringify({ kind: 'provider-session', id: otherJobId }),
      }),
    ).toThrow();
    expect(() => decodeProjectionJobStoredRow({ ...h.row(), facet: '{}' })).toThrow();
    accept(h, 1);
    end(h, 1);
    expect(() => decodeProjectionJobStoredRow({ ...h.row(), finishing: 1 })).toThrow();
  });
});
