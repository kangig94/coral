import { expect, it } from 'vitest';
import { jobWaitSchema, jobWaitSnapshotSchema } from '#src/transport/rpc/jobs.js';

it.each([{}, { supportsWaitV2: true }])('deduplicates released legacy wait requests: %j', (flags) => {
  expect(jobWaitSchema.parse({ jobIds: ['a', 'a', 'b'], projectRoot: '/workspace', ...flags }).jobIds).toEqual([
    'a',
    'b',
  ]);
});

it('refuses duplicate IDs in v3 collections and snapshots', () => {
  expect(jobWaitSchema.safeParse({ jobIds: ['a', 'a'], projectRoot: '/workspace', supportsWaitV3: true }).success).toBe(
    false,
  );
  expect(jobWaitSnapshotSchema.safeParse({ jobIds: ['a', 'a'], projectRoot: '/workspace' }).success).toBe(false);
});
