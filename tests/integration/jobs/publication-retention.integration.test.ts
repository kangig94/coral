import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTerminalExportFixture,
  TERMINAL_EXPORT_CUTOFF,
  TERMINAL_EXPORT_NOW,
} from '#tests/helpers/terminal-export.js';
import { pruneJobExports, readExportJobState } from '#src/jobs/export-retention.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
const children: ChildProcess[] = [];
let publisher: string;
let kbBundle: string;
function fixture(kind: 'provider' | 'workflow' = 'provider') {
  const f = createTerminalExportFixture(kind, true);
  fixtures.push(f);
  return f;
}

beforeAll(() => {
  fixture();
  publisher = sharedFixture('publisher');
  kbBundle = sharedFixture('kb-host');
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
    jobState: (id) => readExportJobState(f.db, f.store, id),
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
    utimesSync(f.resultPath, new Date(TERMINAL_EXPORT_CUTOFF), new Date(TERMINAL_EXPORT_CUTOFF));
    utimesSync(dirname(f.resultPath), new Date(TERMINAL_EXPORT_CUTOFF), new Date(TERMINAL_EXPORT_CUTOFF));
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
    // A retired source leaves only the retained timestamp, which chooses the label and never discharges by age.
    const restarted = new JobLocationIndex(f.runtime, f.root);
    expect(restarted.terminalEligibility(f.jobId)).toEqual({ source: 'absent', age: 'unknown' });
    f.store.configureResultExports(restarted);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('retained-away');
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
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
    const restarted = new JobLocationIndex(f.runtime, f.root, f.index.workflowReport);
    f.store.configureResultExports(restarted);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('pending');
    f.store.configureResultExports(f.index);
    const location = f.index.read(f.jobId);
    expect(location?.detail.kind).toBe('recorded');
    if (location?.detail.kind !== 'recorded') throw new Error('missing retained detail');
    expect(location.detail.value.status.phase).toBe('completed');
    expect(location.detail.value.exit?.diagnostics.warnings).toBeUndefined();
    expect(location.detail.value.exit?.diagnostics.usage).toEqual(expected);
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
});
