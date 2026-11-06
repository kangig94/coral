import { expect, it } from 'vitest';
import { z } from 'zod';
import { HistoricalDecodeError, isCodeDefect, sourceReadFailureDisposition } from '#src/jobs/source-read.js';
import { ProjectionConversationMalformedError, ProjectionJobDecodeError } from '#src/jobs/records.js';
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

it.each([
  new ProjectionConversationMalformedError('job', new SyntaxError('facet JSON'), null, null),
  new ProjectionJobDecodeError('job', new SyntaxError('diagnostics JSON')),
])('settles typed projection decode evidence before code defects', (error) => {
  expect(sourceReadFailureDisposition(error)).toBe('settled-unreadable');
  expect(isCodeDefect(error)).toBe(false);
});

it('preserves untyped code defects', () => {
  expect(isCodeDefect(new TypeError('unexpected implementation value'))).toBe(true);
});
