import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { advanceWaitRenderCursor } from '#src/jobs/wait/stream-event.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { admitted } from '#tests/helpers/wait-session.js';

it('fresh stream: CLI render decisions keep every line of a multi-line message', async () => {
  let cursor: WaitCursor | undefined;
  const rendered: string[] = [];
  for await (const event of readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 0 },
    time: new VirtualTime(),
    read: observeWaitRead(() => [
      admitted(
        'a',
        [
          [1, 'one'],
          [2, 'two-a\ntwo-b\ntwo-c'],
          [3, 'three'],
        ],
        false,
        'E',
      ),
    ]),
    visit: testProgressVisit,
  })) {
    const d = advanceWaitRenderCursor(cursor, event);
    cursor = d.cursor;
    if (d.shouldRender && event.type === 'progress') rendered.push(...event.message.split('\n'));
  }

  expect(rendered).toEqual(['one', 'two-a', 'two-b', 'two-c', 'three']);
});

import type { WaitCursor, ProgressVisit, WaitProgressRow, WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { isFinalWaitEvent } from '#src/jobs/wait/contract.js';
import { prefixCursor } from '#tests/helpers/wait-progress.js';

it.each([0, 1, 100, 199, 200, 201, 209])(
  'resumes after cut %i across jobs, epochs, multiline rows and faults, losing and inventing no line',
  async (cut) => {
    const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
    const messages = new Map([
      [
        'a',
        Array.from(
          { length: 200 },
          (_, i) => [6 * i + 1, [0, 1, 2].map((j) => 'a-' + (3 * i + j)).join('\n')] as [number, string],
        ),
      ],
      ['b', Array.from({ length: 7 }, (_, i) => [6 * i + 3, ['b-' + i].join('')] as [number, string])],
      [
        'c',
        [
          [1, 'c-0\nc-1\nc-2'],
          [3, 'c-3\nc-4\nc-5'],
        ] as [number, string][],
      ],
    ]);
    const jobs = [...messages].map(([id, rows]) => ({
      ...admitted(id, rows, true, id === 'c' ? 'E2' : 'E1'),
      detail: { ...admitted(id, rows, true, id === 'c' ? 'E2' : 'E1').detail, terminalSeq: 2000 },
    }));
    const raw = new Map<string, WaitProgressRow[]>(
      [...messages].map(([id, rows]) => [
        id,
        rows
          .flatMap(([seq, message]): WaitProgressRow[] => [{ seq, message, timing }, { seq: seq + 1 }])
          .sort((a, b) => a.seq - b.seq),
      ]),
    );
    const visit: ProgressVisit = (_epoch, read) => ({
      kind: 'read',
      value: read({
        after: (id, after, count) =>
          raw
            .get(id)!
            .filter((row) => row.seq > after)
            .slice(0, count),
        newest: (id, count) => raw.get(id)!.slice(-count),
      }),
    });
    let cursor: WaitCursor | undefined = prefixCursor(jobs);
    let ids = jobs.map((job) => job.jobId);
    const printed = new Map(ids.map((id) => [id, [] as string[]]));
    const fold = (event: WaitStreamEvent) => {
      const decision = advanceWaitRenderCursor(cursor, event);
      cursor = decision.cursor;
      if (event.type === 'progress' && decision.shouldRender)
        printed.get(event.jobId)!.push(...event.message.split('\n'));
      if (isFinalWaitEvent(event)) ids = event.type === 'waiting' ? event.waitingJobIds : event.remainingJobIds;
    };
    const stream = () =>
      readWaitSession({
        request: { jobIds: ids, timeoutSeconds: 0, cursor },
        time: new VirtualTime(),
        read: () => jobs.filter((job) => ids.includes(job.jobId)),
        visit,
      });
    const first = stream();
    for (let index = 0; index < cut; index++) {
      const next = await first.next();
      if (next.done) break;
      fold(next.value);
    }
    await first.return(undefined);
    for (let requests = 0; ids.length && requests < 10; requests++) for await (const event of stream()) fold(event);
    expect(ids).toEqual([]);
    for (const [id, rows] of messages)
      expect(new Set(printed.get(id))).toEqual(new Set(rows.flatMap(([, message]) => message.split('\n'))));
  },
);

it('delivering a readable member preserves a transient sibling frontier for its later read', async () => {
  const jobs = [admitted('a', [[2, 'a-readable']], false), admitted('b', [[1, 'b-held']], false)];
  const collect = async (cursor: WaitCursor, held: boolean) => {
    const events: WaitStreamEvent[] = [];
    for await (const event of readWaitSession({
      request: { jobIds: ['a', 'b'], timeoutSeconds: 0, cursor },
      time: new VirtualTime(),
      read: observeWaitRead(() =>
        jobs.map((job) => (job.jobId === 'b' && held ? { jobId: 'b', disposition: 'unknown' as const } : job)),
      ),
      visit: testProgressVisit,
    }))
      events.push(event);
    return events;
  };
  const initial = prefixCursor(jobs);
  const first = await collect(initial, true);
  expect(first.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual(['a-readable']);
  const last = first.at(-1)!;
  if (last.type !== 'waiting') throw new Error('Expected continuation');
  expect(last.cursor.jobs.find((entry) => entry.hash === initial.jobs[1].hash)).toEqual(initial.jobs[1]);
  const second = await collect(last.cursor, false);
  expect(second.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual(['b-held']);
});
