import type { ProcessIncarnation } from '#src/infra/node-process.js';

/**
 * A deterministic incarnation token for fixtures.
 *
 * Tests used to write a bare number here, which is exactly the confusion the token exists to end: the
 * value is an opaque identity, not a timestamp, and nothing may order or subtract it. Taking a number
 * keeps existing fixtures readable — the digits still distinguish one incarnation from another — while
 * the result carries the brand, so a test cannot accidentally assert a comparison the production types
 * forbid.
 */
export function testIncarnation(seed: number | string): ProcessIncarnation {
  return `linux:00000000-0000-4000-8000-000000000000:${seed}` as ProcessIncarnation;
}
