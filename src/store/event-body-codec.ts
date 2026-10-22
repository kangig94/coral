import type { z } from 'zod';

/**
 * Decoder for the one event-body contract shipped by the current build.
 * Store-format mismatch is handled by destructive reset before reads reach
 * this boundary; there is deliberately no alternate-version translation.
 */
export class EventBodyCodec {
  parse<T, Input>(body: unknown, schema: z.ZodType<T, z.ZodTypeDef, Input>): T {
    return schema.parse(body);
  }
}

export function createEventBodyCodec(): EventBodyCodec {
  return new EventBodyCodec();
}
