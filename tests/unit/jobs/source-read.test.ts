import { expect, it } from 'vitest';
import { z } from 'zod';
import { sourceReadFailureDisposition } from '#src/jobs/source-read.js';

it.each([
  [new SyntaxError('invalid JSON'), 'settled-unreadable'],
  [new z.ZodError([]), 'settled-unreadable'],
  [Object.assign(new Error('permission denied'), { code: 'EACCES' }), 'settled-unreadable'],
  [Object.assign(new Error('guard missing'), { code: 'ENOENT' }), 'settled-unreadable'],
  [new Error('database disk image is malformed'), 'settled-unreadable'],
  [new Error('unsupported fingerprint'), 'settled-unreadable'],
  [new Error('identity cannot be confirmed'), 'settled-unreadable'],
  [Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), 'transient-unknown'],
  [new Error('temporarily unavailable'), 'transient-unknown'],
] as const)('classifies %s as %s with a reachable retry exit', (error, disposition) => {
  expect(sourceReadFailureDisposition(error)).toBe(disposition);
});
