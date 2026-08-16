// The token's admission test, which is platform-neutral and therefore lives beside neither probe.
//
// `isProcessIncarnation` exists so the bound cannot drift: the Zod schema and the hand-written guards on the
// health and signal-ledger paths all ask this one function rather than restating `length > 0 && length <= 256`
// three times. That makes the bound itself load-bearing, and it was pinned only by a single "not a number"
// case — both length conditions could be deleted with the suite green.
//
// Neither bound is decoration. The lower one is what stops `''` — the value an absent or truncated field
// decodes to — from being admitted as an identity and then comparing equal to another absent field, which is
// a match between two processes that were never observed at all. The upper one bounds what a durable record
// or a wire payload can carry into a comparison; the real tokens are well under it (`linux:<uuid>:<digits>`
// is about 60 characters), so the room above is for a format that has not been written yet, not for a field
// that grows unbounded.

import { describe, expect, it } from 'vitest';

import { isProcessIncarnation, processIncarnationSchema, type ProcessIncarnation } from '#src/infra/node-process.js';

const MAX_LENGTH = 256;

describe('process incarnation token admission', () => {
  it('admits a token at both ends of the length bound and refuses one past either', () => {
    const cases = [
      { value: '', admitted: false, why: 'an absent field is not an identity' },
      { value: 'x', admitted: true, why: 'one character is a value, however unlikely a real one' },
      { value: 'x'.repeat(MAX_LENGTH), admitted: true, why: 'the bound is inclusive' },
      { value: 'x'.repeat(MAX_LENGTH + 1), admitted: false, why: 'one past the bound is refused, not truncated' },
    ];

    expect(cases.map(({ value }) => isProcessIncarnation(value))).toEqual(cases.map(({ admitted }) => admitted));
    // The schema is the wire and durable face of the same rule. If these ever disagree, a value refused by one
    // path is admitted by the other, which is the drift the shared guard exists to prevent.
    expect(cases.map(({ value }) => processIncarnationSchema.safeParse(value).success)).toEqual(
      cases.map(({ admitted }) => admitted),
    );
  });

  it('refuses anything that is not a string, however token-shaped', () => {
    const notTokens: readonly unknown[] = [undefined, null, 1_700_000_000, Number.NaN, {}, [], ['linux:a:1']];

    expect(notTokens.map((value) => isProcessIncarnation(value))).toEqual(notTokens.map(() => false));
    expect(notTokens.map((value) => processIncarnationSchema.safeParse(value).success)).toEqual(
      notTokens.map(() => false),
    );
  });

  it('narrows to the branded type, so an admitted value needs no cast at the call site', () => {
    const raw: unknown = 'linux:9f2a1c44-1f3e-4a8b-9d31-6c0f2b7e5a10:774219';
    if (!isProcessIncarnation(raw)) throw new Error('a well-formed token must be admitted');

    // The assignment is the assertion: it compiles only because the guard narrowed `unknown` to the brand.
    // Without that, every caller reaches for `as ProcessIncarnation`, which is the one expression the opacity
    // invariant has to police.
    const token: ProcessIncarnation = raw;
    expect(token).toBe(raw);
  });
});
