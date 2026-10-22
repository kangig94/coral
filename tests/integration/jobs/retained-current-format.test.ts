import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { seedHistoricalEpoch, readHistoricalSource, refreshHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { repairRetainedExecution } from '#src/jobs/retained-current.js';
import { commit } from '#src/store/append.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { protectStoreEpoch } from '#src/store/epoch/index.js';
import { settleSupersededEpochClosures } from '#src/coordinator/services/recovery/epoch-closure.js';
import { retainedExecutionsFixture } from '#tests/helpers/retained-executions.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { executionHarness, requestedExecution, EXECUTION_NOW } from '#tests/helpers/job-executions.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function seed(f: ReturnType<typeof retainedExecutionsFixture>, certify = true) {
  return seedHistoricalEpoch(
    f.runtime,
    f.index,
    f.epoch,
    f.epochKey,
    f.fingerprint,
    f.jobsRoot,
    f.runtime.storage,
    [],
    certify,
  );
}

describe('retained current-format dispatch', () => {
  it.each(['reset', 'replacement'] as const)(
    'hydrates and repairs both executions after %s, then closes retirement',
    async (reason) => {
      const f = retainedExecutionsFixture(roots);
      const address = protectStoreEpoch(f.runtime, f.epoch);
      const replacement = join(f.epoch.storeRoot, 'epoch-2');
      mkdirSync(replacement, { recursive: true });
      writeFileSync(
        join(replacement, 'epoch.json'),
        JSON.stringify({
          supersedes: '1',
          classification: reason === 'reset' ? { kind: 'operator-discard' } : { kind: 'fresh' },
          publishedAt: EXECUTION_NOW,
          build: {
            version: '0.10.22',
            buildSetId: '10000000-0000-4000-8000-000000000098',
            bundleHash: '1123456789abcdef',
            flavor: 'prod',
            storeFormatFingerprint: f.fingerprint,
          },
        }),
      );
      newRawDatabase(join(replacement, 'store.db')).close();
      newRawDatabase(join(replacement, '.lock')).close();
      expect(seed(f)).toMatchObject({ kind: 'complete', jobIds: [f.jobId] });
      const first = f.index.execution(f.jobId, 1)!;
      const second = f.index.execution(f.jobId, 2)!;
      expect(first).toMatchObject({
        execution: 1,
        requestedSeq: f.requests[0],
        seq: f.ends[0],
        detail: { exit: { content: 'result #1', diagnostics: { usage: { inputTokens: 100, costUsd: 0.1 } } } },
      });
      expect(second.detail.exit?.outcome).toMatchObject({
        kind: 'failed',
        causeRef: { stream: { kind: 'job', id: f.jobId } },
      });
      expect(second).toMatchObject({
        execution: 2,
        requestedSeq: f.requests[1],
        seq: f.ends[1],
        detail: { exit: { content: 'result #2', diagnostics: { usage: { inputTokens: 200, costUsd: 0.2 } } } },
      });
      for (const entry of [first, second]) {
        expect(entry.resultPath).toBe(join(f.jobsRoot, f.jobId, 'executions', String(entry.execution), 'result.md'));
        expect(readFileSync(entry.resultPath, 'utf8')).toBe(`result #${entry.execution}\n`);
        rmSync(entry.resultPath);
      }
      const read = readHistoricalSource(f.index, f.epochKey, [f.jobId], {}, true);
      expect(read.kind).toBe('read');
      if (read.kind !== 'read') throw new Error('Expected current source read');
      expect(read.locations.get(f.jobId)?.executions).toHaveLength(2);
      for (const entry of [first, second]) expect(existsSync(entry.resultPath)).toBe(false);
      expect(f.index.resultsReleased(f.epochKey)).toBe(false);
      expect(refreshHistoricalEpoch(f.index, f.epochKey, [f.jobId])).toEqual({ kind: 'read' });
      expect(f.index.resultsReleased(f.epochKey)).toBe(true);
      for (const entry of [first, second])
        expect(readFileSync(entry.resultPath, 'utf8')).toBe(`result #${entry.execution}\n`);
      const closures = await settleSupersededEpochClosures(f.runtime, f.index, undefined, f.lineage);
      expect(closures).toContainEqual(
        expect.objectContaining({
          epochKey: f.lineage,
          disposition: 'closed',
          dataOutcome: 'retained',
          executionDischarge: 'certified',
        }),
      );
      expect(existsSync(address.protectedPath)).toBe(true);
    },
  );

  it('keeps accepted-but-unended execution #2 open and uncertified', () => {
    const f = retainedExecutionsFixture(roots, 1);
    const db = newRawDatabase(f.epoch.path);
    const template = executionHarness();
    try {
      commit(
        db,
        (c) => {
          c.append(requestedExecution(2));
          appendJobExecutionOutcomeAccepted(c, {
            jobId: f.jobId,
            execution: 2,
            terminal: { content: 'pending', outcome: { kind: 'completed' }, durationMs: 1 },
          });
          return undefined;
        },
        template.ctx,
      );
    } finally {
      db.close();
      template.db.close();
    }
    expect(seed(f).kind).toBe('unrecoverable-retained');
    const location = f.index.read(f.jobId)!;
    expect(location.disposition).toBe('unresolved');
    expect(location.detail).toMatchObject({
      kind: 'recorded',
      value: { status: { execution: 2, finishing: true }, exit: null },
    });
    expect(location.executions).toHaveLength(1);
    expect(f.index.resultsReleased(f.epochKey)).toBe(false);
    expect(f.index.certificate(f.epochKey)).toBeNull();
  });

  it('keeps complete execution outcomes after compaction and source removal and repairs each exact result', async () => {
    const f = retainedExecutionsFixture(roots);
    expect(seed(f).kind).toBe('complete');
    const before = f.index.read(f.jobId)!.executions!;
    await f.index.compactTerminalRecords('', { canContinue: () => true, record: () => {} }, (write) => write());
    rmSync(dirname(f.epoch.path), { recursive: true });
    const reopened = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    expect(before.every((entry) => entry.detail.events.some((event) => event.type === 'progress'))).toBe(true);
    expect(reopened.read(f.jobId)!.executions).toEqual(
      before.map((entry) => ({
        ...entry,
        detail: { ...entry.detail, events: entry.detail.events.filter((event) => event.type === 'terminal') },
      })),
    );
    for (const entry of reopened.read(f.jobId)!.executions!) {
      rmSync(entry.resultPath);
      repairRetainedExecution(f.runtime, entry, () => reopened.execution(f.jobId, entry.execution)?.seq === entry.seq);
      expect(readFileSync(entry.resultPath, 'utf8')).toBe(`result #${entry.execution}\n`);
      expect(entry.detail.exit?.diagnostics.warnings).toEqual([`warning #${entry.execution}`]);
    }
    expect(reopened.execution(f.jobId, 3)).toBeNull();
    expect(reopened.resultDurable(f.jobId, null)).toBe(true);
  });

  it('keeps the intact source clock-regression guard when repairing a current execution', () => {
    const f = retainedExecutionsFixture(roots);
    const db = newRawDatabase(f.epoch.path);
    try {
      db.prepare('UPDATE events SET ts = ? WHERE seq = ?').run('2026-08-01T00:00:00.000Z', f.ends[0]);
    } finally {
      db.close();
    }
    expect(seed(f).kind).toBe('complete');
    expect(readFileSync(f.index.execution(f.jobId, 1)!.resultPath, 'utf8')).toBe('result #1\n');
  });

  it('never decodes an unknown retained fingerprint through the current route', () => {
    const f = retainedExecutionsFixture(roots);
    f.index.register(f.jobId, f.epochKey, { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'provider' });
    const unknown = `sha256:${'0'.repeat(64)}`;
    expect(
      seedHistoricalEpoch(f.runtime, f.index, f.epoch, f.epochKey, unknown, f.jobsRoot, f.runtime.storage, [], true)
        .kind,
    ).toBe('unrecoverable-retained');
    expect(readHistoricalSource(f.index, f.epochKey, [f.jobId])).toMatchObject({
      kind: 'unreadable',
      disposition: 'settled-unreadable',
    });
    expect(f.index.resultsReleased(f.epochKey)).toBe(false);
    expect(f.index.read(f.jobId)?.detail.kind).toBe('absent');
  });
});
