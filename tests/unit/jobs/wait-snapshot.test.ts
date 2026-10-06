import { WAIT_SNAPSHOT_BYTES, type ProgressVisit, type WaitCursor } from '#src/jobs/wait/contract.js';
import { progressPage, progressTail } from '#src/jobs/wait/progress-page.js';
import { ACKNOWLEDGED_FLAG, TAIL_SCAN_FLAG } from '#src/jobs/wait/cursor.js';
import { prefixCursor } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';
import { WaitSession } from '#src/jobs/wait/session.js';
import { parseWaitSnapshot, selectWaitSnapshot as selectWaitSnapshotFrom } from '#src/jobs/wait/snapshot.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { formatWaitSnapshot } from '#src/cli/format/wait.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';

function collect(jobs: ReturnType<typeof admitted>[], lines?: number) {
  const session = new WaitSession(
    jobs.map((job) => job.jobId),
    lines === undefined ? prefixCursor(jobs) : undefined,
  );
  session.reconcile(jobs);
  return selectWaitSnapshot(session, lines);
}

describe('wait snapshot', () => {
  it('keeps first-read tail positioning when a terminal is acknowledged during a transient progress read', () => {
    const job = admitted(
      'held',
      Array.from({ length: 30 }, (_, i) => [i + 1, `line${i + 1}`]),
    );
    job.sourceRead = 'transient-unknown';
    const firstSession = new WaitSession(['held']);
    firstSession.reconcile([job]);
    const first = selectWaitSnapshot(firstSession);
    expect(first.jobs[0].terminal).toBeDefined();
    expect(first.jobs[0].progress).toEqual([]);
    expect(first.remainingJobIds).toEqual(['held']);
    expect(first.cursor.jobs[0]).toMatchObject({ seq: 0, lineOffset: 0, flags: 5 });

    job.sourceRead = 'readable';
    const resumed = new WaitSession(['held'], first.cursor);
    resumed.reconcile([job]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].progress).toEqual(Array.from({ length: 20 }, (_, i) => `line${i + 11}`));
    expect(second.jobs[0].terminal).toBeUndefined();
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
    // 128 tails of two lines and a lookahead row each fit the 500-row allowance; a third line would not.
    const snapshot = collect(jobs, 20);
    expect(snapshot.jobs.every((job) => job.progress.length === 2)).toBe(true);
    expect(snapshot.notices).toEqual(expect.arrayContaining([expect.stringContaining('was not shown')]));
    expect(snapshot.jobs[0].progress).toEqual(['line6', 'line7']);
    expect(snapshot.exitCode).toBe(75);
  });

  it('delivers one terminal summary with 500 lines, then exactly line 501 without outcome replay', () => {
    const a = admitted('a', [[1, Array.from({ length: 501 }, (_, i) => `${i + 1}`).join('\n')]]);
    const session = new WaitSession(['a'], prefixCursor([a]));
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
    // Two lines per row reach the 500-line budget within the 500-row allowance; line501 is the one left over.
    const messages = Array.from(
      { length: 251 },
      (_, i) => [i + 1, i === 250 ? 'line501' : `line${2 * i + 1}\nline${2 * i + 2}`] as [number, string],
    );
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
      a.detail.status.phase = phase;
      const live = collect([a]);
      expect(formatWaitSnapshot(live)).not.toContain('terminal');
      expect(formatWaitSnapshot(live)).not.toContain('already collected');
      expect(formatWaitSnapshot(live)).toContain(`Job a: ${phase}`);
      expect(formatWaitSnapshot(live)).toContain(' --now --cursor ');
    }
    const a = admitted('a', [[1, 'line']], true, 'epoch-E', true);
    const session = new WaitSession(['a'], prefixCursor([a]));
    session.reconcile([a]);
    session.acknowledge(a);
    expect(selectWaitSnapshot(session).exitCode).toBe(42);
  });

  it('bounds two escape-heavy multibyte terminal and diagnostic previews; full detail keeps the tail', () => {
    const jobs = Array.from({ length: 2 }, (_, i) => {
      const a = admitted(`j${i}`);
      a.detail.exit!.content = '🙂\\\"\n'.repeat(2000) + 'BEYOND_10000_MARKER\nTRAILING_CONTENT\n';
      a.detail.exit!.diagnostics.warnings = ['full diagnostic '.repeat(500)];
      a.availability = { kind: 'failed', cause: 'source-epoch-retired', retryScheduled: false };
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

  it('keeps all omitted --lines progress resumable when 128 large rows exhaust the envelope', () => {
    const jobs = Array.from({ length: 128 }, (_, i) => admitted(`j${i}`, [[i + 1, 'x'.repeat(500)]]));
    const empty = collect(jobs.map((job) => ({ ...job, detail: { ...job.detail, events: [] } })));
    const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(1024), result: empty }));
    const messageBytes = Math.floor((2 * 1024 * 1024 - 20000 - overhead) / jobs.length);
    for (const job of jobs) job.message = 'm'.repeat(messageBytes);
    const snapshot = collect(jobs, 1);
    expect(snapshot.jobs.every((job) => job.progress.length === 0)).toBe(true);
    expect(snapshot.notices).toContain('Progress omitted to fit the complete response; run the continuation.');
    expect(snapshot.remainingJobIds).toEqual(jobs.map((job) => job.jobId));
    expect(parseWaitSnapshot(snapshot)).toEqual(snapshot);
    const resumed = new WaitSession(snapshot.remainingJobIds, snapshot.cursor);
    resumed.reconcile(jobs.map(({ message: _message, ...job }) => job));
    const continuation = selectWaitSnapshot(resumed);
    expect(continuation.jobs.every((job) => job.progress.length === 1 && !job.terminal)).toBe(true);
    expect(continuation.remainingJobIds).toEqual([]);
    expect(continuation.exitCode).toBe(0);
  });

  it('keeps a terminal job unread and in the continuation when size fitting omits progress a fault-only page exhausted', () => {
    const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i} ${'L'.repeat(3990)}`);
    const raw = [
      { seq: 1, progress: { seq: 1, message: lines.join('\n'), timing } },
      ...Array.from({ length: 40 }, (_, i) => ({ seq: i + 2 })),
    ];
    const visit: ProgressVisit = (_epoch, read) => ({
      kind: 'read',
      value: read({
        after: (_id, after, rows) => progressPage(raw.filter((row) => row.seq > after).slice(0, rows + 1), rows, 1000),
        before: (_id, before, rows) =>
          progressTail(
            raw
              .filter((row) => before === null || row.seq < before)
              .reverse()
              .slice(0, rows + 1),
            rows,
            1000,
          ),
      }),
    });
    const a = admitted('a');
    const ghost = {
      jobId: 'ghost',
      disposition: 'discovery-unreadable' as const,
      message: 'm'.repeat(WAIT_SNAPSHOT_BYTES - 30_000),
    };
    const input = savedCursor({ a: 0 });
    const session = new WaitSession(['a', 'ghost'], input);
    session.reconcile([a, ghost]);
    const snapshot = selectWaitSnapshotFrom(session, 20, visit);
    expect(snapshot.jobs[0].progress).toEqual([]);
    expect(snapshot.notices).toContain('Progress omitted to fit the complete response; run the continuation.');
    expect(snapshot.remainingJobIds).toEqual(['a']);
    expect(snapshot.cursor.jobs).toEqual([{ ...input.jobs[0], flags: ACKNOWLEDGED_FLAG }]);
    expect(formatWaitSnapshot(snapshot)).toContain('Run coral-cli wait jobs a --now --cursor ');

    const resumed = new WaitSession(['a'], snapshot.cursor);
    resumed.reconcile([a]);
    const continuation = selectWaitSnapshotFrom(resumed, 20, visit);
    expect(continuation.jobs[0].progress.map((line) => line.slice(0, 7))).toEqual(
      lines.map((line) => line.slice(0, 7)),
    );
    expect(continuation.jobs[0].alreadyCollected).toBe(true);
    expect(continuation.remainingJobIds).toEqual([]);
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
    expect(() => selectWaitSnapshot(request)).toThrow('Snapshot exceeds the response size budget');
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
it('bounds a default snapshot over 150000 recorded progress events without stack overflow', () => {
  const session = new WaitSession(['a']);
  session.reconcile([
    admitted(
      'a',
      Array.from({ length: 150000 }, (_, i) => [i + 1, `line ${i}`]),
      false,
    ),
  ]);
  const snapshot = selectWaitSnapshot(session, 20);
  expect(snapshot.jobs[0].progress).toHaveLength(20);
  expect(snapshot.jobs[0].progress.at(-1)).toBe('line 149999');
  expect(snapshot.cursor.jobs[0].seq).toBe(150000);
});

it('bounds --lines selection passes independently of the requested history size', () => {
  const jobs = Array.from({ length: 128 }, (_, i) =>
    admitted(
      `cost-${i}`,
      Array.from({ length: 2000 }, (_, n) => [i * 2000 + n + 1, 'line'] as [number, string]),
      false,
    ),
  );
  const filter = vi.spyOn(Array.prototype, 'filter');
  try {
    const snapshot = collect(jobs, 500);
    expect(snapshot.jobs.every((job) => job.progress.length === 2)).toBe(true);
    expect(snapshot.jobs.flatMap((job) => job.progress)).toHaveLength(256);
  } finally {
    filter.mockRestore();
  }
});

it('oversized snapshot remediation preserves every requested job and the input cursor', () => {
  const jobs = [admitted('first'), admitted('second'), admitted('third')];
  jobs[0].availability = { kind: 'available', resultPath: '/'.repeat(2 * 1024 * 1024) };
  const session = new WaitSession(
    jobs.map((job) => job.jobId),
    { jobs: [] },
  );
  session.reconcile(jobs);
  try {
    selectWaitSnapshot(session);
    throw new Error('expected refusal');
  } catch (error) {
    for (const job of jobs) expect(String(error)).toContain(`wait jobs '${job.jobId}' --now --cursor`);
  }
});

it.each([
  [10, 20000, 5000],
  [1, 2000, 5000],
  [1, 5000, 5000],
  [3, 2000, 4200],
])('tail work is bounded for %s jobs × %s lines × %s bytes', (count, length, width) => {
  const jobs = Array.from({ length: count }, (_, i) =>
    admitted(
      `cost-${i}`,
      Array.from({ length }, (_, n) => [i * length + n + 1, 'x'.repeat(width)] as [number, string]),
      false,
    ),
  );
  const split = vi.spyOn(String.prototype, 'split');
  const byteLength = Buffer.byteLength;
  let byteLengthCalls = 0;
  Buffer.byteLength = (...args) => {
    byteLengthCalls++;
    return byteLength(...args);
  };
  try {
    const snapshot = collect(jobs, 20);
    expect(snapshot.jobs.every((job) => job.progress.length > 0)).toBe(true);
    expect(split.mock.calls.filter((call) => (call[0] as unknown) === '\n').length).toBeLessThanOrEqual(count * 42);
    expect(byteLengthCalls).toBeLessThan(5000);
  } finally {
    split.mockRestore();
    Buffer.byteLength = byteLength;
  }
});

it('continuations inspect only their unread page and never rebuild the backlog', () => {
  const job = admitted(
    'a',
    Array.from({ length: 10000 }, (_, i) => [i + 1, `line${i}`]),
    false,
  );
  let cursor: WaitCursor | undefined = prefixCursor([job]);
  // Pages doubling from 32 rows, each with its lookahead row, spend one poll's 500-row allowance on 495 lines.
  for (let page = 0; page < 3; page++) {
    const session: WaitSession = new WaitSession(['a'], cursor);
    session.reconcile([job]);
    const split = vi.spyOn(String.prototype, 'split');
    try {
      const snapshot = selectWaitSnapshot(session);
      expect(snapshot.jobs[0].progress[0]).toBe(`line${page * 495}`);
      expect(split.mock.calls.length).toBeLessThanOrEqual(502);
      cursor = snapshot.cursor;
    } finally {
      split.mockRestore();
    }
  }
});

it('reports tail omissions only when recorded progress was actually omitted', () => {
  expect(collect([admitted('a', [[1, 'only line']], false)], 20).notices).toEqual([]);
  expect(
    collect(
      [
        admitted(
          'a',
          [
            [1, 'earlier'],
            [2, 'selected'],
          ],
          false,
        ),
      ],
      1,
    ).notices,
  ).toEqual(expect.arrayContaining([expect.stringContaining('was not shown')]));
});

it('bounds preview inspection before encoding and never visits omitted diagnostics', () => {
  const job = admitted('bounded');
  const terminal = job.detail.exit!;
  terminal.content = '🙂"\\\n'.repeat(4000);
  terminal.outcome = {
    kind: 'job_fault',
    fault: {
      kind: 'wrapper_crashed',
      cause: {
        message: 'message'.repeat(4000),
        stack: 'stack'.repeat(4000),
      },
    },
  };
  terminal.diagnostics.warnings = Array.from({ length: 100 }, () => 'warning'.repeat(4000));
  Object.defineProperty(terminal.diagnostics.warnings, 8, {
    get: () => {
      throw new Error('Visited omitted warning');
    },
  });
  terminal.diagnostics.progressFaults = Array.from({ length: 100 }, () => ({
    kind: 'recovery_parse_failed',
    cause: {
      message: 'fault'.repeat(4000),
      stack: 'stack'.repeat(4000),
    },
  }));
  Object.defineProperty(terminal.diagnostics.progressFaults, 8, {
    get: () => {
      throw new Error('Visited omitted fault');
    },
  });
  const byteLength = vi.spyOn(Buffer, 'byteLength');
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    const snapshot = collect([job]);
    const summary = snapshot.jobs[0].terminal!;
    expect(summary).toMatchObject({ contentOmitted: true, diagnosticOmitted: true });
    expect(summary.contentPreview).toContain('[preview shortened: content omitted]');
    expect(summary.contentPreview).not.toMatch(/bytes omitted|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(byteLength.mock.calls.every(([value]) => typeof value !== 'string' || value.length < 10000)).toBe(true);
    expect(stringify.mock.calls.every(([value]) => typeof value !== 'string' || value.length <= 2048)).toBe(true);
    expect(parseWaitSnapshot(snapshot)).toEqual(snapshot);
  } finally {
    byteLength.mockRestore();
    stringify.mockRestore();
  }
});

it('reports complete previews without omission and rejects the old exact-count shape', () => {
  const snapshot = collect([admitted('complete')]);
  expect(snapshot.jobs[0].terminal).toMatchObject({ contentOmitted: false, diagnosticOmitted: false });
  const terminal = snapshot.jobs[0].terminal!;
  const { contentOmitted: _content, diagnosticOmitted: _diagnostic, ...rest } = terminal;
  expect(() =>
    parseWaitSnapshot({
      ...snapshot,
      jobs: [
        {
          ...snapshot.jobs[0],
          terminal: {
            ...rest,
            contentOmittedBytes: 0,
            diagnosticOmittedBytes: 0,
          },
        },
      ],
    }),
  ).toThrow();
});

describe('first snapshot positioning within the raw-row allowance', () => {
  const dense = (jobId: string, base: number, lines: number) =>
    admitted(
      jobId,
      Array.from({ length: lines }, (_, n) => [base + n + 1, `${jobId}-${n + 1}`] as [number, string]),
      false,
    );
  const first = (jobs: ReturnType<typeof admitted>[], lines: number) => {
    const session = new WaitSession(jobs.map((job) => job.jobId));
    session.reconcile(jobs);
    return selectWaitSnapshot(session, lines);
  };

  it.each([
    [1, 500, 484],
    [3, 200, 160],
  ])('shows %i dense tails asked for %i lines each their full row share at once', (count, lines, shown) => {
    // Each line is a row and each 32-row tail page a lookahead row, so 500 rows carry 484 lines for one tail.
    const snapshot = first(
      Array.from({ length: count }, (_, j) => dense(`d${j}`, j * 600, 600)),
      lines,
    );
    expect(snapshot.jobs.map((job) => job.progress.length)).toEqual(Array.from({ length: count }, () => shown));
    expect(snapshot.notices).not.toContainEqual(expect.stringContaining('Progress truncated'));
  });

  it('gives a long tail the rows a short sibling leaves, up to the lines asked for', () => {
    const snapshot = first([dense('A', 0, 3), dense('B', 100, 1000)], 400);
    expect(snapshot.jobs.map((job) => job.progress.length)).toEqual([3, 400]);
    expect(snapshot.jobs[1].progress.at(-1)).toBe('B-1000');
  });

  it("positions a healthy tail at once while a fault-dense sibling's cut scan waits for the next poll", () => {
    const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
    const rows: Record<string, Array<{ seq: number; message?: string }>> = {
      F: [
        ...Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, message: `F-${i + 1}` })),
        ...Array.from({ length: 3000 }, (_, i) => ({ seq: 100 + i })),
      ],
      H: Array.from({ length: 10 }, (_, i) => ({ seq: 10 + i, message: `H-${i + 1}` })),
    };
    const raw = (id: string) =>
      rows[id].map((row) => ({
        seq: row.seq,
        ...(row.message === undefined ? {} : { progress: { seq: row.seq, message: row.message, timing } }),
      }));
    const visit: ProgressVisit = (_epoch, read) => ({
      kind: 'read',
      value: read({
        after: (id, after, count) =>
          progressPage(
            raw(id)
              .filter((row) => row.seq > after)
              .slice(0, count + 1),
            count,
            3099,
          ),
        before: (id, before, count) =>
          progressTail(
            raw(id)
              .filter((row) => before === null || row.seq < before)
              .reverse()
              .slice(0, count + 1),
            count,
            3099,
          ),
      }),
    });
    const jobs = [admitted('H', [], false), admitted('F', [], false)];
    const session = new WaitSession(['H', 'F']);
    session.reconcile(jobs);
    const snapshot = selectWaitSnapshotFrom(session, 20, visit);
    expect(snapshot.jobs[0].progress).toEqual(Array.from({ length: 10 }, (_, i) => `H-${i + 1}`));
    expect(snapshot.jobs[1].progress).toEqual([]);
    expect(snapshot.cursor.jobs[1].flags & TAIL_SCAN_FLAG).toBe(TAIL_SCAN_FLAG);
  });
});
