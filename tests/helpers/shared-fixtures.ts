import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

export function reapSharedFixtureStages(): void {
  const cache = join(tmpdir(), 'coral-shared-fixtures-cache');
  if (!existsSync(cache)) return;
  for (const entry of readdirSync(cache)) {
    const pid = /^stage-(\d+)-/.exec(entry)?.[1];
    if (!pid) continue;
    try {
      process.kill(Number(pid), 0);
    } catch {
      rmSync(join(cache, entry), { recursive: true, force: true });
    }
  }
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
      .update(name + release + fixtureSourceHash(root))
      .digest('hex'),
  );
  const artifact = join(directory, `${name}.cjs`);
  if (existsSync(artifact)) return artifact;
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
