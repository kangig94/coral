import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { it, expect } from 'vitest';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { admitted, savedCursor, TEST_EPOCH } from '#tests/helpers/wait-session.js';

const lines = (from: number, to: number, prefix: string): Array<[number, string]> =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, `${prefix}${from + i}`]);

it('a live job with a >500-line backlog is not reported carrier-unconfirmed on a continuation', async () => {
  // Earlier wait consumed through seq 10.
  const cursor = savedCursor(10);
  const events: unknown[] = [];
  for await (const event of readWaitSession({
    request: { jobIds: ['a'], cursor, timeoutSeconds: 3 },
    activeEpochKey: TEST_EPOCH,
    time: new VirtualTime(),
    read: observeWaitRead(() => [admitted('a', lines(1, 800, 'a'), false, 'E')]),
    visit: testProgressVisit,
    observe: async (session) => {
      await Promise.resolve();
      await Promise.resolve(); // carrier RPC round trip
      session.observeCoverage(['a'], [], 1);
    },
  }))
    events.push(event);
  const last = events.at(-1) as { type: string; carrierUnknownJobIds?: string[]; exitCode?: number };

  expect(last.carrierUnknownJobIds).toBeUndefined();
});
