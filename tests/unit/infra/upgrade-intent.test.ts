import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareAndSwapUpgradeIntent,
  quarantineCorruptUpgradeIntent,
  readUpgradeIntent,
  retryUpgradeIntentCas,
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

  it('durably quarantines corrupt bytes and permits a fresh recorded request', async () => {
    const dir = runDir();
    writeFileSync(upgradeIntentPath(dir), '{broken');
    expect(readUpgradeIntent(dir).kind).toBe('corrupt');
    expect(await quarantineCorruptUpgradeIntent(dir)).toBe('quarantined');
    expect(readUpgradeIntent(dir).kind).toBe('absent');
    const quarantined = readdirSync(dir).find((name) => name.startsWith('upgrade.v1.corrupt-'));
    expect(quarantined).toBeDefined();
    expect(readFileSync(join(dir, quarantined!), 'utf8')).toBe('{broken');
    expect((await compareAndSwapUpgradeIntent(dir, null, pendingIntent('new-request'))).kind).toBe('written');
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
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: {
        futureField: 'keep',
        target: { futureTargetField: 'keep', build: { futureBuildField: 'keep' } },
        blockers: [{ futureBlockerField: 'keep' }],
      },
    });

    writeFileSync(path, JSON.stringify({ ...result, version: 'v2' }));
    expect(readUpgradeIntent(dir)).toEqual({ kind: 'unsupported', version: 'v2' });
    await expect(compareAndSwapUpgradeIntent(dir, 1, pendingIntent('third'))).resolves.toEqual({ kind: 'unsupported' });
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
