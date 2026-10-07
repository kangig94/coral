import { describe, expect, it } from 'vitest';
import { decodeWaitCursor, encodeWaitCursor, waitEpochTag } from '#src/jobs/wait/cursor.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { advanceWaitRenderCursor } from '#src/jobs/wait/stream-event.js';

const timing = { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 } as const;

describe('wait cursor codec', () => {
  it('round trips an epoch tag and a 40-bit watermark in exactly eight characters', () => {
    for (const watermark of [
      { epochTag: 0, seq: 0 },
      { epochTag: 255, seq: 2 ** 40 - 1 },
      { epochTag: waitEpochTag('epoch-E'), seq: 123_456_789 },
    ]) {
      const cursor = encodeWaitCursor(watermark);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{8}$/);
      expect(decodeWaitCursor(cursor)).toEqual({ kind: 'decoded', watermark });
    }
    expect(waitEpochTag(':memory:')).toBe(0);
  });

  it('has no cursor for a watermark past 40 bits, and refuses any other string or shape', () => {
    expect(encodeWaitCursor({ epochTag: 1, seq: 2 ** 40 })).toBeNull();
    const v2 = Buffer.from(JSON.stringify({ version: 'jobs.wait.v2', positions: { e: 12 } })).toString('base64url');
    for (const bad of [v2, 'AAAAAAA', 'AAAAAAAAA', 'AAAA+AAA', { jobs: [] }, null, 12])
      expect(decodeWaitCursor(bad)).toMatchObject({ kind: 'rejected', error: { code: 'wait_cursor_malformed' } });
  });
});

describe('client cursor fold', () => {
  it('replaces the held cursor with a frame or a final event, and keeps it across everything else', () => {
    const progress: WaitStreamEvent = { type: 'progress', jobId: 'a', seq: 3, message: 'a-3', timing };
    expect(advanceWaitRenderCursor('AAAAAAAA', progress)).toEqual({ cursor: 'AAAAAAAA', shouldRender: true });
    expect(advanceWaitRenderCursor('AAAAAAAA', { type: 'cursor', cursor: 'AAAAAAAB' })).toEqual({
      cursor: 'AAAAAAAB',
      shouldRender: false,
    });
    const waiting: WaitStreamEvent = { type: 'waiting', waitingJobIds: ['a'], cursor: null, exitCode: 75 };
    expect(advanceWaitRenderCursor('AAAAAAAB', waiting).cursor).toBeUndefined();
  });
});
