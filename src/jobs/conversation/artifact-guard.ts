import { join } from 'node:path';

import type { ArtifactCleanupRuntime } from '../../providers/contract.js';

const artifacts = new Map<string, Promise<void>>();

export async function withJobArtifactGuard<T>(
  runtime: Pick<ArtifactCleanupRuntime, 'paths'>,
  jobId: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const key = join(runtime.paths.coral.exports.jobsRoot, jobId);
  const previous = artifacts.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  artifacts.set(key, turn);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (artifacts.get(key) === turn) artifacts.delete(key);
  }
}
