import { describe, expect, it } from 'vitest';

import { decodeEventBody, StoreDecodeError } from '#src/store/body-codec.js';
import { rowToCoralEvent } from '#src/store/envelope.js';
import type { EventsRow } from '#src/store/schema.js';

function eventRow(overrides: Partial<EventsRow> = {}): EventsRow {
  return {
    seq: 17,
    ts: '2026-06-12T00:00:00.000Z',
    type: 'test.event',
    stream_kind: 'job',
    stream_id: 'job-1',
    namespace: null,
    project: null,
    correlation_id: null,
    causation_seq: null,
    refs: null,
    body_version: 1,
    body: Buffer.from('{}', 'utf-8'),
    ...overrides,
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('Expected callback to throw.');
}

describe('store decode errors', () => {
  it('wraps corrupt body JSON with the offending seq and raw body', () => {
    const row = eventRow({ body: Buffer.from('{"truncated"', 'utf-8') });
    const error = thrownBy(() =>
      decodeEventBody(row.body, {
        seq: row.seq,
        type: row.type,
        streamKind: row.stream_kind,
        streamId: row.stream_id,
        bodyVersion: row.body_version,
      }),
    );

    expect(error).toBeInstanceOf(StoreDecodeError);
    expect(error).toMatchObject({
      code: 'store_decode_failed',
      seq: 17,
      column: 'body',
      raw: '{"truncated"',
      rawContext: expect.objectContaining({
        seq: 17,
        type: 'test.event',
        streamKind: 'job',
        streamId: 'job-1',
        bodyVersion: 1,
      }),
    });
  });

  it('wraps corrupt refs JSON with the offending seq and raw refs', () => {
    const error = thrownBy(() => rowToCoralEvent(eventRow({ seq: 23, refs: '{"jobId":' }), {}));

    expect(error).toBeInstanceOf(StoreDecodeError);
    expect(error).toMatchObject({
      code: 'store_decode_failed',
      seq: 23,
      column: 'refs',
      raw: '{"jobId":',
      rawContext: expect.objectContaining({
        seq: 23,
      }),
    });
  });
});
