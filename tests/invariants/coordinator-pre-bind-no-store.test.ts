import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const COMPOSITION_ROOT = join(REPO_ROOT, 'src/coordinator/composition');

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

function listTypescriptFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return listTypescriptFiles(path);
      }
      return path.endsWith('.ts') ? [path] : [];
    })
    .sort();
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function collectMatches(files: readonly string[], pattern: RegExp): string[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(pattern)].map((match) => `${repoPath(file)}:${lineOf(source, match.index ?? 0)}`);
  });
}

describe('coordinator pre-bind store access invariants', () => {
  it('does not expose retired concrete progress store handles from composition', () => {
    const matches = collectMatches(
      listTypescriptFiles(COMPOSITION_ROOT),
      /\b(?:world\.progressStore|coreResult\.progressStore)\b/g,
    );

    expect(matches).toEqual([]);
  });

  it('does not call backend store openers during createCoordinatorCore construction', () => {
    // Scan the entire composition directory so that a future split (e.g.,
    // store-bootstrap.ts) cannot silently bypass the invariant.
    const matches = collectMatches(
      listTypescriptFiles(COMPOSITION_ROOT),
      /\b(?:openOrResetBackendStoreDb|openBackendStoreDb)\s*\(/g,
    );

    expect(matches).toEqual([]);
  });
});
