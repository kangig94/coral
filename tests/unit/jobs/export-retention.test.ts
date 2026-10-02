import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneJobExports, readExportJobState, type ExportJobRetentionState } from '#src/jobs/export-retention.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture() {
  const value = createRetentionFixture();
  fixtures.push(value);
  return value;
}
function exported(f: ReturnType<typeof fixture>, id: string): string {
  const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
  mkdirSync(join(path, 'provider-artifacts'), { recursive: true });
  writeFileSync(join(path, 'result.md'), 'durable result');
  writeFileSync(join(path, 'provider-artifacts', 'original.jsonl'), 'provider session');
  return path;
}
async function prune(
  f: ReturnType<typeof fixture>,
  states: Record<string, ExportJobRetentionState>,
  holds: Record<string, 'released' | 'required' | 'unknown'> = {},
) {
  return pruneJobExports({
    runtime: f.runtime,
    cutoff: RETENTION_CUTOFF,
    afterId: '',
    budget: f.budget,
    jobState: (id) => states[id] ?? { kind: 'absent' },
    resultHold: (id) => holds[id] ?? 'released',
    mutate: (operation) => operation(),
  });
}

describe('export retention', () => {
  it('deletes the entire expired terminal export, keeping live, unknown, recent and epoch-required results', async () => {
    const f = fixture();
    for (const id of ['expired', 'live', 'unknown', 'recent', 'required', 'hold-unknown']) exported(f, id);
    await prune(
      f,
      {
        expired: { kind: 'terminal', terminalAt: RETENTION_CUTOFF - 1 },
        live: { kind: 'nonterminal' },
        unknown: { kind: 'unknown' },
        recent: { kind: 'terminal', terminalAt: RETENTION_CUTOFF },
        required: { kind: 'terminal', terminalAt: 1 },
        'hold-unknown': { kind: 'terminal', terminalAt: 1 },
      },
      { required: 'required', 'hold-unknown': 'unknown' },
    );
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'expired'))).toBe(false);
    for (const id of ['live', 'unknown', 'recent', 'required', 'hold-unknown'])
      expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, id, 'result.md'))).toBe(true);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'deleted', count: 1 }));
  });

  it('checks every descendant of unknown residue and never follows a job symlink', async () => {
    const f = fixture();
    const old = exported(f, 'old');
    const changed = exported(f, 'changed');
    for (const path of [old, changed]) {
      for (const child of ['result.md', 'provider-artifacts/original.jsonl', 'provider-artifacts', ''])
        utimesSync(join(path, child), 1, 1);
    }
    utimesSync(
      join(changed, 'provider-artifacts', 'original.jsonl'),
      new Date(RETENTION_CUTOFF),
      new Date(RETENTION_CUTOFF),
    );
    symlinkSync(changed, join(f.runtime.paths.coral.exports.jobsRoot, 'link'));
    await prune(f, {});
    expect(existsSync(old)).toBe(false);
    expect(existsSync(changed)).toBe(true);
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'link'))).toBe(true);
  });

  it('keeps interrupted work and reports deletion failure for automatic retry', async () => {
    const f = fixture();
    const path = exported(f, 'expired');
    f.budget.canContinue = () => false;
    await prune(f, { expired: { kind: 'terminal', terminalAt: 1 } });
    expect(existsSync(path)).toBe(true);
    f.budget.canContinue = () => true;
    const runtime = {
      ...f.runtime,
      storage: {
        ...f.runtime.storage,
        unlinkSync: () => {
          throw new Error('injected unlink failure');
        },
      },
    };
    await pruneJobExports({
      runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => ({ kind: 'terminal', terminalAt: 1 }),
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'failed', reason: expect.stringContaining('injected unlink') }),
    );
    await prune(f, { expired: { kind: 'terminal', terminalAt: 1 } });
    expect(existsSync(path)).toBe(false);
  });

  it('derives age from the decoded journal terminal and keeps corrupt or absent state distinct', () => {
    const f = fixture();
    f.setNow(1);
    initTestJob(f.store, {
      jobId: 'job',
      sessionId: 'session',
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test-ns',
    });
    expect(readExportJobState(f.db, f.store, 'job')).toEqual({ kind: 'nonterminal' });
    commitJobTerminal(f.store, 'job', 'session', { content: 'result', outcome: { kind: 'completed' }, durationMs: 1 });
    expect(readExportJobState(f.db, f.store, 'job')).toEqual({ kind: 'terminal', terminalAt: 1 });
    f.db.prepare("UPDATE events SET body = ? WHERE type = 'job.terminal.recorded'").run(Buffer.from('{}'));
    expect(readExportJobState(f.db, f.store, 'job')).toEqual({ kind: 'unknown' });
    expect(readExportJobState(f.db, f.store, 'residue')).toEqual({ kind: 'absent' });
  });

  it('retains the exact historical result until its epoch directory is proven absent', () => {
    const f = fixture();
    const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    const epoch = {
      storeRoot: f.runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
    };
    locations.register('job', JSON.stringify(epoch), {
      projectRoot: '/workspace',
      workDir: '/workspace',
      jobKind: 'provider',
    });
    mkdirSync(join(epoch.storeRoot, 'epoch-1'), { recursive: true });
    expect(locations.exportResultRetention('job', 'active')).toBe('required');
    f.runtime.storage.rmSync(join(epoch.storeRoot, 'epoch-1'), { recursive: true });
    expect(locations.exportResultRetention('job', 'active')).toBe('released');
    locations.register('unknown', 'bad-epoch-key', {
      projectRoot: '/workspace',
      workDir: '/workspace',
      jobKind: 'provider',
    });
    expect(locations.exportResultRetention('unknown', 'active')).toBe('unknown');
  });
});
