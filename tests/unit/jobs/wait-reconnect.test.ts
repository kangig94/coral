import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { advanceWaitRenderCursor } from '#src/jobs/wait/stream-event.js';
import type { WaitCursor, WaitStreamEvent } from '#src/jobs/wait/contract.js';

async function collect(s: AsyncGenerator<WaitStreamEvent>) {
  const out: WaitStreamEvent[] = [];
  for await (const e of s) out.push(e);
  return out;
}

it('a cut inside a progress batch resumes after the last rendered line', async () => {
  // A running job whose earlier lines 1..5 were consumed by a previous wait (cursor C0).
  const job = admitted(
    'a',
    Array.from({ length: 40 }, (_, i) => [i + 1, `line-${i + 1}`]),
    false,
  );
  const read = (cursor?: WaitCursor) =>
    collect(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 0, ...(cursor ? { cursor } : {}) },
        time: new VirtualTime(),
        read: observeWaitRead(() => [job]),
        visit: testProgressVisit,
      }),
    );
  // First collection: tail 20 lines -> waiting event cursor C0.
  const first = await read();
  const c0 = [...first].reverse().find((e) => 'cursor' in e && e.cursor)!;
  // Pretend 10 more lines arrive: simulate by a job with 60 lines.
  const job2 = admitted(
    'a',
    Array.from({ length: 60 }, (_, i) => [i + 1, `line-${i + 1}`]),
    false,
  );
  const read2 = (cursor?: WaitCursor) =>
    collect(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 0, ...(cursor ? { cursor } : {}) },
        time: new VirtualTime(),
        read: observeWaitRead(() => [job2]),
        visit: testProgressVisit,
      }),
    );
  const second = await read2((c0 as { cursor: WaitCursor }).cursor);
  const progress = second.filter((e) => e.type === 'progress');
  expect(progress.every((event) => 'entry' in event)).toBe(true);

  // CLI receives the first 7 events of the batch, renders them, then the stream is cut.
  let state: WaitCursor | undefined = (c0 as { cursor: WaitCursor }).cursor;
  for (const e of progress.slice(0, 7)) state = advanceWaitRenderCursor(state, e).cursor;
  const rendered = progress.slice(0, 7).map((e) => (e as { message: string }).message);
  const retry = await read2(state);
  const replayed = retry.filter((e) => e.type === 'progress').map((e) => (e as { message: string }).message);

  expect(replayed).toEqual(Array.from({ length: 13 }, (_, i) => `line-${i + 48}`));
  expect(replayed.some((line) => rendered.includes(line))).toBe(false);
});
