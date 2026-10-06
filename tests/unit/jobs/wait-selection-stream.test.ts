import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { admitted } from '#tests/helpers/wait-session.js';

const lines = (from: number, to: number, prefix: string): Array<[number, string]> =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, `${prefix}${from + i}`]);
const unknown = (jobId: string): WaitAdmission => ({ jobId, disposition: 'unknown', message: 'retry' });

it('bounded wait continuation drops a resolved member progress in another epoch', async () => {
  const s1 = new WaitSession(['u', 'v', 'a']);
  s1.reconcile([unknown('u'), unknown('v'), admitted('a', lines(1, 5, 'a'), false, 'E2')]);
  const cursor = selectWaitSnapshot(s1, 20).cursor;
  const delivered: string[] = [];

  for await (const event of readWaitSession({
    request: { jobIds: ['u', 'v', 'a'], cursor, timeoutSeconds: 0 },
    time: new VirtualTime(),
    read: observeWaitRead(() => [
      admitted('u', lines(10, 29, 'u'), false, 'E1'),
      admitted('v', lines(30, 2000, 'v'), false, 'E1'),
      admitted('a', lines(1, 50, 'a'), false, 'E2'),
    ]),
    visit: testProgressVisit,
  })) {
    if (event.type === 'progress') delivered.push(event.message);
  }

  expect(delivered).toContain('a6');
});
