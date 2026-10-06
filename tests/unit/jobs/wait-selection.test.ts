import { it, expect } from 'vitest';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { admitted } from '#tests/helpers/wait-session.js';

const lines = (from: number, to: number, prefix: string): Array<[number, string]> =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, `${prefix}${from + i}`]);
const unknown = (jobId: string): WaitAdmission => ({ jobId, disposition: 'unknown', message: 'retry' });

it('a resolved member in another epoch keeps its unread lines when two unresolved members resolve together', () => {
  const s1 = new WaitSession(['u', 'v', 'a']);
  s1.reconcile([unknown('u'), unknown('v'), admitted('a', lines(1, 5, 'a'), false, 'E2')]);
  const snap1 = selectWaitSnapshot(s1, 20);

  const s2 = new WaitSession(['u', 'v', 'a'], snap1.cursor);
  s2.reconcile([
    admitted('u', lines(10, 29, 'u'), false, 'E1'),
    admitted('v', lines(30, 2000, 'v'), false, 'E1'),
    admitted('a', lines(1, 50, 'a'), false, 'E2'),
  ]);
  const snap2 = selectWaitSnapshot(s2);

  const s3 = new WaitSession(['u', 'v', 'a'], snap2.cursor);
  s3.reconcile([
    admitted('u', lines(10, 29, 'u'), false, 'E1'),
    admitted('v', lines(30, 2000, 'v'), false, 'E1'),
    admitted('a', lines(1, 50, 'a'), false, 'E2'),
  ]);
  const snap3 = selectWaitSnapshot(s3);

  expect([...snap2.jobs[2].progress, ...snap3.jobs[2].progress]).toContain('a6');
});
