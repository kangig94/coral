// The hook lane and the daemon must name the same project directory on the same build flavor. This drives
// the actual pair, on both flavors, against the daemon's own path function.

import type * as NodeFs from 'node:fs';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectsPaths } from '#src/infra/path/index.js';

const HOME = '/home/fixture';
const PROJECT_ROOT = '/workspace/some-project';
const REMOTE = 'https://github.com/owner/repo.git\n';

const manifest = vi.hoisted(() => ({ flavor: 'prod' as 'prod' | 'dev' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    // Only the build manifest is answered from the fixture; every other read stays real, because the hook lib
    // reads other files and a blanket stub would make this test pass for the wrong reason.
    readFileSync: (path: unknown, encoding: unknown) =>
      String(path).endsWith('manifest.json')
        ? JSON.stringify({ flavor: manifest.flavor })
        : (actual.readFileSync as (p: unknown, e: unknown) => string)(path, encoding),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => HOME };
});

vi.mock('node:child_process', () => ({ execSync: () => REMOTE }));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe('coralProjectDir agrees with the daemon on both flavors', () => {
  it.each([['prod'], ['dev']] as const)('%s', async (flavor) => {
    manifest.flavor = flavor;

    // Imported after the flavor is set: the hook lib caches its flavor at first read, module-level.
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { coralProjectDir, buildFlavor } = await import('../../../clients/hooks/lib/hook-utils.mjs');

    expect(buildFlavor(), 'the fixture manifest is what the lib actually read').toBe(flavor);
    expect(coralProjectDir(PROJECT_ROOT)).toBe(
      projectsPaths(flavor, { baseDir: join(HOME, '.coral') }).dataDir('owner-repo'),
    );
  });

  it('puts the two flavors in different directories, so agreeing is not agreeing on one name', async () => {
    manifest.flavor = 'prod';
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const prod = (await import('../../../clients/hooks/lib/hook-utils.mjs')).coralProjectDir(PROJECT_ROOT);

    vi.resetModules();
    manifest.flavor = 'dev';
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const dev = (await import('../../../clients/hooks/lib/hook-utils.mjs')).coralProjectDir(PROJECT_ROOT);

    expect(prod).not.toBe(dev);
    expect(dev).toContain('projects-dev');
  });
});
