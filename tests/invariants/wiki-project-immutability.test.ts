import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KB_SRC = join(REPO_ROOT, 'src/kb');

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

describe('wiki project field immutability', () => {
  // `project` is set once at wiki create time and has no update path. Within
  // src/kb/ the only `.project` field belongs to KbWikiFrontmatter / WikiEntry
  // (workflow ProjectSource lives elsewhere). Any assignment expression
  // mutating `<expr>.project` inside src/kb/ would be a wiki-project mutation.
  it('does not mutate `.project` on any KB wiki record', () => {
    // Pattern excludes `=>` (arrow body / return type) and `==`/`===` (equality)
    // so it only matches assignment expressions on the `.project` member.
    const matches = collectMatches(
      listTypescriptFiles(KB_SRC),
      /\.project\s*=[^>=]/g,
    );

    expect(matches).toEqual([]);
  });
});
