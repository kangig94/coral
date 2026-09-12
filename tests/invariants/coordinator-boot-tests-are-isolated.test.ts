import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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

describe('coordinator boot tests decide their own outcome', () => {
  it('pins process liveness wherever a booted core can meet a recorded pid', () => {
    // Startup retires a superseded provider-operation record whose processes are all observed absent,
    // and it observes them through the real process port. Fixture pids are small numbers, so the answer
    // comes from whatever the host runs at those numbers: a busy machine reports EPERM and keeps the
    // record, a container reports ESRCH and retires it. A test that records one and then boots must say
    // which of those it means.
    const offenders = testFilesUnder('tests')
      .filter((path) => {
        const source = readFileSync(path, 'utf-8');
        return (
          source.includes(BOOT_HARNESS) &&
          (source.includes('insertProviderOperation') || source.includes('providerOperationRecord'))
        );
      })
      .filter((path) => !readFileSync(path, 'utf-8').includes('observeLiveness'));

    expect(offenders, 'pass observeLiveness to the harness so the host cannot decide this').toEqual([]);
  });

  it('keeps a test that boots a coordinator out of the unit tier', () => {
    // `vitest/default.ts` runs the unit tier on the threads pool with several workers sharing a process;
    // only `vitest/integration.ts` forks one worker. Booting opens a real IPC server and mutates
    // `process.env.HOME` to compose a runtime, which is what this project calls an integration test.
    const offenders = testFilesUnder('tests/unit').filter((path) => readFileSync(path, 'utf-8').includes(BOOT_HARNESS));

    expect(offenders, 'move these under tests/integration/, which runs one forked worker').toEqual([]);
  });
});
