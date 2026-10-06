import { expect, it } from 'vitest';
import { z } from 'zod';
import { HistoricalDecodeError, isCodeDefect, sourceReadFailureDisposition } from '#src/jobs/source-read.js';
import { StoreCodecError, StoreDecodeError } from '#src/store/body-codec.js';

it.each([
  [new HistoricalDecodeError('terminal undecodable'), 'settled-unreadable'],
  [new SyntaxError('invalid JSON'), 'settled-unreadable'],
  [new z.ZodError([]), 'settled-unreadable'],
  [Object.assign(new Error('permission denied'), { code: 'EACCES' }), 'transient-unknown'],
  [Object.assign(new Error('guard missing'), { code: 'ENOENT' }), 'transient-unknown'],
  [new Error('database disk image is malformed'), 'transient-unknown'],
  [new Error('unsupported fingerprint'), 'transient-unknown'],
  [new Error('identity cannot be confirmed'), 'transient-unknown'],
  [Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), 'transient-unknown'],
  [Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' }), 'transient-unknown'],
  [new Error('temporarily unavailable'), 'transient-unknown'],
] as const)('classifies %s as %s with a reachable retry exit', (error, disposition) => {
  expect(sourceReadFailureDisposition(error)).toBe(disposition);
});

it.each([
  [new StoreCodecError('Current codec rejected stored event', {}), 'settled-unreadable'],
  [new StoreDecodeError({ column: 'body', raw: '{', parseError: new SyntaxError('x') }), 'settled-unreadable'],
] as const)('settles an active-journal decode failure %s as %s', (error, disposition) => {
  expect(sourceReadFailureDisposition(error)).toBe(disposition);
});

it.each([new TypeError('x'), new RangeError('x'), new ReferenceError('x')])(
  'names %s a code defect that a read path propagates',
  (error) => {
    expect(isCodeDefect(error)).toBe(true);
  },
);

it('does not name a source failure a code defect', () => {
  expect(isCodeDefect(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }))).toBe(false);
  expect(isCodeDefect(new HistoricalDecodeError('row'))).toBe(false);
});
