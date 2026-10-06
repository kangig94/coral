import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTerminalExportFixture,
  TERMINAL_EXPORT_CUTOFF,
  TERMINAL_EXPORT_NOW,
} from '#tests/helpers/terminal-export.js';
import { pruneJobExports } from '#src/jobs/export-retention.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { JobLocation } from '#src/jobs/location-index.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
const children: ChildProcess[] = [];
let publisher: string;
let kbBundle: string;
const releasedReaders = new Map<
  string,
  {
    JobLocationIndex: new (...args: ConstructorParameters<typeof JobLocationIndex>) => {
      read(id: string): JobLocation | null;
    };
  }
>();
function fixture(kind: 'provider' | 'workflow' = 'provider') {
  const f = createTerminalExportFixture(kind, true);
  fixtures.push(f);
  return f;
}

beforeAll(() => {
  fixture();
  publisher = sharedFixture('publisher');
  kbBundle = sharedFixture('kb-host');
  for (const version of ['v0.10.16', 'v0.10.17', 'v0.10.18'])
    releasedReaders.set(version, createRequire(import.meta.url)(sharedFixture(version)));
});

afterAll(() => {
  for (const f of fixtures.splice(0)) f.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((done) => child.once('exit', () => done()));
    }
  for (const f of fixtures.splice(1)) f.close();
});

async function prune(f: ReturnType<typeof fixture>) {
  await pruneJobExports({
    db: f.db,
    runtime: f.runtime,
    cutoff: Number(readFileSync(join(f.root, 'clock'), 'utf8')) - 14 * 86_400_000,
    afterId: '',
    budget: { canContinue: () => true, record: () => {} },
    jobState: () => ({ kind: 'absent' }),
    eligibility: (id) => f.index.terminalEligibility(id),
    resultHold: () => 'released',
    mutate: (operation) => operation(),
  });
}
function message(child: ChildProcess, kind: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    child.on('message', (value) => {
      if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === kind) resolveMessage();
    });
    // 'close' follows the IPC channel's close, so every message the publisher sent has been delivered by then.
    child.once('close', (code) => reject(new Error(`publisher exited ${code} before ${kind}`)));
  });
}

describe('publication and retention under Revision S1', () => {
  it.each(['coordinator', 'kb'] as const)(
    'rechecks expiry across a paused %s publisher and another process retention',
    async (origin) => {
      const f = fixture();
      f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF });
      writeFileSync(join(f.root, 'clock'), String(TERMINAL_EXPORT_NOW));
      const child = fork(publisher, [f.root, f.epochKey, 'pre-stage', origin, kbBundle], {
        env: { PATH: process.env.PATH, HOME: join(f.root, 'isolated-home'), LANG: 'C.UTF-8', TMPDIR: '/tmp' },
        stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      await message(child, 'paused');
      f.advance(1);
      writeFileSync(join(f.root, 'clock'), String(TERMINAL_EXPORT_NOW + 1));
      await prune(f);
      const done = message(child, 'done');
      child.stdin?.write('r');
      await done;
      expect(existsSync(f.resultPath)).toBe(false);
      expect(f.index.resultDurable(f.jobId)).toBe(true);
    },
  );

  it('discards a staged attempt across the cutoff and releases its source guard', async () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF });
    writeFileSync(join(f.root, 'clock'), String(TERMINAL_EXPORT_NOW));
    const child = fork(publisher, [f.root, f.epochKey, 'staged', 'coordinator', kbBundle], {
      env: { PATH: process.env.PATH, HOME: join(f.root, 'isolated-home'), LANG: 'C.UTF-8', TMPDIR: '/tmp' },
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    await message(child, 'paused');
    f.advance(1);
    writeFileSync(join(f.root, 'clock'), String(TERMINAL_EXPORT_NOW + 1));
    const done = message(child, 'done');
    child.stdin?.write('r');
    await done;
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('pruned active results stay absent through startup repair, historical seed and source retirement', async () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF });
    f.store.publishTerminalResult(f.jobId);
    utimesSync(f.resultPath, new Date(TERMINAL_EXPORT_NOW - 1), new Date(TERMINAL_EXPORT_NOW - 1));
    utimesSync(dirname(f.resultPath), new Date(TERMINAL_EXPORT_NOW - 1), new Date(TERMINAL_EXPORT_NOW - 1));
    f.advance(1);
    writeFileSync(join(f.root, 'clock'), String(TERMINAL_EXPORT_NOW + 1));
    await prune(f);
    expect(existsSync(f.resultPath)).toBe(false);
    f.store.ensureResultArtifact(f.jobId);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    f.removeSource();
    const restarted = new JobLocationIndex(f.runtime, f.root);
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    expect(restarted.terminalEligibility(f.jobId).kind).toBe('expired');
  });

  it('hydrates canonical workflow outcome, diagnostics and active-policy usage despite export failure and stale projection', () => {
    const f = fixture('workflow');
    f.complete({ steps: [{ stepIndex: 0, atomIndex: 0, label: 'middle', output: 'middle output' }] });
    initTestJob(f.store, {
      jobId: 'child-1',
      sessionId: 'child-session',
      provider: 'claude',
      projectRoot: f.root,
      backendNamespace: 'fixture',
    });
    commitJobTerminal(
      f.store,
      'child-1',
      'child-session',
      { content: 'child output', outcome: { kind: 'completed' }, durationMs: 1 },
      { diagnostics: { usage: { inputTokens: 7, outputTokens: 11 } } },
    );
    f.db.prepare('UPDATE projection_jobs SET parent_workflow_job_id = ? WHERE job_id = ?').run(f.jobId, 'child-1');
    const expected = aggregateWorkflowUsage(f.db, f.jobId);
    expect(expected).toMatchObject({ inputTokens: 7, outputTokens: 11 });
    f.db
      .prepare("UPDATE projection_jobs SET phase = 'running', diagnostics = ? WHERE job_id = ?")
      .run(JSON.stringify({ progressFaults: [], warnings: ['stale projection'] }), f.jobId);
    const sourceLocation = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete sourceLocation.detail;
    delete sourceLocation.terminalAge;
    sourceLocation.disposition = 'unresolved';
    writeFileSync(f.locationPath, JSON.stringify(sourceLocation));
    const write = f.runtime.storage.writeAtomicDurableSync;
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, data, options) =>
      path === f.resultPath ? false : write(path, data, options),
    );
    expect(
      seedHistoricalEpoch(
        f.runtime,
        f.index,
        f.epoch,
        f.epochKey,
        currentCoralStoreFormat().fingerprint,
        f.runtime.paths.coral.exports.jobsRoot,
        f.runtime.storage,
      ).kind,
    ).toBe('uncertified');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'repair-failed',
      retryScheduled: true,
    });
    const restarted = new JobLocationIndex(f.runtime, f.root, f.index.workflowReport);
    f.store.configureResultExports(restarted);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    f.store.configureResultExports(f.index);
    const location = f.index.read(f.jobId);
    expect(location?.detail.kind).toBe('recorded');
    if (location?.detail.kind !== 'recorded') throw new Error('missing retained detail');
    expect(location.detail.value.status.phase).toBe('completed');
    expect(location.detail.value.exit?.diagnostics.warnings).toBeUndefined();
    expect(location.detail.value.exit?.diagnostics.usage).toEqual(expected);
    expect(location.terminalAge).toMatchObject({ kind: 'known' });
    expect(f.index.read('child-1')?.detail.kind).toBe('recorded');
    expect(existsSync(f.index.resultPathFor('child-1'))).toBe(true);
    vi.restoreAllMocks();
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toContain('middle output');
    rmSync(f.resultPath);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    expect(readFileSync(f.resultPath, 'utf8')).toContain('middle output');
  });

  it('preserves identical-timestamp known versus regressed evidence through pruning, compaction, source loss and released readers', async () => {
    const known = fixture();
    const regressed = fixture();
    known.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF - 2 });
    regressed.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    for (const f of [known, regressed]) {
      f.db.prepare('DELETE FROM events WHERE seq = 1').run();
      const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
      record.detail.events.unshift({
        type: 'progress',
        jobId: f.jobId,
        sessionId: 'session-1',
        seq: 1,
        ts: record.detail.exit.endTime,
        message: 'old',
        timing: {
          elapsedMs: 0,
          origin: 'launch',
          originAt: record.detail.exit.endTime,
          emittedAt: record.detail.exit.endTime,
        },
      });
      writeFileSync(f.locationPath, JSON.stringify(record));
      await f.index.compactTerminalRecords('', { canContinue: () => true, record: () => {} }, (operation) =>
        operation(),
      );
      expect(f.index.read(f.jobId)?.terminalAge).toEqual(record.terminalAge);
      expect(f.index.terminalEligibility(f.jobId).age).toBe(
        record.terminalAge.kind === 'known' ? record.terminalAge.terminalAt : 'regression',
      );
      for (const reader of releasedReaders.values())
        expect(new reader.JobLocationIndex(f.runtime, f.root).read(f.jobId)?.detail.kind).toBe('recorded');
      f.removeSource();
    }
    expect(new JobLocationIndex(known.runtime, known.root).resultDurable(known.jobId)).toBe(true);
    expect(new JobLocationIndex(regressed.runtime, regressed.root).resultDurable(regressed.jobId)).toBe(false);
  });
});
