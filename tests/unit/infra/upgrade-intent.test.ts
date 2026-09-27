import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '#src/infra/backend-log.js';

import {
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  retryUpgradeIntentCas,
  revalidateUpgradeIntentTarget,
  visibleUpgradeIntent,
  type UpgradeIntentChange,
} from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';

const build = {
  version: '0.11.0',
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

function pendingIntent(requestId: string): UpgradeIntentChange {
  return {
    requestId,
    incumbent: {
      instanceId: 'incumbent',
      pid: 100,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod',
    },
    target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
    attemptId: null,
    attemptOwner: null,
    disposition: 'pending',
    blockers: [],
    retryCondition: { kind: 'obligation-change', evidence: 'job-1' },
    attemptDeadline: null,
    completionReceipt: null,
  };
}

describe('upgrade intent', () => {
  const directories: string[] = [];

  function runDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'coral-upgrade-intent-'));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('allows exactly one writer from a revision and retains the losing request on retry', async () => {
    const dir = runDir();
    const initial = await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    expect(initial.kind).toBe('written');

    const contenderA = { ...pendingIntent('first'), blockers: [{ owner: 'jobs', reason: 'job-1' }] };
    const contenderB = { ...pendingIntent('second'), blockers: [{ owner: 'hosts', reason: 'host-1' }] };
    const [a, b] = await Promise.all([
      compareAndSwapUpgradeIntent(dir, 0, contenderA),
      compareAndSwapUpgradeIntent(dir, 0, contenderB),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['conflict', 'written']);

    const loser = a.kind === 'conflict' ? contenderA : contenderB;
    const latest = readUpgradeIntent(dir);
    expect(latest.kind).toBe('readable');
    if (latest.kind !== 'readable') throw new Error('intent not readable');
    const retried = await compareAndSwapUpgradeIntent(dir, latest.intent.revision, loser);
    expect(retried).toMatchObject({ kind: 'written', intent: { requestId: loser.requestId, revision: 2 } });
  });

  it('keeps the request start time across status changes and exposes the automatic retry condition', async () => {
    const dir = runDir();
    const initial = await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    if (initial.kind !== 'written') throw new Error('intent not written');
    const deferred = await compareAndSwapUpgradeIntent(dir, initial.intent.revision, {
      ...pendingIntent('first'),
      disposition: 'deferred',
      blockers: [{ owner: 'legacy-incumbent', reason: 'incumbent still serving' }],
      retryCondition: { kind: 'incumbent-retirement', evidence: 'legacy idle exit' },
    });
    if (deferred.kind !== 'written') throw new Error('deferred intent not written');
    expect(deferred.intent.requestedAt).toBe(initial.intent.requestedAt);
    expect(visibleUpgradeIntent(deferred.intent)).toMatchObject({
      disposition: 'deferred',
      since: initial.intent.requestedAt,
      reason: 'legacy idle exit',
      blockers: [{ owner: 'legacy-incumbent', reason: 'incumbent still serving' }],
      retryCondition: { kind: 'incumbent-retirement' },
    });
    expect(
      visibleUpgradeIntent({ ...deferred.intent, disposition: 'pending', successionPreparation: { stage: 'prepared' } })
        ?.phase,
    ).toBe('prepared');
  });

  it('shows a waiter-owned attempt as launching and an incumbent-owned attempt as committing', async () => {
    const dir = runDir();
    const seeded = await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent('first'),
      disposition: 'attempting',
      attemptId: 'attempt-1',
      attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: 100, incarnation: null },
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    expect(visibleUpgradeIntent(seeded.intent)?.phase).toBe('launching');
    expect(
      visibleUpgradeIntent({
        ...seeded.intent,
        attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: 100, incarnation: null },
      })?.phase,
    ).toBe('committing');
  });

  it('emits one audit event for each visible status change', async () => {
    const events: string[] = [];
    vi.spyOn(backendLog, 'info').mockImplementation((message) => {
      if (message.includes('upgrade_intent_status_changed')) events.push(message);
    });
    const dir = runDir();
    const initial = await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    if (initial.kind !== 'written') throw new Error('intent not written');
    const unchanged = await compareAndSwapUpgradeIntent(dir, initial.intent.revision, pendingIntent('first'));
    if (unchanged.kind !== 'written') throw new Error('intent not rewritten');
    await compareAndSwapUpgradeIntent(dir, unchanged.intent.revision, {
      ...pendingIntent('first'),
      disposition: 'deferred',
      blockers: [{ owner: 'jobs', reason: 'job-1' }],
    });
    expect(events).toHaveLength(2);
  });

  it('preserves unknown keys at every object level and refuses unknown generations', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent('first'),
      blockers: [{ owner: 'jobs', reason: 'job-1' }],
    });
    const path = upgradeIntentPath(dir);
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    stored.futureField = 'keep';
    (stored.target as Record<string, unknown>).futureTargetField = 'keep';
    ((stored.target as Record<string, unknown>).build as Record<string, unknown>).futureBuildField = 'keep';
    (stored.blockers as Record<string, unknown>[])[0].futureBlockerField = 'keep';
    writeFileSync(path, JSON.stringify(stored));

    const written = await compareAndSwapUpgradeIntent(dir, 0, {
      ...pendingIntent('second'),
      blockers: [{ owner: 'jobs', reason: 'job-1' }],
    });
    expect(written.kind).toBe('written');
    const result = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(result.futureField).toBe('keep');
    expect((result.target as Record<string, unknown>).futureTargetField).toBe('keep');
    expect(((result.target as Record<string, unknown>).build as Record<string, unknown>).futureBuildField).toBe('keep');
    expect((result.blockers as Record<string, unknown>[])[0].futureBlockerField).toBe('keep');

    writeFileSync(path, JSON.stringify({ ...result, version: 'v2' }));
    expect(readUpgradeIntent(dir)).toEqual({ kind: 'unsupported', version: 'v2' });
    await expect(compareAndSwapUpgradeIntent(dir, 1, pendingIntent('third'))).resolves.toEqual({ kind: 'unsupported' });
  });

  it('retains an unresolved blocker row written by a newer build when this build records its own blocker', async () => {
    const dir = runDir();
    const futureBlocker = {
      owner: 'future-owner',
      reason: 'future build has not discharged its custody',
      futureHoldEvidence: 'keep-this-row',
    };
    const seeded = await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent('first'),
      disposition: 'deferred',
      blockers: [futureBlocker],
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);

    const written = await compareAndSwapUpgradeIntent(dir, seeded.intent.revision, {
      ...pendingIntent('first'),
      disposition: 'deferred',
      blockers: [{ owner: 'jobs', reason: 'job-1 is still running' }],
    });

    expect(written.kind).toBe('written');
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: {
        blockers: expect.arrayContaining([futureBlocker, { owner: 'jobs', reason: 'job-1 is still running' }]),
      },
    });
    expect(JSON.parse(readFileSync(upgradeIntentPath(dir), 'utf-8'))).toMatchObject({
      blockers: expect.arrayContaining([futureBlocker]),
    });
    if (written.kind !== 'written') return;
    await expect(
      compareAndSwapUpgradeIntent(dir, written.intent.revision, {
        ...written.intent,
        attemptId: 'attempt-1',
        attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: 100, incarnation: null },
        blockers: [],
      }),
    ).resolves.toEqual({ kind: 'unsupported' });
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { blockers: expect.arrayContaining([futureBlocker]), attemptId: null },
    });
  });

  it('clears blockers owned by this build when their obligations settle', async () => {
    const dir = runDir();
    const seeded = await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent('first'),
      blockers: [{ owner: 'jobs', reason: 'job-1 is still running' }],
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    const written = await compareAndSwapUpgradeIntent(dir, seeded.intent.revision, {
      ...seeded.intent,
      blockers: [],
    });
    expect(written).toMatchObject({ kind: 'written', intent: { blockers: [] } });
  });

  it('retains a newer blocker shape even when its owner name is familiar', async () => {
    const dir = runDir();
    const futureBlocker = { owner: 'jobs', reason: 'new custody rule', futureHoldEvidence: 'pending' };
    const seeded = await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent('first'),
      blockers: [futureBlocker],
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    const written = await compareAndSwapUpgradeIntent(dir, seeded.intent.revision, {
      ...seeded.intent,
      blockers: [],
    });
    expect(written).toMatchObject({ kind: 'written', intent: { blockers: [futureBlocker] } });
    if (written.kind !== 'written') return;
    await expect(
      compareAndSwapUpgradeIntent(dir, written.intent.revision, {
        ...written.intent,
        attemptId: 'attempt-1',
        attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: 100, incarnation: null },
      }),
    ).resolves.toEqual({ kind: 'unsupported' });
  });

  it('should read a retry record of a newer shape as absent instead of refusing the intent', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    const path = upgradeIntentPath(dir);
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    stored.transientRetry = { targetKey: 'target', failures: 'many', retryAfter: 'later' };
    writeFileSync(path, JSON.stringify(stored));

    const read = readUpgradeIntent(dir);
    expect(read.kind).toBe('readable');
    if (read.kind !== 'readable') return;
    expect(read.intent.transientRetry).toBeUndefined();
  });

  it.each([
    ['disposition', (stored: Record<string, unknown>) => ({ ...stored, disposition: 'handing-over' })],
    [
      'retry condition',
      (stored: Record<string, unknown>) => ({ ...stored, retryCondition: { kind: 'host-release', evidence: 'x' } }),
    ],
    [
      'attempt owner',
      (stored: Record<string, unknown>) => ({
        ...stored,
        attemptId: 'attempt-1',
        attemptOwner: { kind: 'supervisor', instanceId: 'supervisor', pid: 100, incarnation: null },
      }),
    ],
    ['recovery retry', (stored: Record<string, unknown>) => ({ ...stored, recoveryRetry: { kind: 'future-kind' } })],
  ])(
    'should read an intent whose %s comes from a newer vocabulary as a newer build’s, and never overwrite it',
    async (_field, newer) => {
      const dir = runDir();
      await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
      const path = upgradeIntentPath(dir);
      const written = JSON.stringify(newer(JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>));
      writeFileSync(path, written);

      expect(readUpgradeIntent(dir)).toEqual({ kind: 'unsupported', version: 'v1' });
      await expect(compareAndSwapUpgradeIntent(dir, 0, pendingIntent('second'))).resolves.toEqual({
        kind: 'unsupported',
      });
      expect(readFileSync(path, 'utf-8')).toBe(written);
    },
  );

  it('should keep reading a record that breaks this build’s own invariants as corrupt', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    const path = upgradeIntentPath(dir);
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stored, disposition: 'completed' }));

    expect(readUpgradeIntent(dir)).toEqual({ kind: 'corrupt' });
  });

  it('does not treat a stored plugin-root label as a validated launch target', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    const observed = readUpgradeIntent(dir);
    expect(observed.kind).toBe('readable');
    if (observed.kind !== 'readable') throw new Error('intent not readable');
    expect(revalidateUpgradeIntentTarget(observed.intent).kind).toBe('invalid');
  });

  it('remains pending after a successor spawn without a serving receipt', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    const spawned = {
      ...pendingIntent('first'),
      attemptId: 'attempt-1',
      attemptOwner: { kind: 'incumbent' as const, instanceId: 'incumbent', pid: 100, incarnation: null },
      disposition: 'attempting' as const,
      attemptDeadline: '2026-09-25T01:00:00.000Z',
    };
    await compareAndSwapUpgradeIntent(dir, 0, spawned);

    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'attempting', attemptId: 'attempt-1', completionReceipt: null },
    });
    await expect(compareAndSwapUpgradeIntent(dir, 1, { ...spawned, disposition: 'completed' })).rejects.toThrow(
      'Completion requires a serving receipt',
    );
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'attempting', completionReceipt: null },
    });

    const completed = await compareAndSwapUpgradeIntent(dir, 1, {
      ...spawned,
      disposition: 'completed',
      completionReceipt: {
        kind: 'serving',
        attemptId: 'attempt-1',
        successor: { instanceId: 'successor', pid: 200, incarnation: null, build },
        epochKey: 'epoch-1:lineage-1',
        controlGeneration: 2,
        acceptedObligations: [{ owner: 'jobs', receiptId: 'job-1', controlGeneration: 2 }],
        recordedAt: '2026-09-25T00:59:00.000Z',
      },
    });
    expect(completed).toMatchObject({ kind: 'written', intent: { disposition: 'completed', revision: 2 } });
  });

  it('should decide again from the winning revision after losing a write race', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    const decided: number[] = [];
    const outcome = await retryUpgradeIntentCas(dir, async (observed) => {
      if (observed.kind !== 'readable') throw new Error('intent not readable');
      decided.push(observed.intent.revision);
      if (decided.length === 1) {
        await compareAndSwapUpgradeIntent(dir, observed.intent.revision, pendingIntent('winner'));
      }
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: { ...observed.intent, blockers: [{ owner: 'jobs', reason: 'loser' }] },
        settle: (written) => written.requestId,
      };
    });
    expect(decided).toEqual([0, 1]);
    expect(outcome).toEqual({ kind: 'settled', value: 'winner' });
  });

  it('should refuse instead of overwriting a record this build cannot decode', async () => {
    const dir = runDir();
    writeFileSync(upgradeIntentPath(dir), '{not json');
    const outcome = await retryUpgradeIntentCas(dir, () => ({
      kind: 'write',
      expectedRevision: null,
      change: pendingIntent('first'),
      settle: () => 'written',
    }));
    expect(outcome).toEqual({ kind: 'refused', problem: 'corrupt' });
    expect(readFileSync(upgradeIntentPath(dir), 'utf-8')).toBe('{not json');
  });

  it('should report exhaustion when every write loses its revision race', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent('first'));
    let decisions = 0;
    const outcome = await retryUpgradeIntentCas(dir, async (observed) => {
      if (observed.kind !== 'readable') throw new Error('intent not readable');
      decisions++;
      await compareAndSwapUpgradeIntent(dir, observed.intent.revision, pendingIntent(`winner-${decisions}`));
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: pendingIntent('loser'),
        settle: () => 'written',
      };
    });
    expect(outcome).toEqual({ kind: 'exhausted' });
    expect(decisions).toBeGreaterThan(1);
  });
});
