import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const UNIT_TIER_ROOTS = ['tests/unit'] as const;

// A test that boots a coordinator opens a real IPC server and mutates `process.env.HOME` while it
// composes a runtime. `vitest/default.ts` runs the unit tier on the threads pool with several workers
// sharing one process, so such a test is exposed to whatever else that process is doing; only
// `vitest/integration.ts` (`pool: 'forks'`, one worker) isolates it. A flake that reproduces on CI and
// not on a developer's machine is the shape that exposure takes, and it does not name its cause.
const BOOT_HARNESS = 'createHandoffCoresHarness';

function testFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.test.ts')) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe('coordinator boot tests are isolated', () => {
  it('keeps every test that boots a coordinator out of the shared-process unit tier', () => {
    const offenders = UNIT_TIER_ROOTS.flatMap(testFilesUnder).filter((path) =>
      readFileSync(path, 'utf-8').includes(BOOT_HARNESS),
    );

    expect(offenders, `move these under tests/integration/, which runs one forked worker`).toEqual([]);
  });
});
