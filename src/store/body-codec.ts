import type { z } from 'zod';

import type { EventsRow } from './schema.js';
import type { EventBodyCodec } from './event-body-codec.js';
import type { StreamKind } from './envelope.js';

const BODY_DECODER = new TextDecoder();

export type StoreDecodeColumn = 'body' | 'refs';

export interface StoreDecodeContext {
  readonly seq?: number;
  readonly type?: string;
  readonly streamKind?: string;
  readonly streamId?: string;
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

export class StoreCodecError extends Error {
  readonly code = 'store_codec_rejected';
  readonly rawContext: StoreDecodeContext;
  readonly parseError?: unknown;

  constructor(message: string, context: StoreDecodeContext, parseError?: unknown) {
    const location = context.seq === undefined ? '' : ` at seq ${context.seq}`;
    super(`${message}${location}.`);
    this.name = 'StoreCodecError';
    this.rawContext = context;
    this.parseError = parseError;
    Object.setPrototypeOf(this, StoreCodecError.prototype);
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
  /** Canonical stream kind for every registered event type. */
  readonly streamKinds: ReadonlyMap<string, StreamKind>;
  readonly bodyCodec: EventBodyCodec;
}

function codecContext(
  row: Pick<EventsRow, 'type' | 'stream_kind'> & Partial<Pick<EventsRow, 'seq' | 'stream_id'>>,
): StoreDecodeContext {
  return {
    seq: row.seq,
    type: row.type,
    streamKind: row.stream_kind,
    streamId: row.stream_id,
    column: 'body',
  };
}

function registeredSchemaFor(
  row: Pick<EventsRow, 'type' | 'stream_kind'> & Partial<Pick<EventsRow, 'seq' | 'stream_id'>>,
  ctx: StoreReadContext,
): z.ZodType {
  const schema = ctx.schemas.get(row.type);
  if (schema === undefined) {
    throw new StoreCodecError(`No registered event body codec for stored type '${row.type}'`, codecContext(row));
  }
  const expectedStreamKind = ctx.streamKinds.get(row.type);
  if (expectedStreamKind === undefined) {
    throw new StoreCodecError(`No registered stream kind for stored type '${row.type}'`, codecContext(row));
  }
  if (row.stream_kind !== expectedStreamKind) {
    throw new StoreCodecError(
      `Stored event type '${row.type}' belongs to stream kind '${expectedStreamKind}', not '${row.stream_kind}'`,
      codecContext(row),
    );
  }
  return schema;
}

export function decodeBody<T>(
  row: Pick<EventsRow, 'type' | 'stream_kind' | 'body'> & Partial<Pick<EventsRow, 'seq' | 'stream_id'>>,
  schema: z.ZodType<T>,
  ctx: StoreReadContext,
): T {
  if (registeredSchemaFor(row, ctx) !== schema) {
    throw new StoreCodecError(
      `Read schema for stored event type '${row.type}' is not its registered current codec`,
      codecContext(row),
    );
  }
  const context = codecContext(row);
  const decoded = decodeEventBody(row.body, context);
  try {
    return ctx.bodyCodec.parse(decoded, schema);
  } catch (error) {
    throw new StoreCodecError(`Current codec rejected stored event type '${row.type}'`, context, error);
  }
}

export function decodeStoredBody(
  row: Pick<EventsRow, 'type' | 'stream_kind' | 'body'> & Partial<Pick<EventsRow, 'seq' | 'stream_id'>>,
  ctx: StoreReadContext,
): unknown {
  const schema = registeredSchemaFor(row, ctx);
  return decodeBody(row, schema, ctx);
}
