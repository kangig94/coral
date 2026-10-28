import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { proveResultArtifactsDurable } from '#src/jobs/terminal/artifact.js';
import { createRealRuntime } from '#src/runtime/real.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('should remember a proof made through the real storage adapter until the artifact changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'coral-artifact-durability-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const jobsRoot = runtime.paths.coral.exports.jobsRoot;
  const resultPath = join(jobsRoot, 'job-1', 'result.md');
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, 'done\n');
  let forced = 0;
  const storage = new Proxy(runtime.storage, {
    get(target, key) {
      if (key === 'fdatasyncSync')
        return (fd: number) => {
          forced += 1;
          target.fdatasyncSync(fd);
        };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  expect(proveResultArtifactsDurable(storage, [resultPath], jobsRoot)).toBe(true);
  expect(proveResultArtifactsDurable(storage, [resultPath], jobsRoot)).toBe(true);
  expect(forced).toBe(1);

  writeFileSync(resultPath, 'done again\n');
  expect(proveResultArtifactsDurable(storage, [resultPath], jobsRoot)).toBe(true);
  expect(forced).toBe(2);
});
