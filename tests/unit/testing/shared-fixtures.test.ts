import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type * as ChildProcessModule from 'node:child_process';
import { sharedFixture, reapSharedFixtureStages } from '#tests/helpers/shared-fixtures.js';
import { replaceLiteral } from '../../../vitest/shared-fixtures.js';

const doubles = vi.hoisted(() => ({
  exec: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
  list: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
  touch: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFileSync: doubles.exec,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  existsSync: doubles.exists,
  readFileSync: doubles.read,
  readdirSync: doubles.list,
  statSync: doubles.stat,
  rmSync: doubles.rm,
  utimesSync: doubles.touch,
  mkdirSync: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('keys released fixtures by tag and builder without reading the working sources', () => {
  doubles.exists.mockReturnValue(true);
  doubles.list.mockReturnValue([]);
  doubles.exec.mockReturnValue('released-commit\n');
  doubles.read.mockImplementation((path: string) => {
    expect(path).toContain('vitest/shared-fixtures.ts');
    return 'fixture-builder';
  });
  const tag = 'v0.10.17';
  const key = createHash('sha256')
    .update(tag + 'released-commit' + 'fixture-builder')
    .digest('hex');
  expect(sharedFixture(tag)).toBe(join(tmpdir(), 'coral-shared-fixtures-cache', key, `${tag}.cjs`));
  expect(sharedFixture(tag)).toBe(join(tmpdir(), 'coral-shared-fixtures-cache', key, `${tag}.cjs`));
  expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  // Each hit marks its entry used, which is the order reaping keeps entries by.
  expect(doubles.touch.mock.calls.map(([path]) => path)).toEqual(
    Array.from({ length: 2 }, () => join(tmpdir(), 'coral-shared-fixtures-cache', key)),
  );
});

it('keeps only the most recently used built entries, however many source states keyed them', () => {
  const cache = join(tmpdir(), 'coral-shared-fixtures-cache');
  const entries = Array.from({ length: 70 }, (_, index) => `entry-${index}`);
  doubles.exists.mockReturnValue(true);
  doubles.list.mockReturnValue([...entries].reverse());
  // entry-0 was used last; each later index was used a minute earlier.
  doubles.stat.mockImplementation((path: string) => ({
    mtimeMs: Date.now() - Number(/entry-(\d+)$/.exec(path)?.[1]) * 60_000,
  }));
  reapSharedFixtureStages();
  expect(doubles.rm.mock.calls.map(([path]) => path).sort()).toEqual(
    entries
      .slice(64)
      .map((entry) => join(cache, entry))
      .sort(),
  );
});

it('reclaims stale artifacts while keeping fresh artifacts and live build stages', () => {
  const cache = join(tmpdir(), 'coral-shared-fixtures-cache');
  doubles.exists.mockReturnValue(true);
  doubles.list.mockReturnValue(['old', 'fresh', 'stage-101-abcd', 'stage-102-abcd']);
  doubles.stat.mockImplementation((path: string) => ({
    mtimeMs: Date.now() - (path.endsWith('/old') ? 8 : 1) * 86_400_000,
  }));
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (pid === 102) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  }) as typeof process.kill);
  reapSharedFixtureStages();
  expect(doubles.rm.mock.calls.map(([path]) => path)).toEqual([join(cache, 'old'), join(cache, 'stage-102-abcd')]);
});

it('rejects a literal fixture patch when its source text has drifted', () => {
  expect(replaceLiteral('prefix target suffix', 'target', 'new')).toBe('prefix new suffix');
  expect(() => replaceLiteral('prefix changed suffix', 'target', 'new')).toThrow('Fixture patch did not match: target');
});
