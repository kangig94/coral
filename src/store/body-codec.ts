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

type UpcastRow = Pick<EventsRow, 'type' | 'body_version'> & Partial<Pick<EventsRow, 'stream_kind' | 'stream_id'>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function prepareBodyForUpcast(row: UpcastRow, body: unknown): unknown {
  if (
    row.type === 'session.opened'
    && row.body_version === 1
    && row.stream_kind === 'session'
    && typeof row.stream_id === 'string'
    && isRecord(body)
    && typeof body.sessionId !== 'string'
  ) {
    return {
      ...body,
      sessionId: row.stream_id,
    };
  }

  return body;
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
    prepareBodyForUpcast(row, decodeEventBody(row.body)),
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
