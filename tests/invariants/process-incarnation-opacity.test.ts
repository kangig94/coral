// Process-incarnation opacity invariant — a process's identity is an opaque token compared only by
// equality, and nothing may reconstitute it from a wall-clock reading.
//
// The rule lives primarily in the type: `ProcessIncarnation` is a branded string, so arithmetic,
// ordering, and "within N seconds" are not expressible. This test guards the one thing the type cannot
// catch — a module deriving a *new* absolute timestamp from `/proc/stat` btime and calling it an
// identity, which is exactly the shape that was removed.
//
// It is worth an invariant rather than a comment because prose demonstrably failed here. The previous
// primitive spread to a dozen comparison sites carried by a comment that named an unsound one as
// "Canonical pattern: src/infra/backend-discovery.ts:127,162". A comment can be wrong in the direction
// of the bug; a scan cannot.
//
// What the old shape cost, for anyone tempted to reintroduce it: btime is not a constant. The kernel
// recomputes it on every read as `realtime_now - boottime_now`, and where those clocks advance at
// different rates it climbs — measured at 3 seconds per 23 seconds of wall time on a WSL2 host. A value
// that adds it is therefore an identity plus a noise sample, and two processes comparing it disagree by
// roughly the age gap between their reads. That made a live coordinator look like a different process
// (an installed upgrade could not take over, and died on every session start) and made a live provider
// group look like no process at all (a disappearance receipt was minted for it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const SRC_ROOT = join(process.cwd(), 'src');

/**
 * Comments are stripped before scanning. The rule forbids *reading* the boot clock, not explaining why
 * a module must not — and the modules that were repaired carry exactly that explanation, so a raw text
 * scan would punish the documentation this invariant exists to make unnecessary.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The only module allowed to read the boot clock at all, and only to compose the opaque token. */
const BOOT_CLOCK_OWNER = 'infra/node-process.ts';

describe('process incarnation opacity', () => {
  it('keeps the boot clock out of every module but the incarnation probe', () => {
    const offenders = listProductionSourceFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(BOOT_CLOCK_OWNER))
      .filter((file) => {
        const source = withoutComments(readFileSync(file, 'utf-8'));
        return /\/proc\/stat/.test(source) || /\bbtime\b/.test(source);
      })
      .map((file) => file.slice(SRC_ROOT.length + 1));

    expect(
      offenders,
      'a process identity may not be rebuilt from a boot clock; compare the opaque token instead',
    ).toEqual([]);
  });

  it('does not reintroduce a seconds-valued process start time', () => {
    const offenders = listProductionSourceFiles(SRC_ROOT)
      .filter((file) => {
        const source = withoutComments(readFileSync(file, 'utf-8'));
        return /processStartedAt(Seconds)?\s*[?:]/.test(source);
      })
      .map((file) => file.slice(SRC_ROOT.length + 1));

    expect(
      offenders,
      'the field is an incarnation token, not a timestamp — a name that reads as a time is how it was published into wire payloads and compared across processes',
    ).toEqual([]);
  });
});
