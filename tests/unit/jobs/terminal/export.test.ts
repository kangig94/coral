import { renderWorkflowReport } from '#src/workflow/result-report.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { dirname } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalResultExportOwner } from '#src/jobs/terminal/export.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { initTestJob } from '#tests/helpers/session.js';
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
  it('reports failed attempts until a successful retry clears them', async () => {
    const f = fixture();
    f.complete();
    const write = f.runtime.storage.writeAtomicDurableSync;
    const failure = vi
      .spyOn(f.runtime.storage, 'writeAtomicDurableSync')
      .mockImplementation((path, body, options) => (path === f.resultPath ? false : write(path, body, options)));
    const owner = f.store.getResultExportOwner();
    expect(() => owner.publishTerminalResult(f.jobId)).toThrow();
    expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
    failure.mockRestore();
    await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('available');
  });

  it('repairs a committed terminal even if recording its location failed', async () => {
    const f = fixture();
    commitJobTerminal(f.store, f.jobId, 'session-1', {
      content: 'canonical result',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    const owner = f.store.getResultExportOwner();
    owner.hintRepair(f.jobId);
    await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
  });

  it('observes the source before applying a permanent location hold', () => {
    const f = fixture();
    f.complete();
    f.index.markUncertified(f.jobId);
    f.index.holdUnknownLocations(f.epochKey, 'retained-controller-recovery-unavailable');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
  });

  it('repairs an unhinted tail despite persistent failed retries with a one-candidate pass budget', async () => {
    const f = fixture();
    f.complete();
    const heads = ['head-1', 'head-2'];
    for (const jobId of heads) {
      initTestJob(f.store, {
        jobId,
        sessionId: jobId,
        provider: 'claude',
        projectRoot: f.root,
        backendNamespace: 'fixture',
      });
      const seq = commitJobTerminal(f.store, jobId, jobId, {
        content: 'head result',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      const detail = f.store.loadJobProjectionDetail(jobId);
      if (!detail.status) throw new Error('Missing fixture status');
      f.index.recordTerminal(
        jobId,
        {
          status: detail.status,
          events: f.store.readJobEvents(jobId),
          exit: detail.exit,
          readiness: deriveLaunchReadiness(detail),
        },
        f.index.resultPathFor(jobId),
        seq,
      );
    }
    const owner = f.store.getResultExportOwner();
    const wakeup = vi.fn();
    owner.onRepairHint(wakeup);
    const write = f.runtime.storage.writeAtomicDurableSync;
    const attempts: string[] = [];
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, bytes, options) => {
      const jobId = [...heads, f.jobId].find((id) => path === f.index.resultPathFor(id));
      if (jobId) attempts.push(jobId);
      if (jobId && heads.includes(jobId)) return false;
      return write(path, bytes, options);
    });
    for (let pass = 0; pass < 8; pass++) {
      let left = 1;
      await owner.repairPass([...heads, f.jobId], { canContinue: () => left-- > 0, record: vi.fn() });
    }
    expect(attempts).toContain(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    for (const jobId of heads) {
      expect(attempts.filter((id) => id === jobId).length).toBeGreaterThan(1);
      expect(owner.observeResultAvailability(jobId)).toEqual({ kind: 'pending' });
    }
    expect(wakeup).not.toHaveBeenCalled();
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
    expect(report).toBe('# Step 0.0: intermediate\n\nintermediate output\n\n# Step 1.0: final\n\nfinal output\n');
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

  it('renders the outcome explanation when workflow completion facts are absent', () => {
    const f = fixture('workflow');
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('Completed.\n');
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('refuses contradictory workflow completion facts', () => {
    const f = fixture('workflow');
    f.complete({ steps: [] });
    f.db
      .prepare("UPDATE events SET body = ? WHERE type = 'workflow.completed'")
      .run(Buffer.from(JSON.stringify({ outcome: 'aborted', stepDetails: [] })));
    f.store.publishTerminalResult(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toEqual({
      kind: 'failed',
      reason: 'the source facts needed to write the result file are unavailable',
    });
  });

  it('leaves an available file untouched on repair', () => {
    const f = fixture();
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    writeFileSync(f.resultPath, 'older canonical rendering');
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('older canonical rendering');
  });

  it.each([-1, 0])('uses strict expiry at cutoff %+i', (offset) => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF + offset });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(offset >= 0);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe(
      offset < 0 ? 'retained-away' : 'available',
    );
    if (offset < 0) expect(f.index.resultDurable(f.jobId, f.db)).toBe(true);
  });

  it('denies retirement proof for a retained terminal whose timestamp disagrees with its source or is missing', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    expect(f.index.resultDurable(f.jobId, f.db)).toBe(true);
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    const corrupt = structuredClone(record);
    corrupt.detail.events[0].ts = new Date(TERMINAL_EXPORT_CUTOFF - 2).toISOString();
    writeFileSync(f.locationPath, JSON.stringify(corrupt));
    expect(f.index.resultDurable(f.jobId, f.db)).toBe(false);
    delete record.detail;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.resultDurable(f.jobId, f.db)).toBe(false);
  });

  it('refuses disagreement on recording and reads a record without its optional result copy', () => {
    const f = fixture();
    const seq = f.complete();
    const location = f.index.read(f.jobId);
    if (location?.detail.kind !== 'recorded') throw new Error('missing fixture detail');
    const detail = structuredClone(location.detail.value);
    if (!detail.status.result) throw new Error('missing result');
    detail.status.result.content = 'stale caller content';
    expect(() => f.index.recordTerminal(f.jobId, detail, f.resultPath, seq)).toThrow('disagrees');
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.detail.status.result;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.read(f.jobId)?.detail.kind).toBe('recorded');
  });

  it('reports an unexpired missing artifact after source retirement as failed without a retry', () => {
    const f = fixture();
    f.complete();
    f.removeSource();
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toEqual({
      kind: 'failed',
      reason: 'the source journal is no longer retained',
    });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('repeated observation makes no write, fsync or terminal body parse', () => {
    const f = fixture();
    f.complete();
    const owner = f.store.getResultExportOwner();
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    const sync = vi.spyOn(f.runtime.storage, 'fdatasyncSync');
    const parse = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 4; i++) expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
    expect(write).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(parse.mock.calls.filter(([body]) => body.startsWith('{"terminal":'))).toHaveLength(0);
  });
});

it('checks accepted source content at publication rather than observation', () => {
  const f = fixture();
  f.complete();
  f.db
    .prepare("UPDATE events SET body = ? WHERE stream_id = ? AND type = 'job.terminal.recorded'")
    .run(
      Buffer.from(
        JSON.stringify({ terminal: { content: 'different result', outcome: { kind: 'completed' }, durationMs: 1 } }),
      ),
      f.jobId,
    );
  const owner = f.store.getResultExportOwner();
  expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
  owner.publishTerminalResult(f.jobId);
  expect(existsSync(f.resultPath)).toBe(false);
  expect(owner.observeResultAvailability(f.jobId)).toEqual({
    kind: 'failed',
    reason: 'the source facts needed to write the result file are unavailable',
  });
});

describe('canonical render across owner contexts', () => {
  describe('result renderer canonicality', () => {
    it('renders identical bytes for a failed terminal across owner read contexts', () => {
      const f = createTerminalExportFixture('provider');
      try {
        const ins = f.db
          .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, refs, body) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            new Date().toISOString(),
            'workflow.lifecycle_fault',
            'workflow',
            'wf-1',
            JSON.stringify({ workflowId: 'wf-1' }),
            Buffer.from(JSON.stringify({ kind: 'wrapper_crashed', message: 'boom' })),
          );
        const causeSeq = Number(ins.lastInsertRowid);
        f.complete({
          terminal: {
            content: '',
            outcome: { kind: 'failed', causeRef: { stream: { kind: 'workflow', id: 'wf-1' }, seq: causeSeq } },
            durationMs: 1,
          } as never,
        });
        const render = (ctx: object) => {
          rmSync(dirname(f.resultPath), { recursive: true, force: true });
          const owner = new TerminalResultExportOwner({
            runtime: f.runtime,
            jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
            workflowReport: renderWorkflowReport,
            location: (id) => f.index.read(id),
            withSource: (_id, read) => read(f.db, ctx as never),
          });
          owner.publishTerminalResult(f.jobId);
          return readFileSync(f.resultPath, 'utf8');
        };
        const full = {
          ...composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
          bodyCodec: createEventBodyCodec(),
        };
        const jobsOnly = { ...composeReducers(jobsRegistry), bodyCodec: createEventBodyCodec() };
        const coordinatorBytes = render(full);
        const historicalBytes = render(jobsOnly);

        expect(coordinatorBytes).toBe(historicalBytes);
      } finally {
        f.close();
      }
    });
  });
});

it('settles a readable terminal whose owner cannot capture it without a repair loop', async () => {
  const f = fixture();
  f.complete();
  const retained = f.index.read(f.jobId)!;
  const prepare = vi.fn();
  const owner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: () => ({ ...retained, disposition: 'unresolved', detail: { kind: 'absent' }, terminalSeq: undefined }),
    withSource: (_id, read) => read(f.db, f.store),
    prepareTerminal: prepare,
  });
  expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
  owner.hintRepair(f.jobId);
  await owner.repairPass([], { canContinue: () => true, record: vi.fn() }, true);
  expect(owner.observeResultAvailability(f.jobId)).toMatchObject({ kind: 'failed' });
  owner.hintRepair(f.jobId);
  await owner.repairPass([], { canContinue: () => true, record: vi.fn() }, true);
  expect(prepare).toHaveBeenCalledOnce();
  expect(existsSync(f.resultPath)).toBe(false);
});
