import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
function fixture(kind: 'provider' | 'workflow' = 'provider') {
  const f = createTerminalExportFixture(kind);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

describe('terminal export owner', () => {
  it.each(['pending', 'failed'])(
    'resumes a bounded repair scan and retries a %s eligible tail across exhausted runs',
    async (state) => {
      const f = fixture();
      f.complete();
      const owner = f.store.getResultExportOwner();
      const wakeup = vi.fn();
      owner.onRepairHint(wakeup);
      const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
      if (state === 'failed') {
        write.mockReturnValueOnce(false);
        expect(() => owner.publishTerminalResult(f.jobId)).toThrow('Failed to write result artifact');
        expect(owner.observeResultAvailability(f.jobId)).toMatchObject({ kind: 'failed', retryScheduled: true });
      }
      const observe = owner.observeResultAvailability.bind(owner);
      const visited: string[] = [];
      vi.spyOn(owner, 'observeResultAvailability').mockImplementation((jobId) => {
        visited.push(jobId);
        return jobId === f.jobId ? observe(jobId) : { kind: 'available', resultPath: '/head' };
      });
      const candidates = ['head-1', 'head-2', f.jobId];
      for (let pass = 0; pass < 3; pass++) {
        let left = 2;
        await owner.repairPass(candidates, { canContinue: () => left-- > 0, record: vi.fn() });
        if (pass === 0) {
          if (state === 'failed') expect(existsSync(f.resultPath)).toBe(true);
          else expect(visited).toEqual(['head-1', 'head-2']);
        }
      }
      expect(wakeup).not.toHaveBeenCalled();
      expect(visited).toContain(f.jobId);
      expect(write).toHaveBeenCalledTimes(state === 'failed' ? 2 : 1);
      expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
    },
  );

  it('enumerates repair identities without eagerly reading every retained location', () => {
    const f = fixture();
    const read = vi.spyOn(f.runtime.storage, 'readFileSync');
    expect([...f.index.jobIds()]).toContain(f.jobId);
    expect(read).not.toHaveBeenCalled();
  });

  it('renders a real workflow step report through deletion and repair', () => {
    const f = fixture('workflow');
    f.complete({
      steps: [
        { stepIndex: 0, atomIndex: 0, label: 'intermediate', output: 'intermediate output' },
        { stepIndex: 1, atomIndex: 0, label: 'final', output: 'final output' },
      ],
    });
    f.store.publishTerminalResult(f.jobId);
    const report = readFileSync(f.resultPath, 'utf8');
    expect(report).toContain('intermediate output');
    rmSync(f.resultPath);
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe(report);
  });

  it.each(['provider', 'workflow'] as const)('renders nonempty empty-terminal explanations for %s', (kind) => {
    const f = fixture(kind);
    f.complete({
      terminal: { content: '', outcome: { kind: 'aborted', reason: 'user_abort' }, durationMs: 0 },
      ...(kind === 'workflow' ? { steps: [] } : {}),
    });
    f.store.publishTerminalResult(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8').trim()).not.toBe('');
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('does not substitute final text when workflow facts are missing or mismatched', () => {
    const f = fixture('workflow');
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'workflow-facts-unavailable',
      retryScheduled: false,
    });
  });

  it('leaves an available workflow child file untouched without synchronization', () => {
    const f = fixture();
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    writeFileSync(f.resultPath, 'older canonical rendering');
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    const sync = vi.spyOn(f.runtime.storage, 'fdatasyncSync');
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('older canonical rendering');
    expect(write).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 1])('uses strict expiry at cutoff %+i', (offset) => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF + offset });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(offset >= 0);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe(
      offset < 0 ? 'retained-away' : 'available',
    );
    if (offset < 0) expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('publishes source-backed regression, retries after failure and requires the file for retirement', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    expect(f.index.terminalEligibility(f.jobId)).toMatchObject({ kind: 'regression', age: 'regression' });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
    expect(() => f.store.publishTerminalResult(f.jobId)).toThrow('Failed to write');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'repair-failed',
      retryScheduled: true,
      ageUncertain: true,
    });
    write.mockRestore();
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
    expect(f.index.certify(f.epochKey, 2)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    rmSync(f.resultPath);
    const restarted = new JobLocationIndex(f.runtime, f.root);
    expect(restarted.resultDurable(f.jobId)).toBe(false);
    f.store.configureResultExports(restarted);
    f.store.ensureResultArtifact(f.jobId);
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    rmSync(f.resultPath);
    f.removeSource();
    expect(restarted.resultDurable(f.jobId)).toBe(false);
    expect(restarted.terminalEligibility(f.jobId).age).toBe('regression');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      retryScheduled: false,
      ageUncertain: true,
    });
  });

  it('retries a failed inside-window attempt through a coalesced hint pass', async () => {
    const f = fixture();
    f.complete();
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
    expect(() => f.store.publishTerminalResult(f.jobId)).toThrow();
    write.mockRestore();
    const owner = f.store.getResultExportOwner();
    owner.hintRepair(f.jobId);
    owner.hintRepair(f.jobId);
    await owner.repairPass([], { canContinue: () => true, record: () => {} });
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('available');
  });

  it('supplies file-based retirement proof for a fresh source-backed regression', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    f.store.publishTerminalResult(f.jobId);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    expect(f.index.certify(f.epochKey, 2)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    rmSync(f.resultPath);
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('discards its stage if expiry crosses during fdatasync before final rename', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF });
    const sync = f.runtime.storage.writeAtomicDurableSync;
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, bytes, options) => {
      if (path === f.resultPath)
        return sync(path, bytes, {
          ...options,
          beforeRename: () => {
            f.advance(1);
            return options?.beforeRename?.() ?? true;
          },
        });
      return sync(path, bytes, options);
    });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(readdirSync(f.resultPath.slice(0, -'result.md'.length))).toEqual([]);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('keeps validated expired age after source removal and restart; no selected-source or mtime fallback', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    f.removeSource();
    const restarted = new JobLocationIndex(f.runtime, f.root);
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    f.store.configureResultExports(restarted);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('retained-away');
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.resultPath;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    delete record.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(restarted.resultDurable(f.jobId)).toBe(false);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'terminal-age-unknown',
      retryScheduled: false,
    });
  });

  it('refuses legacy age backfill from a pruned prefix and malformed or mismatched evidence', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(record));
    f.db.prepare('DELETE FROM events WHERE seq = 1').run();
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    for (const terminalAge of [
      { kind: 'known', terminalAt: TERMINAL_EXPORT_CUTOFF - 1 },
      { ...record.terminalAge, epochKey: 'other' },
    ]) {
      writeFileSync(f.locationPath, JSON.stringify({ ...record, terminalAge }));
      expect(f.index.resultDurable(f.jobId)).toBe(false);
    }
  });

  it('denies both proof branches for present inconsistent copies and missing retained outcome', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    for (const field of ['status', 'events', 'exit']) {
      const corrupt = structuredClone(record);
      if (field === 'status') corrupt.detail.status.result.content = 'stale';
      if (field === 'events') corrupt.detail.events[0].result.content = 'stale';
      if (field === 'exit') corrupt.detail.exit.durationMs += 1;
      writeFileSync(f.locationPath, JSON.stringify(corrupt));
      expect(f.index.read(f.jobId)?.detail.kind).toBe('unreadable');
      expect(f.index.resultDurable(f.jobId)).toBe(false);
    }
    delete record.detail;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('refuses disagreement on recording and validates legacy optional copies without correction', () => {
    const f = fixture();
    const seq = f.complete();
    const location = f.index.read(f.jobId);
    if (location?.detail.kind !== 'recorded') throw new Error('missing fixture detail');
    const detail = structuredClone(location.detail.value);
    if (!detail.status.result) throw new Error('missing result');
    detail.status.result.content = 'stale caller content';
    expect(() => f.index.recordTerminal(f.jobId, detail, f.resultPath, seq, f.db)).toThrow('disagrees');
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.detail.status.result;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.read(f.jobId)?.detail.kind).toBe('recorded');
    record.detail.epochKey = 'another epoch';
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.read(f.jobId)?.detail.kind).toBe('unreadable');
  });

  it('records a fresh terminal after unrelated journal pruning without discarding its own timestamp evidence', () => {
    const f = fixture();
    f.db
      .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?)')
      .run('2026-09-01T00:00:00.000Z', 'fixture.pruned', 'workflow', 'unrelated', Buffer.from('{}'));
    f.db.prepare("DELETE FROM events WHERE type = 'fixture.pruned'").run();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    f.store.publishTerminalResult(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
  });

  it('preserves age recorded by a concurrent owner before the revision lock is acquired', () => {
    const f = fixture();
    const seq = f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    const retained = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    const legacy = structuredClone(retained);
    delete legacy.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(legacy));
    f.db.prepare('DELETE FROM events WHERE seq = 1').run();
    const location = f.index.read(f.jobId);
    if (location?.detail.kind !== 'recorded') throw new Error('missing fixture terminal');
    const read = f.runtime.storage.readFileSync;
    let observations = 0;
    vi.spyOn(f.runtime.storage, 'readFileSync').mockImplementation((path, encoding) => {
      if (path === f.locationPath && ++observations === 2) writeFileSync(f.locationPath, JSON.stringify(retained));
      return read(path, encoding);
    });
    f.index.recordTerminal(f.jobId, location.detail.value, f.resultPath, seq, f.db);
    expect(f.index.terminalEligibility(f.jobId).age).toBe('regression');
  });

  it('reports an unexpired missing artifact after source retirement as failed without a retry', () => {
    const f = fixture();
    f.complete();
    f.removeSource();
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'source-epoch-retired',
      retryScheduled: false,
    });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('observation makes no write or fsync and an untrusted cutoff defers publication', () => {
    const f = fixture();
    f.complete();
    const owner = f.store.getResultExportOwner();
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    const sync = vi.spyOn(f.runtime.storage, 'fdatasyncSync');
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    expect(write).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    f.jump(86_400_000);
    expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'cutoff-untrusted',
      retryScheduled: true,
    });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
  });
});
