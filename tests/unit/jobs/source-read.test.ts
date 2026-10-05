import { expect, it } from 'vitest';
import { z } from 'zod';
import { HistoricalDecodeError, sourceReadFailureDisposition } from '#src/jobs/source-read.js';

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
