import { describe, expect, it } from 'vitest';
import {
  decodeSerializedWaitCursor,
  decodeWaitCursor,
  serializeWaitCursor,
  waitCursorForJobs,
  waitEpochToken,
  waitJobHash,
} from '#src/jobs/wait/cursor.js';
import type { WaitCursor, WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { advanceWaitRenderCursor } from '#src/jobs/wait/stream-event.js';

const timing = { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 } as const;
const entry = (jobId: string, seq: number, epochKey = 'epoch-E') => ({
  hash: waitJobHash(jobId),
  epoch: waitEpochToken(epochKey),
  seq,
  lineOffset: 0,
  flags: 0,
});

describe('wait cursor codec', () => {
  it.each([
    ['versionless', Buffer.from(JSON.stringify({ afterSeq: 42, deliveredJobIds: ['a'] })).toString('base64url')],
    [
      'v2',
      Buffer.from(
        JSON.stringify({ version: 'jobs.wait.v2', locations: { a: 'e' }, positions: { e: 12 }, deliveredJobIds: [] }),
      ).toString('base64url'),
    ],
    ['prefixed', `jobs.wait.v3:${serializeWaitCursor({ jobs: [entry('a', 3)] })}`],
  ])('refuses a %s token from an older build instead of translating it', (_shape, token) => {
    expect(decodeSerializedWaitCursor(token)).toMatchObject({
      kind: 'rejected',
      error: { code: 'wait_cursor_malformed' },
    });
  });

  it.each([
    { afterSeq: 0 },
    { version: 'jobs.wait.v2', locations: {}, positions: {} },
    { version: 'jobs.wait.v3', jobs: [] },
  ])('refuses a cursor object in another shape: %j', (cursor) => {
    expect(decodeWaitCursor(cursor).kind).toBe('rejected');
  });

  it.each([64, 128])('encodes %i jobs at maximum frontiers under the authenticated header budget', (count) => {
    for (const shared of [true, false]) {
      const cursor = {
        jobs: Array.from({ length: count }, (_, i) => ({
          hash: waitJobHash(`job-${i}`),
          epoch: waitEpochToken(`/absolute/epoch/${shared ? 0 : i}`),
          seq: Number.MAX_SAFE_INTEGER,
          lineOffset: 0xffffffff,
          flags: 3,
        })),
      };
      const encoded = serializeWaitCursor(cursor);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8192);
      expect(encoded).not.toContain('/absolute');
      expect(decodeSerializedWaitCursor(encoded)).toEqual({ kind: 'decoded', cursor });
      const headers = `POST /jobs/wait HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nAuthorization: Bearer ${'a'.repeat(256)}\r\nContent-Type: application/json\r\nLast-Event-ID: ${encoded}\r\nContent-Length: 4096\r\nConnection: keep-alive\r\n\r\n`;
      expect(Buffer.byteLength(headers)).toBeLessThanOrEqual(12288);
    }
  });

  it('round trips unresolved entries and rejects malformed flags, ordinals, lengths and duplicates', () => {
    const cursor = {
      jobs: [
        { hash: waitJobHash('a'), epoch: waitEpochToken('e'), seq: 17, lineOffset: 3, flags: 3 },
        { hash: waitJobHash('u'), epoch: null, seq: 0, lineOffset: 0, flags: 4 },
      ],
    };
    expect(decodeSerializedWaitCursor(serializeWaitCursor(cursor))).toEqual({ kind: 'decoded', cursor });
    expect(waitCursorForJobs(cursor, ['u'])).toEqual({ jobs: [cursor.jobs[1]] });
    expect(waitCursorForJobs(cursor, ['a'])).toEqual({ jobs: [cursor.jobs[0]] });
    for (const bad of [
      { jobs: [{ ...cursor.jobs[0], flags: 8 }] },
      { jobs: [{ ...cursor.jobs[1], flags: 1 }] },
      { jobs: [{ ...cursor.jobs[0], epoch: 1 }] },
      { jobs: [cursor.jobs[0], cursor.jobs[0]] },
      { jobs: [{ ...cursor.jobs[0], flags: 2 }] },
      { jobs: [{ ...cursor.jobs[0], seq: Number.MAX_SAFE_INTEGER + 1 }] },
      { jobs: [{ ...cursor.jobs[0], seq: 1, lineOffset: 0, flags: 4 }] },
    ])
      expect(decodeWaitCursor(bad).kind).toBe('rejected');
    expect(decodeSerializedWaitCursor(serializeWaitCursor(cursor).slice(0, -1)).kind).toBe('rejected');
  });

  it('uses the exact layout bound with no version header', () => {
    const cursor = {
      jobs: Array.from({ length: 128 }, (_, i) => ({
        hash: waitJobHash('j' + i),
        epoch: waitEpochToken('e' + i),
        seq: Number.MAX_SAFE_INTEGER,
        lineOffset: 0xffffffff,
        flags: 3,
      })),
    };
    expect(serializeWaitCursor(cursor)).toHaveLength(6488);
    const shared = { jobs: cursor.jobs.map((job) => ({ ...job, epoch: cursor.jobs[0].epoch })) };
    expect(Buffer.from(serializeWaitCursor(shared), 'base64url')).toHaveLength(2834);
    const bytes = Buffer.from(serializeWaitCursor(cursor), 'base64url');
    bytes[1] = 0;
    expect(decodeSerializedWaitCursor(bytes.toString('base64url')).kind).toBe('rejected');
  });

  it('uses lineage identity for epoch tokens across address spellings', () => {
    const original = JSON.stringify({ storeRoot: '/real/store', epoch: '7', lineageKey: 'lineage:7' });
    const alias = JSON.stringify({ storeRoot: '/alias/store', epoch: '7', lineageKey: 'lineage:7' });
    expect(waitEpochToken(original)).toBe(waitEpochToken(alias));
  });
});

describe('client cursor fold', () => {
  const progress = (jobId: string, seq: number): WaitStreamEvent => ({
    type: 'progress',
    jobId,
    seq,
    message: `${jobId}-${seq}`,
    timing,
    entry: entry(jobId, seq),
  });
  const queued: WaitStreamEvent = {
    type: 'queued',
    jobId: 'a',
    queuePosition: 1,
    runningJobIds: [],
    timing,
    jobKind: 'kb',
    systemTaskId: 't',
  };

  it('never synthesizes a cursor from an event that names no frontier', () => {
    expect(advanceWaitRenderCursor(undefined, queued).cursor).toBeUndefined();
    expect(advanceWaitRenderCursor(undefined, { type: 'notice', message: 'n' }).cursor).toBeUndefined();
    const base: WaitCursor = { jobs: [entry('a', 4)] };
    expect(advanceWaitRenderCursor(base, queued).cursor).toBe(base);
  });

  it('replaces its base with a cursor frame and upserts later entries into that frame only', () => {
    expect(advanceWaitRenderCursor(undefined, progress('a', 3)).cursor).toBeUndefined();
    const frame: WaitCursor = { jobs: [entry('a', 2), entry('b', 9)] };
    const framed = advanceWaitRenderCursor({ jobs: [entry('a', 1)] }, { type: 'cursor', cursor: frame });
    expect(framed).toEqual({ cursor: frame, shouldRender: false });
    expect(advanceWaitRenderCursor(framed.cursor, progress('a', 3)).cursor).toEqual({
      jobs: [entry('a', 3), entry('b', 9)],
    });
  });
});
