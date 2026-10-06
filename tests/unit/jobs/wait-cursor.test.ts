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
const entry = (jobId: string, seq: number) => ({ hash: waitJobHash(jobId), seq });

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
    // An earlier layout of this build: two count bytes, epoch tokens, then 22 bytes per job.
    ['flagged', Buffer.concat([Buffer.from([1, 1]), Buffer.alloc(16), Buffer.alloc(22)]).toString('base64url')],
  ])('refuses a %s token from another build instead of translating it', (_shape, token) => {
    expect(decodeSerializedWaitCursor(token)).toMatchObject({
      kind: 'rejected',
      error: { code: 'wait_cursor_malformed' },
    });
  });

  it.each([
    { afterSeq: 0 },
    { version: 'jobs.wait.v2', locations: {}, positions: {} },
    { version: 'jobs.wait.v3', jobs: [] },
    { jobs: [{ hash: waitJobHash('a'), epoch: null, seq: 0, lineOffset: 0, flags: 4 }] },
  ])('refuses a cursor object in another shape: %j', (cursor) => {
    expect(decodeWaitCursor(cursor).kind).toBe('rejected');
  });

  it('round trips {hash, seq} entries and rejects malformed seqs, lengths and duplicates', () => {
    const cursor = { jobs: [entry('a', 17), entry('u', 0)] };
    expect(decodeSerializedWaitCursor(serializeWaitCursor(cursor))).toEqual({ kind: 'decoded', cursor });
    expect(waitCursorForJobs(cursor, ['u'])).toEqual({ jobs: [cursor.jobs[1]] });
    expect(waitCursorForJobs(cursor, ['a'])).toEqual({ jobs: [cursor.jobs[0]] });
    for (const bad of [
      { jobs: [cursor.jobs[0], cursor.jobs[0]] },
      { jobs: [{ ...cursor.jobs[0], seq: Number.MAX_SAFE_INTEGER + 1 }] },
      { jobs: [{ ...cursor.jobs[0], seq: -1 }] },
      { jobs: [{ ...cursor.jobs[0], hash: 'not-a-hash' }] },
    ])
      expect(decodeWaitCursor(bad).kind).toBe('rejected');
    expect(decodeSerializedWaitCursor(serializeWaitCursor(cursor).slice(0, -1)).kind).toBe('rejected');
  });

  it('encodes 128 jobs at maximum frontiers in 16 bytes each, under the authenticated header budget', () => {
    const cursor = {
      jobs: Array.from({ length: 128 }, (_, i) => ({ hash: waitJobHash(`job-${i}`), seq: Number.MAX_SAFE_INTEGER })),
    };
    const encoded = serializeWaitCursor(cursor);
    expect(Buffer.from(encoded, 'base64url')).toHaveLength(1 + 128 * 16);
    expect(decodeSerializedWaitCursor(encoded)).toEqual({ kind: 'decoded', cursor });
    const headers = `POST /jobs/wait HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nAuthorization: Bearer ${'a'.repeat(256)}\r\nContent-Type: application/json\r\nLast-Event-ID: ${encoded}\r\nContent-Length: 4096\r\nConnection: keep-alive\r\n\r\n`;
    expect(Buffer.byteLength(headers)).toBeLessThanOrEqual(12288);
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
