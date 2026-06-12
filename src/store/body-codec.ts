import type { z } from 'zod';

import type { EventsRow } from './schema.js';
import type { UpcasterRegistry } from './upcaster-registry.js';

export const BODY_DECODER = new TextDecoder();

export type StoreDecodeColumn = 'body' | 'refs';

export interface StoreDecodeContext {
  readonly seq?: number;
  readonly type?: string;
  readonly streamKind?: string;
  readonly streamId?: string;
  readonly bodyVersion?: number;
  readonly column?: StoreDecodeColumn;
}

export class StoreDecodeError extends Error {
  readonly code = 'store_decode_failed';
  readonly seq?: number;
  readonly column: StoreDecodeColumn;
  readonly raw: string;
  readonly rawContext: StoreDecodeContext;
  readonly parseError: unknown;

  constructor(context: StoreDecodeContext & { column: StoreDecodeColumn; raw: string; parseError: unknown }) {
    const seqText = context.seq === undefined ? 'unknown seq' : `seq ${context.seq}`;
    super(`Failed to decode events.${context.column} JSON for ${seqText}.`);
    this.name = 'StoreDecodeError';
    this.seq = context.seq;
    this.column = context.column;
    this.raw = context.raw;
    this.rawContext = context;
    this.parseError = context.parseError;
    Object.setPrototypeOf(this, StoreDecodeError.prototype);
  }
}

export function decodeEventJson(raw: string, context: StoreDecodeContext & { column: StoreDecodeColumn }): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new StoreDecodeError({ ...context, raw, parseError: error });
  }
}

export function decodeEventBody(body: Uint8Array | Buffer, context: StoreDecodeContext = {}): unknown {
  return decodeEventJson(BODY_DECODER.decode(body), { ...context, column: context.column ?? 'body' });
}

export function encodeEventBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf-8');
}

export interface StoreReadContext {
  readonly schemas: ReadonlyMap<string, z.ZodType>;
  readonly upcasters: UpcasterRegistry;
}

export function decodeBody<T>(
  row: Pick<EventsRow, 'type' | 'body' | 'body_version'> &
    Partial<Pick<EventsRow, 'seq' | 'stream_kind' | 'stream_id'>>,
  schema: z.ZodType<T>,
  ctx: StoreReadContext,
): T {
  return ctx.upcasters.parseBody(
    row.type,
    row.body_version,
    decodeEventBody(row.body, {
      seq: row.seq,
      type: row.type,
      streamKind: row.stream_kind,
      streamId: row.stream_id,
      bodyVersion: row.body_version,
    }),
    schema,
  );
}

export function decodeStoredBody(
  row: Pick<EventsRow, 'type' | 'body' | 'body_version'> & Partial<Pick<EventsRow, 'seq'>>,
  ctx: StoreReadContext,
): unknown {
  const schema = ctx.schemas.get(row.type);
  return schema
    ? decodeBody(row, schema, ctx)
    : decodeEventBody(row.body, { seq: row.seq, type: row.type, bodyVersion: row.body_version });
}
