import { describe, expect, it, vi } from 'vitest';
import { decodeSerializedWaitCursor, decodeWaitCursor } from '#src/jobs/wait-cursor.js';
import { serializeWaitCursor, waitCursorForJobs, type WaitCursor } from '#src/jobs/wait.js';
import { jobWaitSchema, jobsWaitRequest } from '#src/transport/rpc/jobs.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait-stream-event.js';

const v2: WaitCursor = {
  version: 'jobs.wait.v2',
  locations: { a: 'full-epoch-a', b: 'full-epoch-b' },
  positions: { 'full-epoch-a': 12, 'full-epoch-b': 34 },
  deliveredJobIds: ['a'],
};

describe('wait cursor codec', () => {
  it.each([{ afterSeq: 0 }, { afterSeq: 42, deliveredJobIds: ['a'] }, v2])(
    'accepts released v1/v2 cursors unchanged: %j',
    (cursor) => {
      const decoded = decodeSerializedWaitCursor(serializeWaitCursor(cursor));
      expect(decoded).toEqual({ kind: 'decoded', cursor });
      expect(jobWaitSchema.safeParse({ jobIds: ['a'], projectRoot: '/tmp', cursor }).success).toBe(true);
      expect(jobsWaitRequest({ jobIds: ['a'], projectRoot: '/tmp', cursor }, ['supportsWaitV2']).cursor).toBe(cursor);
    },
  );

  it.each(['jobs.wait.v3', 'jobs.wait.v999', null, 2])(
    'rejects an unknown generation even when it has legacy fields: %s',
    (version) => {
      const cursor = { version, afterSeq: 4, positions: {}, locations: {} };
      expect(decodeWaitCursor(cursor)).toMatchObject({ kind: 'rejected', error: { code: 'wait_cursor_unsupported' } });
      expect(decodeSerializedWaitCursor(Buffer.from(JSON.stringify(cursor)).toString('base64url'))).toMatchObject({
        kind: 'rejected',
      });
      expect(jobWaitSchema.safeParse({ jobIds: ['a'], projectRoot: '/tmp', cursor }).success).toBe(false);
    },
  );

  it.each([
    null,
    [],
    { afterSeq: -1 },
    { afterSeq: 0.5 },
    { afterSeq: Number.MAX_SAFE_INTEGER + 1 },
    { afterSeq: 0, deliveredJobIds: ['a', 'a'] },
    { version: 'jobs.wait.v2', positions: {}, locations: { a: 'absent-epoch' } },
    { version: 'jobs.wait.v2', afterSeq: 1 },
    { version: 'jobs.wait.v2', positions: { e: -1 }, locations: { a: 'e' } },
  ])('softly rejects malformed frontiers: %j', (cursor) => {
    expect(decodeWaitCursor(cursor)).toMatchObject({ kind: 'rejected', error: { code: 'wait_cursor_malformed' } });
  });

  it('filters acknowledgements, job locations, and epoch positions for the exact continuation set', () => {
    expect(waitCursorForJobs(v2, ['b'])).toEqual({
      version: 'jobs.wait.v2',
      locations: { b: 'full-epoch-b' },
      positions: { 'full-epoch-b': 34 },
      deliveredJobIds: [],
    });
    expect(waitCursorForJobs({ afterSeq: 7, deliveredJobIds: ['a', 'b'] }, ['b'])).toEqual({
      afterSeq: 7,
      deliveredJobIds: ['b'],
    });
  });

  it('uses the same codec for nested event cursors', () => {
    expect(() =>
      parseWaitStreamEventValue({
        type: 'waiting',
        waitingJobIds: ['a'],
        cursor: { ...v2, version: 'jobs.wait.v999' },
      }),
    ).toThrow();
  });

  it('announces a fresh request only when the coordinator cannot accept a saved v2 cursor', () => {
    const reset = vi.fn();
    const fields = { jobIds: ['a'], projectRoot: '/tmp', cursor: v2 };
    expect(jobsWaitRequest(fields, [], reset)).not.toHaveProperty('cursor');
    expect(reset).toHaveBeenCalledOnce();
    expect(jobsWaitRequest(fields, ['supportsWaitV2'], reset).cursor).toBe(v2);
    expect(reset).toHaveBeenCalledOnce();
  });
});
