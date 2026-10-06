import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let sourceHash: string | undefined;
function fixtureSourceHash(root: string): string {
  if (sourceHash) return sourceHash;
  const hash = createHash('sha256');
  for (const directory of ['src', 'tests/fixtures']) {
    for (const file of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
      hash.update(join(file.parentPath, file.name));
      hash.update(readFileSync(join(file.parentPath, file.name)));
    }
  }
  hash.update(readFileSync(join(root, 'vitest/shared-fixtures.ts')));
  sourceHash = hash.digest('hex');
  return sourceHash;
}

/**
 * Every source edit keys a fresh entry for each fixture, so the cache keeps only the entries used last: room for every
 * fixture of a few source states run side by side, while an entry a running suite has just used is never the oldest.
 */
const RETAINED_FIXTURE_ENTRIES = 64;

export function reapSharedFixtureStages(): void {
  const cache = join(tmpdir(), 'coral-shared-fixtures-cache');
  if (!existsSync(cache)) return;
  const built: Array<{ path: string; usedAt: number }> = [];
  for (const entry of readdirSync(cache)) {
    const pid = /^stage-(\d+)-/.exec(entry)?.[1];
    if (!pid) {
      const usedAt = statSync(join(cache, entry)).mtimeMs;
      if (Date.now() - usedAt > 7 * 86_400_000) rmSync(join(cache, entry), { recursive: true, force: true });
      else built.push({ path: join(cache, entry), usedAt });
      continue;
    }
    try {
      process.kill(Number(pid), 0);
    } catch {
      rmSync(join(cache, entry), { recursive: true, force: true });
    }
  }
  for (const { path } of built.sort((a, b) => b.usedAt - a.usedAt).slice(RETAINED_FIXTURE_ENTRIES))
    rmSync(path, { recursive: true, force: true });
}

export function sharedFixture(name: string): string {
  const root = resolve('.');
  const cache = join(tmpdir(), 'coral-shared-fixtures-cache');
  mkdirSync(cache, { recursive: true });
  reapSharedFixtureStages();
  const release = name.startsWith('v0.')
    ? execFileSync('git', ['rev-parse', name], { cwd: root, encoding: 'utf8' }).trim()
    : '';
  const directory = join(
    cache,
    createHash('sha256')
      .update(
        release
          ? name + release + readFileSync(join(root, 'vitest/shared-fixtures.ts'), 'utf8')
          : name + fixtureSourceHash(root),
      )
      .digest('hex'),
  );
  const artifact = join(directory, `${name}.cjs`);
  if (existsSync(artifact)) {
    // Reaping keeps entries by last use, so a hit marks its entry used.
    try {
      const now = new Date();
      utimesSync(directory, now, now);
      return artifact;
    } catch {
      // Another run reaped it after it was seen, so it is built again.
    }
  }
  const stage = mkdtempSync(join(cache, `stage-${process.pid}-`));
  try {
    execFileSync(process.execPath, [join(root, 'vitest/shared-fixtures.ts'), name, stage, directory], {
      cwd: root,
      stdio: 'pipe',
    });
    return artifact;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
