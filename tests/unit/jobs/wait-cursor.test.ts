import { describe, expect, it } from 'vitest';
import { decodeWaitCursor, encodeWaitCursor } from '#src/jobs/wait/cursor.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { advanceWaitRenderCursor } from '#src/jobs/wait/stream-event.js';

const timing = { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 } as const;

describe('wait cursor codec', () => {
  it('round trips a watermark as its canonical decimal', () => {
    for (const watermark of [0, 60_849, Number.MAX_SAFE_INTEGER]) {
      const cursor = encodeWaitCursor(watermark);
      expect(cursor).toBe(String(watermark));
      expect(decodeWaitCursor(cursor)).toEqual({ kind: 'decoded', watermark });
    }
  });

  it('refuses a sign, a leading zero, a non-integer, overflow and every older build cursor', () => {
    const previousEightCharacter = Buffer.from([0x9c, 0, 0, 0, 0xed, 0xb1]).toString('base64url');
    const v010Json = JSON.stringify({ version: 'jobs.wait.v2', positions: { e: 12 }, locations: { a: 'e' } });
    for (const bad of [
      '-1',
      '01',
      '1.5',
      '1e3',
      '',
      String(Number.MAX_SAFE_INTEGER + 1),
      previousEightCharacter,
      v010Json,
      Buffer.from(v010Json).toString('base64url'),
    ])
      expect(decodeWaitCursor(bad)).toMatchObject({ kind: 'rejected', error: { code: 'wait_cursor_malformed' } });
  });
});

describe('client cursor fold', () => {
  it('replaces the held cursor with a frame or a final event, and keeps it across everything else', () => {
    const progress: WaitStreamEvent = { type: 'progress', jobId: 'a', seq: 3, message: 'a-3', timing };
    expect(advanceWaitRenderCursor('7', progress)).toEqual({ cursor: '7', shouldRender: true });
    expect(advanceWaitRenderCursor('7', { type: 'cursor', cursor: '8' })).toEqual({
      cursor: '8',
      shouldRender: false,
    });
    const waiting: WaitStreamEvent = { type: 'waiting', waitingJobIds: ['a'], cursor: null, exitCode: 75 };
    expect(advanceWaitRenderCursor('8', waiting).cursor).toBeUndefined();
  });
});
