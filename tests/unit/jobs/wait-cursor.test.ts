import { describe, expect, it, vi } from 'vitest';
import { decodeSerializedWaitCursor, decodeWaitCursor } from '#src/jobs/wait/cursor.js';
import { type WaitCursor } from '#src/jobs/wait/contract.js';
import { serializeWaitCursor, waitCursorForJobs } from '#src/jobs/wait/cursor.js';
import { jobWaitSchema, jobsWaitRequest } from '#src/transport/rpc/jobs.js';
import { advanceWaitRenderCursor, parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';

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

  it.each(['jobs.wait.v999', null, 2])(
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
    expect(jobsWaitRequest(fields, ['supportsWaitV3'], reset).cursor).toBe(v2);
    expect(reset).toHaveBeenCalledOnce();
  });
});

it.each([64, 128])('encodes %i jobs at maximum frontiers under the authenticated header budget', async (count) => {
  const { waitEpochToken, waitJobHash } = await import('#src/jobs/wait/cursor.js');
  for (const shared of [true, false]) {
    const cursor = {
      version: 'jobs.wait.v3' as const,
      epochs: Array.from({ length: shared ? 1 : count }, (_, i) => ({
        token: waitEpochToken(`/absolute/epoch/${i}`),
        watermark: Number.MAX_SAFE_INTEGER,
        lineOffset: 0xffffffff,
      })),
      jobs: Array.from({ length: count }, (_, i) => ({
        hash: waitJobHash(`job-${i}`),
        epoch: shared ? 0 : i,
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

it('round trips unresolved entries and rejects malformed v3 flags, ordinals, lengths and duplicates', async () => {
  const { waitEpochToken, waitJobHash } = await import('#src/jobs/wait/cursor.js');
  const cursor = {
    version: 'jobs.wait.v3' as const,
    epochs: [{ token: waitEpochToken('e'), watermark: 17, lineOffset: 3 }],
    jobs: [
      { hash: waitJobHash('a'), epoch: 0, flags: 3 },
      { hash: waitJobHash('u'), epoch: 255, flags: 0 },
    ],
  };
  expect(decodeSerializedWaitCursor(serializeWaitCursor(cursor))).toEqual({ kind: 'decoded', cursor });
  expect(waitCursorForJobs(cursor, ['u'])).toEqual({ version: 'jobs.wait.v3', epochs: [], jobs: [cursor.jobs[1]] });
  expect(waitCursorForJobs(cursor, ['a'])).toEqual({ ...cursor, jobs: [cursor.jobs[0]] });
  for (const bad of [
    { ...cursor, jobs: [{ ...cursor.jobs[0], flags: 8 }] },
    { ...cursor, jobs: [{ ...cursor.jobs[1], flags: 1 }] },
    { ...cursor, jobs: [{ ...cursor.jobs[0], epoch: 1 }] },
    { ...cursor, jobs: [cursor.jobs[0], cursor.jobs[0]] },
    { ...cursor, epochs: [cursor.epochs[0], cursor.epochs[0]] },
    { ...cursor, epochs: [{ ...cursor.epochs[0], watermark: Number.MAX_SAFE_INTEGER + 1 }] },
  ])
    expect(decodeWaitCursor(bad).kind).toBe('rejected');
  expect(decodeSerializedWaitCursor(serializeWaitCursor(cursor).slice(0, -1)).kind).toBe('rejected');
  const reset = vi.fn();
  expect(jobsWaitRequest({ jobIds: ['a'], projectRoot: '/tmp', cursor }, ['supportsWaitV2'], reset)).not.toHaveProperty(
    'cursor',
  );
  expect(reset).toHaveBeenCalledOnce();
  expect(jobsWaitRequest({ jobIds: ['a'], projectRoot: '/tmp', cursor }, ['supportsWaitV3']).cursor).toBe(cursor);
});

it('a legacy progress watermark cannot hide an unrelated terminal or consume its progress', () => {
  const event = {
    type: 'terminal',
    jobId: 'b',
    seq: 3,
    result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
    resultPath: '/result/b',
    remainingJobIds: [],
  } as const;
  const decision = advanceWaitRenderCursor({ afterSeq: 100 }, { ...event, remainingJobIds: [] });
  expect(decision.shouldRender).toBe(true);
  expect(decision.cursor).toEqual({ afterSeq: 100, deliveredJobIds: ['b'] });
  expect(advanceWaitRenderCursor(decision.cursor, { ...event, remainingJobIds: [] }).shouldRender).toBe(false);
});

it('a V3 notice or observation without a cursor preserves collected outcomes and artifact flags', async () => {
  const { WaitSession } = await import('#src/jobs/wait/session.js');
  const { admitted } = await import('#tests/helpers/wait-session.js');
  const a = admitted('a');
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const session = new WaitSession(['a']);
  session.reconcile([a]);
  session.acknowledge(a);
  const cursor = session.cursor();
  expect(
    advanceWaitRenderCursor(cursor, { type: 'notice', version: 'jobs.wait.v3', message: 'progress retired' }).cursor,
  ).toBe(cursor);
});

it('versionless terminal delivery and suppression both advance afterSeq', () => {
  const event = {
    type: 'terminal' as const,
    jobId: 'a',
    seq: 10,
    result: { content: '', outcome: { kind: 'completed' as const }, durationMs: 1 },
    continuity: null,
    remainingJobIds: ['b'],
    resultPath: '/r/a',
  };
  const first = advanceWaitRenderCursor({ afterSeq: 4 }, event);
  expect(first).toMatchObject({ cursor: { afterSeq: 10, deliveredJobIds: ['a'] }, shouldRender: true });
  const hidden = advanceWaitRenderCursor({ afterSeq: 4, deliveredJobIds: ['a'] }, event);
  expect(hidden).toMatchObject({ cursor: { afterSeq: 10 }, shouldRender: false });
});

it('uses lineage identity for V3 tokens and V2 positions across address spellings', async () => {
  const { waitEpochToken, waitEpochPosition } = await import('#src/jobs/wait/cursor.js');
  const original = JSON.stringify({ storeRoot: '/real/store', epoch: '7', lineageKey: 'lineage:7' });
  const alias = JSON.stringify({ storeRoot: '/alias/store', epoch: '7', lineageKey: 'lineage:7' });
  expect(waitEpochToken(original)).toBe(waitEpochToken(alias));
  const cursor = { version: 'jobs.wait.v2' as const, locations: { job: alias }, positions: { [original]: 12 } };
  expect(decodeWaitCursor(cursor).kind).toBe('decoded');
  expect(waitEpochPosition(cursor.positions, alias)).toBe(12);
  expect(waitCursorForJobs(cursor, ['job'])).toEqual(cursor);
});
