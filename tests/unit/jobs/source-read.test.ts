import { expect, it } from 'vitest';
import { z } from 'zod';
import { HistoricalDecodeError, sourceReadFailureDisposition } from '#src/jobs/source-read.js';
import { StoreCodecError, StoreDecodeError } from '#src/store/body-codec.js';

it.each([
  [new HistoricalDecodeError('terminal undecodable'), 'settled-unreadable'],
  [new SyntaxError('invalid JSON'), 'settled-unreadable'],
  [new z.ZodError([]), 'settled-unreadable'],
  [new StoreCodecError('Current codec rejected stored event', {}), 'settled-unreadable'],
  [new StoreDecodeError({ column: 'body', raw: '{', parseError: new SyntaxError('x') }), 'settled-unreadable'],
  [Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), 'transient-unknown'],
] as const)('classifies %s as %s', (error, disposition) => {
  expect(sourceReadFailureDisposition(error)).toBe(disposition);
});
