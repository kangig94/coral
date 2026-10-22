import { currentCoralStoreFormat } from '#src/store-format.js';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { JobLocationIndex, storedJobDetailSchema } from '#src/jobs/location-index.js';
import type { JobDetailResponse, JobStatus, JobTerminal } from '#src/jobs/records.js';
import { jobTerminalSchema, jobExecutionOutcomeAcceptedBodySchema } from '#src/jobs/terminal/result.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { buildReleasedStorageReader } from '#tests/helpers/released-storage-reader.js';
import { retainedExecutionsFixture } from '#tests/helpers/retained-executions.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

type ShippedReader = {
  JobLocationIndex: typeof JobLocationIndex;
  jobTerminalSchema: z.ZodType<JobTerminal>;
  WaitCoordinator: new (deps: unknown) => { waitForJobTerminal(jobId: string, timeout?: number): Promise<void> };
};

async function shippedReader(root: string): Promise<ShippedReader> {
  const outfile = join(root, 'v0.10.21-storage.mjs');
  await buildReleasedStorageReader(
    'v0.10.21',
    outfile,
    [
      'export {JobLocationIndex} from "#src/jobs/location-index.js";',
      'export {jobTerminalSchema} from "#src/jobs/terminal/result.js";',
      'export {WaitCoordinator} from "#src/jobs/shell/wait.js";',
    ].join('\n'),
  );
  return (await import(pathToFileURL(outfile).href)) as ShippedReader;
}

function oldDetail(jobId: string): JobDetailResponse {
  const terminal: JobTerminal = {
    content: 'old failure',
    outcome: { kind: 'failed', causeRef: { stream: { kind: 'session', id: 'old-session' }, seq: 1 } },
    durationMs: 20,
  };
  const ts = '2026-10-22T00:00:00.000Z';
  return {
    status: {
      jobId,
      execution: null,
      owner: { kind: 'provider-session', id: 'old-session' },
      sessionId: 'old-session',
      provider: 'codex',
      projectRoot: '/workspace',
      workDir: fixtureCanonicalWorkDir('/workspace'),
      backendNamespace: 'old',
      jobKind: 'provider',
      phase: 'error',
      updatedAt: ts,
      lastSeq: 2,
      result: terminal,
    },
    events: [{ jobId, ...{ sessionId: 'old-session' }, type: 'terminal', seq: 2, ts, result: terminal }],
    exit: { ...terminal, diagnostics: { progressFaults: [], usage: { inputTokens: 1 } }, endTime: ts },
    readiness: 'error',
  };
}

describe('durable terminal and location compatibility with shipped v0.10.21', () => {
  it('reads old session causes and new terminals through both strict terminal decoders while fresh appends reject session causes', async () => {
    const f = retainedExecutionsFixture(roots);
    const old = await shippedReader(f.root);
    const historic = oldDetail('old').exit!;
    const terminals = [
      { content: historic.content, outcome: historic.outcome, durationMs: historic.durationMs },
      { content: 'new result', outcome: { kind: 'completed' }, durationMs: 10 },
      {
        content: 'new failure',
        outcome: { kind: 'failed', causeRef: { stream: { kind: 'job', id: f.jobId }, seq: 3 } },
        durationMs: 11,
      },
    ];
    for (const terminal of terminals) {
      expect(old.jobTerminalSchema.parse(jobTerminalSchema.parse(terminal))).toEqual(terminal);
      expect(jobTerminalSchema.parse(old.jobTerminalSchema.parse(terminal))).toEqual(terminal);
      expect(jobTerminalSchema.safeParse({ ...terminal, execution: 1 }).success).toBe(false);
      expect(old.jobTerminalSchema.safeParse({ ...terminal, execution: 1 }).success).toBe(false);
    }
    expect(jobExecutionOutcomeAcceptedBodySchema.safeParse({ execution: 1, terminal: terminals[0] }).success).toBe(
      false,
    );
  });

  it('preserves new complete executions and unknown additive fields through the old decoder and compactor', async () => {
    const f = retainedExecutionsFixture(roots);
    const old = await shippedReader(f.root);
    expect(
      seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        f.fingerprint,
        f.jobsRoot,
        f.runtime.storage,
        [],
        true,
      ).kind,
    ).toBe('complete');
    const path = join(
      f.runtime.paths.coral.generation.dataRoot,
      'job-locations.v1',
      'jobs',
      `${Buffer.from(f.jobId).toString('base64url')}.json`,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.future = { keep: 'root' };
    raw.executions[0].future = { keep: 'execution' };
    raw.executions[0].detail.exit.diagnostics.future = { keep: 'diagnostics' };
    raw.detail.events.unshift({
      type: 'progress',
      jobId: f.jobId,
      ...{ sessionId: null },
      seq: f.requests[1],
      ts: raw.detail.status.updatedAt,
      message: 'compact me',
      timing: {
        origin: 'runtime',
        originAt: raw.detail.status.updatedAt,
        emittedAt: raw.detail.status.updatedAt,
        elapsedMs: 0,
      },
    });
    writeFileSync(path, JSON.stringify(raw));
    const oldIndex = new old.JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    expect(oldIndex.read(f.jobId)?.detail).toMatchObject({
      kind: 'recorded',
      value: { status: { sessionId: null, execution: 2 }, exit: { content: 'result #2' } },
    });
    await oldIndex.compactTerminalRecords('', { canContinue: () => true, record: () => {} }, (write) => write());
    const rewritten = JSON.parse(readFileSync(path, 'utf8'));
    expect(rewritten.future).toEqual(raw.future);
    expect(rewritten.executions).toEqual(raw.executions);
    const newIndex = new JobLocationIndex(
      f.runtime,
      f.runtime.paths.coral.generation.dataRoot,
      undefined,
      currentCoralStoreFormat().fingerprint,
    );
    expect(newIndex.execution(f.jobId, 1)?.detail.exit).toMatchObject({
      content: 'result #1',
      diagnostics: { usage: { inputTokens: 100, costUsd: 0.1 }, future: { keep: 'diagnostics' } },
    });
    expect(newIndex.execution(f.jobId, 2)?.detail.exit?.outcome).toMatchObject({
      kind: 'failed',
      causeRef: { stream: { kind: 'job', id: f.jobId } },
    });
    rmSync(dirname(f.epoch.path), { recursive: true });
    expect(newIndex.execution(f.jobId, 1)?.detail.exit?.content).toBe('result #1');
    expect(newIndex.execution(f.jobId, 2)?.detail.exit?.content).toBe('result #2');
  });

  it('decodes a record written by the old writer and keeps required nullable sessionId', async () => {
    const f = retainedExecutionsFixture(roots);
    const old = await shippedReader(f.root);
    const oldIndex = new old.JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    oldIndex.register('old', f.epochKey, { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'provider' });
    const detail = oldDetail('old');
    const { execution: _execution, ...legacyStatus } = detail.status;
    oldIndex.recordTerminal(
      'old',
      { ...detail, status: legacyStatus } as JobDetailResponse,
      join(f.jobsRoot, 'old', 'result.md'),
      2,
    );
    expect(
      new JobLocationIndex(
        f.runtime,
        f.runtime.paths.coral.generation.dataRoot,
        undefined,
        currentCoralStoreFormat().fingerprint,
      ).read('old')?.detail,
    ).toMatchObject({ kind: 'recorded', value: { exit: { outcome: detail.exit!.outcome } } });
    const { sessionId: _sessionId, ...withoutSession } = detail.status;
    expect(storedJobDetailSchema.safeParse({ ...detail, status: withoutSession }).success).toBe(false);
    const path = join(
      f.runtime.paths.coral.generation.dataRoot,
      'job-locations.v1',
      'jobs',
      `${Buffer.from('old').toString('base64url')}.json`,
    );
    const malformed = JSON.parse(readFileSync(path, 'utf8'));
    delete malformed.detail.status.sessionId;
    writeFileSync(path, JSON.stringify(malformed));
    expect(oldIndex.read('old')?.detail.kind).toBe('unreadable');
  });

  it('the shipped waiter treats null as already released and never consults a provider session', async () => {
    const f = retainedExecutionsFixture(roots);
    const old = await shippedReader(f.root);
    expect(
      seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        f.fingerprint,
        f.jobsRoot,
        f.runtime.storage,
        [],
        true,
      ).kind,
    ).toBe('complete');
    const index = new old.JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    const location = index.read(f.jobId)!;
    if (location.detail.kind !== 'recorded') throw new Error('Expected shipped decoded terminal');
    const status: JobStatus = location.detail.value.status;
    const getSession = vi.fn(() => ({ activeJobId: f.jobId }));
    const deps = {
      sessionManager: { get: getSession },
      eventBus: new EventEmitter(),
      time: f.runtime.time,
      loadJobWaitDetail: () => ({
        status,
        runtime: null,
        exit: location.detail.kind === 'recorded' ? location.detail.value.exit : null,
      }),
    };
    await new old.WaitCoordinator(deps).waitForJobTerminal(f.jobId, 1000);
    expect(status.provider).toBe('codex');
    expect(status.sessionId).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
    let resolved = false;
    const heldStatus = { ...status, sessionId: 'old-session' };
    const held = new old.WaitCoordinator({
      ...deps,
      loadJobWaitDetail: () => ({
        status: heldStatus,
        runtime: null,
        exit: location.detail.kind === 'recorded' ? location.detail.value.exit : null,
      }),
    });
    const waiting = held.waitForJobTerminal(f.jobId, 1000).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(getSession).toHaveBeenCalledWith('codex', 'old-session');
    getSession.mockReturnValue({ activeJobId: 'different-job' });
    deps.eventBus.emit('session:released', { jobId: f.jobId, sessionId: 'old-session' });
    await waiting;
  });
});
