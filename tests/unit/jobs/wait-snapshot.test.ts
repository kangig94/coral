import type { ProgressVisit, WaitCursor } from '#src/jobs/wait/contract.js';
import { describe, expect, it } from 'vitest';
import { parseWaitSnapshot, selectWaitSnapshot as selectWaitSnapshotFrom } from '#src/jobs/wait/snapshot.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { formatWaitSnapshot } from '#src/cli/format/wait.js';
import { admitted, savedCursor, testSession } from '#tests/helpers/wait-session.js';

function collect(jobs: ReturnType<typeof admitted>[], lines?: number) {
  const session = testSession(
    jobs.map((job) => job.jobId),
    lines === undefined ? savedCursor(0) : undefined,
  );
  session.reconcile(jobs);
  return selectWaitSnapshot(session, lines);
}

describe('wait snapshot', () => {
  it('holds a terminal behind a transient progress read and keeps its first-read tail for the next read', () => {
    const job = admitted(
      'held',
      Array.from({ length: 30 }, (_, i) => [i + 1, `line${i + 1}`]),
    );
    const busy: ProgressVisit = () => ({ kind: 'unreadable', disposition: 'transient-unknown' });
    const firstSession = testSession(['held']);
    firstSession.reconcile([job]);
    const first = selectWaitSnapshotFrom(firstSession, 20, busy);
    expect(first.jobs[0].terminal).toBeUndefined();
    expect(first.jobs[0].progress).toEqual([]);
    expect(first.remainingJobIds).toEqual(['held']);
    expect(first.cursor).toBeNull();

    const resumed = testSession(['held'], first.cursor ?? undefined);
    resumed.reconcile([job]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].progress).toEqual(Array.from({ length: 20 }, (_, i) => `line${i + 11}`));
    expect(second.jobs[0].terminal).toBeDefined();
    expect(second.remainingJobIds).toEqual([]);
  });

  it('selects last N per job and uniformly reduces N under the shared budget', () => {
    const jobs = Array.from({ length: 128 }, (_, i) =>
      admitted(
        `j${i}`,
        Array.from({ length: 8 }, (_, n) => [i * 8 + n + 1, `line${n}`] as [number, string]),
        false,
      ),
    );
    // 128 tails share 500 lines, so each shows three.
    const snapshot = collect(jobs, 20);
    expect(snapshot.jobs.every((job) => job.progress.length === 3)).toBe(true);
    expect(snapshot.notices).toEqual(expect.arrayContaining([expect.stringContaining('was not shown')]));
    expect(snapshot.jobs[0].progress).toEqual(['line5', 'line6', 'line7']);
    expect(snapshot.exitCode).toBe(75);
  });

  it('cuts one row larger than the whole budget to it, marks the cut, and collects the outcome after it', () => {
    const a = admitted('a', [[1, Array.from({ length: 501 }, (_, i) => `${i + 1}`).join('\n')]]);
    const session = testSession(['a'], savedCursor(0));
    session.reconcile([a]);
    const first = selectWaitSnapshot(session);
    expect(first.jobs[0].progress).toHaveLength(500);
    expect(first.jobs[0].progress.at(-1)).toMatch(/^500\[line shortened: \d+ bytes omitted\]$/);
    expect(first.jobs[0].terminal).toBeDefined();
    expect(first.remainingJobIds).toEqual([]);
    expect(first.exitCode).toBe(0);
  });

  it('shares the seq prefix between interleaved jobs and respects LF, empties, and byte budgets', () => {
    const a = admitted('a', [
      [1, '\nfirst\n\n'],
      [3, '🙂'.repeat(5000)],
    ]);
    const b = admitted('b', [[2, '']]);
    const snapshot = collect([a, b]);
    expect(snapshot.jobs[0].progress.slice(0, 3)).toEqual(['', 'first', '']);
    expect(snapshot.jobs[1].progress).toEqual(['']);
    expect(snapshot.jobs[0].progress[3]).toContain('[line shortened:');
    expect(Buffer.byteLength(snapshot.jobs[0].progress[3])).toBeLessThanOrEqual(4096);
    const limited = collect([admitted('a', [[1, Array.from({ length: 500 }, () => 'x'.repeat(4096)).join('\n')]])]);
    expect(limited.jobs[0].progress).toHaveLength(16);
    expect(limited.jobs[0].progress.reduce((sum, line) => sum + Buffer.byteLength(line), 0)).toBeLessThanOrEqual(65536);
    expect(limited.remainingJobIds).toEqual([]);
  });

  it('keeps all-refused exit 1, live headers truthful, and failed acknowledged backlogs failed', () => {
    const refused = testSession(['ghost']);
    refused.reconcile([{ jobId: 'ghost', disposition: 'missing' }]);
    const noJobs = selectWaitSnapshot(refused);
    expect(noJobs.exitCode).toBe(1);
    expect(noJobs.remainingJobIds).toEqual([]);
    expect(formatWaitSnapshot(noJobs)).not.toContain('coral-cli wait jobs');
    for (const phase of ['running', 'queued'] as const) {
      const a = admitted('a', [], false);
      a.detail.status.phase = phase;
      const live = collect([a]);
      expect(formatWaitSnapshot(live)).not.toContain('terminal');
      expect(formatWaitSnapshot(live)).toContain(`Job a: ${phase}`);
      expect(formatWaitSnapshot(live)).toContain(' --now --cursor ');
    }
    const a = admitted('a', [[1, 'line']], true, 'epoch-E', true);
    const session = testSession(['a'], savedCursor(1000));
    session.reconcile([a]);
    expect(selectWaitSnapshot(session).exitCode).toBe(42);
  });

  it('bounds two escape-heavy multibyte terminal and diagnostic previews; full detail keeps the tail', () => {
    const jobs = Array.from({ length: 2 }, (_, i) => {
      const a = admitted(`j${i}`);
      a.detail.exit!.content = '🙂\\\"\n'.repeat(2000) + 'BEYOND_10000_MARKER\nTRAILING_CONTENT\n';
      a.detail.exit!.diagnostics.warnings = ['full diagnostic '.repeat(500)];
      a.availability = { kind: 'failed', reason: 'the source journal is no longer retained' };
      return a;
    });
    const snapshot = collect(jobs);
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: snapshot }))).toBeLessThan(
      2 * 1024 * 1024,
    );
    expect(snapshot.jobs.every((job) => job.terminal!.contentOmitted && job.terminal!.diagnosticOmitted)).toBe(true);
    expect(parseWaitSnapshot(snapshot)).toEqual(snapshot);
    const text = formatWaitSnapshot(snapshot);
    expect(text).toContain('coral-cli jobs detail j0 --full');
    expect(text).toContain('Content omitted from preview.');
    expect(text).toContain('Diagnostics omitted from preview.');
    expect(text).not.toMatch(/omitted: \d+ bytes/);
    expect(text).not.toContain('Result path:');
    const full = formatJobDetail(jobs[0].detail, undefined, [], true);
    expect(full).toContain('BEYOND_10000_MARKER\nTRAILING_CONTENT\n');
    expect(full).toContain(jobs[0].detail.exit!.diagnostics.warnings![0]);
    expect(formatJobDetail(jobs[0].detail)).not.toContain('BEYOND_10000_MARKER');
  });

  it('keeps a pending artifact in the continuation and prints the terminal again with its settled path', () => {
    const a = admitted('a');
    a.availability = { kind: 'pending' };
    const first = collect([a]);
    expect(first.jobs[0].terminal).toBeDefined();
    expect(first.remainingJobIds).toEqual(['a']);
    expect(first.exitCode).toBe(75);
    a.availability = { kind: 'available', resultPath: '/result/a' };
    const resumed = testSession(['a'], first.cursor ?? undefined);
    resumed.reconcile([a]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].terminal).toBeDefined();
    expect(formatWaitSnapshot(second)).toMatch(/^Job a: terminal\nOutcome: completed;[^]*\nResult path: \/result\/a$/m);
    expect(second.remainingJobIds).toEqual([]);
    expect(second.exitCode).toBe(0);
  });
});

it('collects every remaining line after a budget cut, tolerating lines the next read repeats', () => {
  const job = admitted(
    'a',
    Array.from({ length: 900 }, (_, i) => [i + 1, `line${i}`]),
  );
  const seen = new Set<string>();
  let cursor: WaitCursor | undefined = savedCursor(0);
  let snapshot;
  for (let read = 0; read < 4; read++) {
    const session = testSession(['a'], cursor);
    session.reconcile([job]);
    snapshot = selectWaitSnapshot(session);
    for (const line of snapshot.jobs[0].progress) seen.add(line);
    cursor = snapshot.cursor ?? undefined;
    if (snapshot.remainingJobIds.length === 0) break;
  }
  expect(seen).toEqual(
    new Set(job.detail.events.flatMap((event) => (event.type === 'progress' ? [event.message] : []))),
  );
  expect(snapshot?.jobs[0].terminal).toBeDefined();
});
