import { expect, it } from 'vitest';
import { jobWaitSchema, jobWaitSnapshotSchema, waitRequestFromAnotherBuild } from '#src/transport/rpc/jobs.js';

it('refuses duplicate IDs in collections and snapshots', () => {
  expect(jobWaitSchema.safeParse({ jobIds: ['a', 'a'], projectRoot: '/workspace' }).success).toBe(false);
  expect(jobWaitSnapshotSchema.safeParse({ jobIds: ['a', 'a'], projectRoot: '/workspace' }).success).toBe(false);
});

it.each([
  [{ jobIds: ['a'], projectRoot: '/w', cursor: { jobs: [] } }, false],
  [{ jobIds: ['a'], projectRoot: '/w', cursor: { jobs: [{ hash: 'malformed' }] } }, false],
  [{ jobIds: ['a'], projectRoot: '/w' }, true],
  [{ jobIds: ['a'], projectRoot: '/w', cursor: { jobs: [] }, supportsHandover: true }, true],
  [{ jobIds: ['a'], projectRoot: '/w', cursor: { afterSeq: 3 } }, true],
])('names a request formed by another build: %j -> %s', (request, other) => {
  expect(waitRequestFromAnotherBuild(request)).toBe(other);
});
