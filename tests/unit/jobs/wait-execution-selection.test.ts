import { describe, expect, it } from 'vitest';
import { waitExecutions } from '#tests/helpers/wait-executions.js';
import { nextOfType } from '#tests/helpers/wait-stream.js';
import { TEST_EPOCH } from '#tests/helpers/wait-session.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { jobsWaitRequest, jobWaitSchema } from '#src/transport/rpc/jobs.js';
import { waitExecutionSelectionsSchema } from '#src/jobs/wait/execution-selection.js';
import { formatWaitSnapshot, formatWaitTerminal, waitContinuationCommand } from '#src/cli/format/wait.js';
import { parseWaitSnapshot, selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';

async function collect(stream: AsyncGenerator<WaitStreamEvent>) {
  const events: WaitStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const selected = (jobId: string, requestedSeq: number) => ({
  jobId,
  epochKey: TEST_EPOCH,
  requestedSeq,
  awaitingArtifact: false,
});

describe('execution-addressed waits', () => {
  it.each([1, 2])(
    'identifies pinned execution #%s after #3 is latest without a retained result path',
    async (execution) => {
      const f = waitExecutions();
      f.request('a', 10);
      f.end('a', 20);
      f.request('a', 30);
      f.end('a', 40);
      f.request('a', 50);
      f.end('a', 60);
      const selection = selected('a', execution === 1 ? 10 : 30);
      const request = { jobIds: ['a'], executionSelections: [selection] };
      const terminal = await nextOfType(f.stream(request), 'terminal');
      terminal.availability = { kind: 'retained-away', retentionDays: 14 };
      delete terminal.resultPath;
      const decoded = parseWaitStreamEventValue(terminal);
      expect(decoded).toMatchObject({ type: 'terminal', execution });
      if (decoded?.type !== 'terminal') throw new Error('Expected terminal');
      expect(formatWaitTerminal(decoded, null, false).split('\n')[0]).toBe(`Job a execution #${execution} completed`);

      const session = new WaitSession(['a'], undefined, TEST_EPOCH, false, [selection]);
      const admissions = f.coordinator.readWaitAdmissions(['a'], TEST_EPOCH, request);
      admissions[0].availability = terminal.availability;
      session.reconcile(admissions);
      const snapshot = parseWaitSnapshot(selectWaitSnapshot(session, 20, f.visit));
      expect(snapshot.jobs[0]).toMatchObject({ execution });
      expect(formatWaitSnapshot(snapshot).split('\n')[0]).toBe(`Job a execution #${execution}: terminal`);
      expect(() => parseWaitStreamEventValue({ ...terminal, execution: 0 })).toThrow();
      expect(() => parseWaitSnapshot({ ...snapshot, jobs: [{ ...snapshot.jobs[0], execution: 0 }] })).toThrow();
    },
  );

  it.each([false, true])('keeps #n when #n+1 starts between polls (also ends: %s)', async (alsoEnds) => {
    const f = waitExecutions();
    f.request('a', 10);
    const stream = f.stream({ jobIds: ['a'], timeoutSeconds: 1 });
    expect(await stream.next()).toMatchObject({
      value: { type: 'admission', executionSelections: [selected('a', 10)] },
    });
    f.end('a', 20);
    f.request('a', 30);
    f.addProgress('a', 31, 'second execution');
    if (alsoEnds) f.end('a', 40);
    const events = await collect(stream);
    expect(events.filter((event) => event.type === 'terminal')).toMatchObject([
      { seq: 20, result: { content: 'a#1' } },
    ]);
    expect(events.some((event) => event.type === 'progress')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      cursor: '20',
      executionSelections: [{ ...selected('a', 10), deliveredEndSeq: 20 }],
    });
    expect(f.load.mock.calls).toEqual([
      ['a', undefined, ['a']],
      ['a', 10, ['a']],
    ]);
  });

  it('returns #n immediately between executions, then selects the next request from completed state', async () => {
    const f = waitExecutions();
    f.request('a', 10);
    f.end('a', 20);
    const first = await nextOfType(f.stream({ jobIds: ['a'] }), 'terminal');
    expect(first.seq).toBe(20);
    const repeated = await collect(
      f.stream({ jobIds: ['a'], cursor: '0', executionSelections: first.executionSelections }),
    );
    expect(repeated.filter((event) => event.type === 'terminal')).toEqual([]);
    f.request('a', 30);
    f.end('a', 40);
    f.request('a', 50);
    const next = await nextOfType(
      f.stream({ jobIds: ['a'], cursor: first.cursor ?? undefined, executionSelections: first.executionSelections }),
      'terminal',
    );
    expect(next.seq).toBe(40);
    expect(next.executionSelections).toMatchObject([{ requestedSeq: 30, deliveredEndSeq: 40 }]);
  });

  it('resumes Still waiting on #n after the next request, and admits queued #n+1 on a fresh wait', async () => {
    const f = waitExecutions();
    f.request('a', 10);
    const cut = await nextOfType(f.stream({ jobIds: ['a'], timeoutSeconds: 1 }), 'waiting');
    expect(cut.executionSelections).toEqual([selected('a', 10)]);
    f.end('a', 20);
    f.request('a', 30, true);
    const resumed = await nextOfType(
      f.stream({ jobIds: ['a'], cursor: cut.cursor ?? undefined, executionSelections: cut.executionSelections }),
      'terminal',
    );
    expect(resumed.seq).toBe(20);
    const fresh = f.stream({ jobIds: ['a'], timeoutSeconds: 1 });
    expect((await fresh.next()).value).toEqual({ type: 'admission', executionSelections: [selected('a', 30)] });
    expect(await nextOfType(fresh, 'queued')).toMatchObject({ jobId: 'a' });
    await fresh.return(undefined);
  });

  it('pins nothing for unknown or deferred observations', () => {
    const f = waitExecutions();
    const request = { jobIds: ['a'] };
    const session = new WaitSession(['a'], undefined, TEST_EPOCH);
    session.reconcile([{ jobId: 'a', disposition: 'unknown' }]);
    session.reconcile([
      { jobId: 'a', disposition: 'admitted', observationDeferred: true, selection: selected('a', 1) },
    ]);
    expect(session.executionSelections()).toEqual([]);
    expect(f.coordinator.readWaitAdmission('a', TEST_EPOCH, request).selection).toBeUndefined();
    f.request('a', 10);
    f.end('a', 20);
    f.request('a', 30, true);
    expect(f.coordinator.readWaitAdmission('a', TEST_EPOCH, request).selection).toEqual(selected('a', 30));
  });

  it('keeps A#2 after B#1 ends at 50 while A#1 ended at 80 and A#2 requested at 100', async () => {
    const f = waitExecutions();
    f.request('b', 1);
    f.end('b', 50);
    f.request('a', 2);
    f.end('a', 80);
    f.request('a', 100);
    const first = await nextOfType(f.stream({ jobIds: ['a', 'b'], drainProgress: true }), 'terminal');
    expect(first).toMatchObject({ jobId: 'b', seq: 50, cursor: '50', remainingJobIds: ['a'] });
    expect(first.executionSelections).toEqual([selected('a', 100), { ...selected('b', 1), deliveredEndSeq: 50 }]);
    f.end('a', 120);
    f.request('a', 130);
    const resumed = await collect(
      f.stream({ jobIds: ['a'], cursor: '50', executionSelections: first.executionSelections }),
    );
    expect(resumed.filter((event) => event.type === 'terminal')).toMatchObject([{ jobId: 'a', seq: 120 }]);
    expect(resumed.at(-1)).toMatchObject({
      executionSelections: expect.arrayContaining([{ ...selected('b', 1), deliveredEndSeq: 50 }]),
    });
  });

  it('preserves A#2 and delivered-end acknowledgements when progress holds W=279 below A#1 end=900', async () => {
    const f = waitExecutions();
    f.request('a', 1);
    f.addProgress('a', 800, 'earlier A execution');
    f.end('a', 900);
    f.request('a', 1000);
    f.request('b', 2);
    for (let seq = 30; seq < 880; seq++) f.addProgress('b', seq, `b${seq}\nline`);
    f.end('b', 950);
    const read = {
      jobIds: ['a', 'b'],
      cursor: '29',
      executionSelections: [selected('a', 1000), selected('b', 2)],
      timeoutSeconds: 1,
    };
    const delivered = await nextOfType(f.stream(read), 'terminal');
    const input = [selected('a', 1000), { ...selected('b', 2), deliveredEndSeq: 950 }];
    expect(delivered).toMatchObject({ jobId: 'b', seq: 950, cursor: '279', executionSelections: input });
    const cut = await nextOfType(
      f.stream({ ...read, cursor: delivered.cursor ?? undefined, executionSelections: delivered.executionSelections }),
      'waiting',
    );
    expect(cut.endedBy).toBe('progress-budget');
    expect(cut.executionSelections).toEqual(input);
    expect(cut.cursor).toBe('529');
    const rpc = jobWaitSchema.parse(
      jobsWaitRequest({
        ...read,
        projectRoot: '/tmp',
        cursor: cut.cursor ?? undefined,
        executionSelections: cut.executionSelections,
      }),
    );
    expect(rpc.executionSelections).toEqual(input);
    expect(waitContinuationCommand(['a', 'b'], cut.cursor, 'bounded')).toBe(
      `coral-cli jobs wait a b --cursor ${cut.cursor}`,
    );
    const events = await collect(
      f.stream({ ...read, cursor: cut.cursor ?? undefined, executionSelections: cut.executionSelections }),
    );
    expect(events.filter((event) => event.type === 'terminal')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ executionSelections: input });
  });

  it('admits the latest execution for a bare cursor and refuses invalid delivered boundaries', () => {
    const f = waitExecutions();
    f.request('a', 10);
    f.end('a', 20);
    f.request('a', 30);
    expect(f.coordinator.readWaitAdmission('a', TEST_EPOCH, { jobIds: ['a'], cursor: '0' })).toMatchObject({
      selection: { requestedSeq: 30, awaitingArtifact: false },
    });
    expect(() =>
      f.coordinator.readWaitAdmission('a', TEST_EPOCH, {
        jobIds: ['a'],
        executionSelections: [{ ...selected('a', 10), deliveredEndSeq: 21 }],
      }),
    ).toThrow(expect.objectContaining({ code: 'wait_selection_invalid' }));
    expect(
      f.coordinator.readWaitAdmission('a', TEST_EPOCH, { executionSelections: [selected('a', 999)] }),
    ).toMatchObject({ disposition: 'unknown' });
    expect(
      f.coordinator.readWaitAdmission('a', TEST_EPOCH, {
        executionSelections: [{ ...selected('a', 10), epochKey: 'lost-epoch' }],
      }),
    ).toMatchObject({ disposition: 'unknown' });
  });

  it('should infer no delivery from a bare cursor, so a resumed wait prints the latest terminal again', async () => {
    const f = waitExecutions();
    f.request('a', 10);
    f.end('a', 20);
    f.request('a', 30);
    f.end('a', 40);
    const events = await collect(f.stream({ jobIds: ['a'], cursor: '45' }));
    expect(events.filter((event) => event.type === 'terminal')).toEqual([expect.objectContaining({ execution: 2 })]);
  });

  it('keeps an artifact-pending selection through reconnect until its artifact disposition is delivered', async () => {
    const f = waitExecutions();
    f.request('a', 10);
    f.end('a', 20);
    f.pendingArtifacts.add('a#1');
    const pending = await nextOfType(f.stream({ jobIds: ['a'] }), 'terminal');
    expect(pending.executionSelections).toEqual([
      { ...selected('a', 10), deliveredEndSeq: 20, awaitingArtifact: true },
    ]);
    f.request('a', 30);
    f.end('a', 40);
    f.pendingArtifacts.clear();
    const artifact = await nextOfType(
      f.stream({
        jobIds: ['a'],
        cursor: pending.cursor ?? undefined,
        executionSelections: pending.executionSelections,
      }),
      'terminal',
    );
    expect(artifact.seq).toBe(20);
    expect(artifact.resultPath).toContain('/executions/1/');
    expect(artifact.executionSelections).toEqual([
      { ...selected('a', 10), deliveredEndSeq: 20, awaitingArtifact: false },
    ]);
  });

  it('carries validated state through stream decoding and snapshots', () => {
    const f = waitExecutions();
    f.request('a', 10);
    f.end('a', 20);
    const session = new WaitSession(['a'], undefined, TEST_EPOCH);
    session.reconcile(f.coordinator.readWaitAdmissions(['a'], TEST_EPOCH, {}));
    const snapshot = selectWaitSnapshot(session, 20, f.visit);
    expect(snapshot.executionSelections).toEqual([{ ...selected('a', 10), deliveredEndSeq: 20 }]);
    expect(
      parseWaitStreamEventValue({
        type: 'cursor',
        cursor: snapshot.cursor,
        executionSelections: snapshot.executionSelections,
      }),
    ).toMatchObject({ executionSelections: snapshot.executionSelections });
    expect(() => waitExecutionSelectionsSchema.parse([{ ...selected('a', 10), awaitingArtifact: true }])).toThrow();
    expect(() => waitExecutionSelectionsSchema.parse([selected('a', 10), selected('a', 30)])).toThrow();
  });
});
