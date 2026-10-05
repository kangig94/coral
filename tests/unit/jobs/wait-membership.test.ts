import { it, expect } from 'vitest';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { admitted } from '#tests/helpers/wait-session.js';

const lines = (from: number, to: number, prefix: string): Array<[number, string]> =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, `${prefix}${from + i}`]);

it('sibling B keeps its unread prefix when unresolved U resolves into B epoch (cursor snapshot)', () => {
  // Session 1: fresh snapshot, B running in E with 1..100, U unresolved.
  const s1 = new WaitSession(['b', 'u']);
  const b1 = admitted('b', lines(1, 100, 'b'), false, 'E');
  const u1: WaitAdmission = { jobId: 'u', disposition: 'discovery-unknown', message: 'retry' };
  s1.reconcile([b1, u1]);
  const snap1 = selectWaitSnapshot(s1, 20);

  // B produces 101..200 (unread); U resolves into E with lines 150..160.
  const b2 = admitted('b', lines(1, 200, 'b'), false, 'E');
  const u2 = admitted('u', lines(201, 205, 'u'), false, 'E');
  const s2 = new WaitSession(['b', 'u'], snap1.cursor);
  s2.reconcile([b2, u2]);
  const snap2 = selectWaitSnapshot(s2);
  const bLines = snap2.jobs[0].progress;

  // b101..b200 were never delivered; a cursor continuation must deliver them (prefix) or replay from zero.
  expect(bLines).toContain('b101');
});
