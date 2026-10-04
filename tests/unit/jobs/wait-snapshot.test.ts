import { describe, expect, it } from 'vitest';
import { WaitSession } from '#src/jobs/wait-session.js';
import { parseWaitSnapshot, selectWaitSnapshot } from '#src/jobs/wait-snapshot.js';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { formatWaitSnapshot } from '#src/cli/format/wait.js';
import { admitted } from '#tests/helpers/wait-session.js';

function collect(jobs: ReturnType<typeof admitted>[], lines?: number) {
  const session = new WaitSession(jobs.map((job) => job.jobId));
  session.reconcile(jobs);
  return selectWaitSnapshot(session, lines);
}

describe('wait snapshot', () => {
  it('selects last N per job and uniformly reduces N under the shared budget', () => {
    const jobs = Array.from({ length: 128 }, (_, i) =>
      admitted(
        `j${i}`,
        Array.from({ length: 8 }, (_, n) => [i * 8 + n + 1, `line${n}`] as [number, string]),
        false,
      ),
    );
    const snapshot = collect(jobs, 20);
    expect(snapshot.jobs.every((job) => job.progress.length === 3)).toBe(true);
    expect(snapshot.notices).toContain('640 earlier progress lines were not shown.');
    expect(snapshot.jobs[0].progress).toEqual(['line5', 'line6', 'line7']);
    expect(snapshot.exitCode).toBe(75);
  });

  it('delivers one terminal summary with 500 lines, then exactly line 501 without outcome replay', () => {
    const a = admitted('a', [[1, Array.from({ length: 501 }, (_, i) => `${i + 1}`).join('\n')]]);
    const session = new WaitSession(['a']);
    session.reconcile([a]);
    const first = selectWaitSnapshot(session);
    expect(first.jobs[0].progress).toHaveLength(500);
    expect(first.jobs[0].terminal).toBeDefined();
    expect(first.remainingJobIds).toEqual(['a']);
    const resumed = new WaitSession(['a'], first.cursor);
    resumed.reconcile([a]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].progress).toEqual(['501']);
    expect(second.jobs[0].terminal).toBeUndefined();
    expect(second.jobs[0].alreadyCollected).toBe(true);
    expect(second.exitCode).toBe(0);
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
    expect(limited.remainingJobIds).toEqual(['a']);
  });

  it('shares a 500-line prefix across terminal siblings, then collects only the unread sibling without replaying outcomes', () => {
    const messages = Array.from({ length: 501 }, (_, i) => [i + 1, `line${i + 1}`] as [number, string]);
    const a = admitted(
      'a',
      messages.filter(([seq]) => seq % 2 === 1),
    );
    const b = admitted(
      'b',
      messages.filter(([seq]) => seq % 2 === 0),
    );
    const first = collect([a, b]);
    expect(first.jobs.map((job) => job.progress.length)).toEqual([250, 250]);
    expect(first.remainingJobIds).toEqual(['a']);
    const resumed = new WaitSession(['a'], first.cursor);
    resumed.reconcile([a]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].progress).toEqual(['line501']);
    expect(second.jobs[0].terminal).toBeUndefined();
    expect(second.exitCode).toBe(0);
  });

  it('keeps all-refused exit 1, live headers truthful, and failed acknowledged backlogs failed', () => {
    const refused = new WaitSession(['ghost']);
    refused.reconcile([{ jobId: 'ghost', disposition: 'missing' }]);
    const noJobs = selectWaitSnapshot(refused);
    expect(noJobs.exitCode).toBe(1);
    expect(noJobs.remainingJobIds).toEqual([]);
    expect(formatWaitSnapshot(noJobs)).not.toContain('coral-cli wait jobs');
    for (const phase of ['running', 'queued'] as const) {
      const a = admitted('a', [], false);
      a.detail!.status.phase = phase;
      const live = collect([a]);
      expect(formatWaitSnapshot(live)).not.toContain('terminal');
      expect(formatWaitSnapshot(live)).not.toContain('already collected');
      expect(formatWaitSnapshot(live)).toContain(`Job a: ${phase}`);
      expect(formatWaitSnapshot(live)).toContain(' --now --cursor ');
    }
    const a = admitted('a', [[1, 'line']], true, 'epoch-E', true);
    const session = new WaitSession(['a']);
    session.reconcile([a]);
    session.acknowledge(a);
    expect(selectWaitSnapshot(session).exitCode).toBe(42);
  });

  it('bounds 128 escape-heavy multibyte terminal and diagnostic previews; full detail keeps the tail', () => {
    const jobs = Array.from({ length: 128 }, (_, i) => {
      const a = admitted(`j${i}`);
      a.detail!.exit!.content = '🙂\\\"\n'.repeat(30000) + 'BEYOND_10000_MARKER\nTRAILING_CONTENT\n';
      a.detail!.exit!.diagnostics.warnings = ['full diagnostic '.repeat(10000)];
      a.availability = { kind: 'failed', cause: 'source-epoch-retired', retryScheduled: false };
      return a;
    });
    const snapshot = collect(jobs);
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: snapshot }))).toBeLessThan(
      2 * 1024 * 1024,
    );
    expect(
      snapshot.jobs.every((job) => job.terminal!.contentOmittedBytes > 0 && job.terminal!.diagnosticOmittedBytes > 0),
    ).toBe(true);
    expect(parseWaitSnapshot(snapshot)).toEqual(snapshot);
    const text = formatWaitSnapshot(snapshot);
    expect(text).toContain('coral-cli jobs detail j0 --full');
    expect(text).not.toContain('Result path:');
    const full = formatJobDetail(jobs[0].detail!, undefined, [], true);
    expect(full).toContain('BEYOND_10000_MARKER\nTRAILING_CONTENT\n');
    expect(full).toContain(jobs[0].detail!.exit!.diagnostics.warnings![0]);
    expect(formatJobDetail(jobs[0].detail!)).not.toContain('BEYOND_10000_MARKER');
  });

  it('refuses oversized mandatory identities without changing the input collection cursor', () => {
    const a = admitted('a');
    a.availability = { kind: 'available', resultPath: '/'.repeat(2 * 1024 * 1024) };
    const input = new WaitSession(['a']);
    input.reconcile([a]);
    const cursor = input.cursor();
    const before = JSON.stringify(cursor);
    const request = new WaitSession(['a'], cursor);
    request.reconcile([a]);
    expect(() => selectWaitSnapshot(request)).toThrow('Snapshot identity metadata exceeds');
    expect(JSON.stringify(cursor)).toBe(before);
    expect(input.acknowledged('a')).toBe(false);
  });

  it('preserves artifact follow-up without outcome replay', () => {
    const a = admitted('a');
    a.availability = { kind: 'repair-pending', ageUncertain: false };
    const first = collect([a]);
    expect(first.remainingJobIds).toEqual(['a']);
    a.availability = { kind: 'available', resultPath: '/result/a' };
    const resumed = new WaitSession(['a'], first.cursor);
    resumed.reconcile([a]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].terminal).toBeUndefined();
    expect(formatWaitSnapshot(second)).toContain('result file now available\nResult path: /result/a');
    expect(second.exitCode).toBe(0);
  });
});
