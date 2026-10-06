import type { ProgressVisit, WaitCursor } from '#src/jobs/wait/contract.js';
import { prefixCursor } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';
import { WaitSession } from '#src/jobs/wait/session.js';
import { parseWaitSnapshot, selectWaitSnapshot as selectWaitSnapshotFrom } from '#src/jobs/wait/snapshot.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { formatWaitSnapshot } from '#src/cli/format/wait.js';
import { admitted } from '#tests/helpers/wait-session.js';

function collect(jobs: ReturnType<typeof admitted>[], lines?: number) {
  const session = new WaitSession(
    jobs.map((job) => job.jobId),
    lines === undefined ? prefixCursor(jobs) : undefined,
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
    const firstSession = new WaitSession(['held']);
    firstSession.reconcile([job]);
    const first = selectWaitSnapshotFrom(firstSession, 20, busy);
    expect(first.jobs[0].terminal).toBeUndefined();
    expect(first.jobs[0].progress).toEqual([]);
    expect(first.remainingJobIds).toEqual(['held']);
    expect(first.cursor.jobs).toEqual([]);

    const resumed = new WaitSession(['held'], first.cursor);
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
    const session = new WaitSession(['a'], prefixCursor([a]));
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

  it('shares a 500-line budget across terminal siblings, then collects only the unread sibling', () => {
    // Two lines per row reach the 500-line budget; line501 is the one left over.
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
    expect(second.jobs[0].terminal).toBeDefined();
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
    session.collect(a);
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
    expect(input.collected(a)).toBe(false);
  });

  it('keeps a pending artifact in the continuation and reports its settled path without replaying the outcome', () => {
    const a = admitted('a');
    a.availability = { kind: 'pending' };
    const first = collect([a]);
    expect(first.jobs[0].terminal).toBeDefined();
    expect(first.remainingJobIds).toEqual(['a']);
    expect(first.exitCode).toBe(75);
    a.availability = { kind: 'available', resultPath: '/result/a' };
    const resumed = new WaitSession(['a'], first.cursor);
    resumed.reconcile([a]);
    const second = selectWaitSnapshot(resumed);
    expect(second.jobs[0].terminal).toBeUndefined();
    expect(formatWaitSnapshot(second)).toContain('terminal/already collected\nResult path: /result/a');
    expect(second.remainingJobIds).toEqual([]);
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
    expect(snapshot.jobs.every((job) => job.progress.length === 3)).toBe(true);
    expect(snapshot.jobs.flatMap((job) => job.progress)).toHaveLength(384);
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
  for (let page = 0; page < 3; page++) {
    const session: WaitSession = new WaitSession(['a'], cursor);
    session.reconcile([job]);
    const split = vi.spyOn(String.prototype, 'split');
    try {
      const snapshot = selectWaitSnapshot(session);
      expect(snapshot.jobs[0].progress[0]).toBe(`line${page * 500}`);
      // Each delivered row is split once to select it and once to lay it out; no consumed row is read again.
      expect(split.mock.calls.length).toBeLessThanOrEqual(1002);
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

describe('first snapshot tails', () => {
  const dense = (jobId: string, base: number, lines: number) =>
    admitted(
      jobId,
      Array.from({ length: lines }, (_, n) => [base + n + 1, `${jobId}-${n + 1}`] as [number, string]),
      false,
    );

  it.each([
    [1, 500, 500],
    [3, 200, 166],
  ])('shows %i dense tails asked for %i lines each at most their equal share of the budget', (count, lines, shown) => {
    const jobs = Array.from({ length: count }, (_, j) => dense(`d${j}`, j * 600, 600));
    const session = new WaitSession(jobs.map((job) => job.jobId));
    session.reconcile(jobs);
    const snapshot = selectWaitSnapshot(session, lines);
    expect(snapshot.jobs.map((job) => job.progress.length)).toEqual(Array.from({ length: count }, () => shown));
    expect(snapshot.notices).not.toContainEqual(expect.stringContaining('Progress truncated'));
  });
});

it('collects every remaining line after a budget cut, tolerating lines the next read repeats', () => {
  const job = admitted(
    'a',
    Array.from({ length: 900 }, (_, i) => [i + 1, `line${i}`]),
  );
  const seen = new Set<string>();
  let cursor: WaitCursor | undefined = prefixCursor([job]);
  let snapshot;
  for (let read = 0; read < 4; read++) {
    const session = new WaitSession(['a'], cursor);
    session.reconcile([job]);
    snapshot = selectWaitSnapshot(session);
    for (const line of snapshot.jobs[0].progress) seen.add(line);
    cursor = snapshot.cursor;
    if (snapshot.remainingJobIds.length === 0) break;
  }
  expect(seen).toEqual(
    new Set(job.detail.events.flatMap((event) => (event.type === 'progress' ? [event.message] : []))),
  );
  expect(snapshot?.jobs[0].terminal).toBeDefined();
});
