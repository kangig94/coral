import type { z } from 'zod';

import type { EventsRow } from './schema.js';
import type { UpcasterRegistry } from './upcaster-registry.js';

export const BODY_DECODER = new TextDecoder();

export function decodeEventBody(body: Uint8Array | Buffer): unknown {
  return JSON.parse(BODY_DECODER.decode(body));
}

export function encodeEventBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf-8');
}

export interface StoreReadContext {
  readonly schemas: ReadonlyMap<string, z.ZodType>;
  readonly upcasters: UpcasterRegistry;
}

export function decodeBody<T>(
  row: Pick<EventsRow, 'type' | 'body' | 'body_version'> & Partial<Pick<EventsRow, 'stream_kind' | 'stream_id'>>,
  schema: z.ZodType<T>,
  ctx: StoreReadContext,
): T {
  return ctx.upcasters.parseBody(
    row.type,
    row.body_version,
    decodeEventBody(row.body),
    schema,
  );
}

export function decodeStoredBody(
  row: Pick<EventsRow, 'type' | 'body' | 'body_version'>,
  ctx: StoreReadContext,
): unknown {
  const schema = ctx.schemas.get(row.type);
  return schema ? decodeBody(row, schema, ctx) : decodeEventBody(row.body);
}
