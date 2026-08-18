// A comment that says which file a symbol lives in must be right about it.
//
// This branch's own root cause, made checkable. Three times here a claim was written in prose, was decidable
// against the tree, and was decided by nobody: `classifyThrownExecOutcome (runtime/ports.ts)` after the type
// moved to `infra/port-types.ts`, the same claim again in a TODO entry, and a doc naming `probeWasDecisive`
// after the predicate was replaced. None of them broke a build. Each survived a full CI gate and several
// self-reviews, because the only reader who could falsify them was a person who happened to look.
//
// The rule is narrow on purpose, and the two wider forms were measured and rejected rather than imagined:
//
//   - **Every backticked path must exist.** 82 hits repo-wide, and the overwhelming majority are correct
//     writing: deliberate placeholders (`src/xxx.ts` in an agent brief), and — the important ones —
//     historical citations, where a rationale entry names the path something *used* to have precisely to
//     record that it moved (`docs/design-rationale.md` §9 lists `cli/command-client.ts → dispatch.ts` as a
//     fix). A rule banning those would delete the record of the renames it exists to enforce.
//   - **Every backticked identifier must exist somewhere.** 22 hits, and again mostly legitimate: a TODO
//     entry naming a schema it *proposes creating*, `.claude/rules/conventions.md` giving `codexOpSchema` as
//     a naming example, and a fixed-defect writeup naming the primitive that was deleted. Distinguishing
//     those from a stale reference needs the tense of the sentence, which a scanner cannot read.
//
// What is left is the one form with no honest reading other than a live claim: a symbol named *together with*
// the file it lives in. There is no reason to write that pair about a symbol that has moved, and 46 of them
// exist in the tree with zero failures — so this starts green and stays cheap.
//
// It checks "the file mentions the symbol", not "the file exports it". A definition, a re-export in an
// `index.ts`, or a mention in that file's own comment are all evidence the reader will be sent somewhere
// useful, and tightening past that would fail on correct citations of a type used but not declared there.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCANNED_ROOTS = ['src', 'tests', 'tools', 'clients/hooks', 'clients/skills', 'docs', '.claude'] as const;
const SCANNED_EXTENSIONS = ['.ts', '.mjs', '.md'] as const;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', 'bridge', 'dist', '.git']);

/**
 * The two spellings the tree uses: a backticked symbol followed by its file in parentheses, or followed by
 * "in" and its file.
 *
 * The path must contain a directory separator. A bare basename cannot be resolved soundly — `session-store.ts`
 * names no single file — and resolving it by first match would let this test assert something it did not
 * check. Citations written that way are simply out of scope rather than silently graded.
 */
const SYMBOL_HOME = /`([A-Za-z_][A-Za-z0-9_]*)`\s*(?:\(|in\s+)`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|mjs))`/g;

type Citation = Readonly<{ file: string; line: number; symbol: string; citedPath: string }>;

function listFiles(root: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [join(REPO_ROOT, root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(full);
      } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        collected.push(full);
      }
    }
  }
  return collected;
}

const ALL_FILES = SCANNED_ROOTS.flatMap(listFiles);

function readCached(file: string, cache: Map<string, string>): string {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const text = readFileSync(file, 'utf-8');
  cache.set(file, text);
  return text;
}

/**
 * Only prose is scanned. In a `.ts` or `.mjs` file that means comment lines: an import specifier or a string
 * literal naming a path is checked by the compiler already, and a citation inside one is not a claim.
 */
function isProse(file: string, line: string): boolean {
  if (file.endsWith('.md')) return true;
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

function collectCitations(cache: Map<string, string>): Citation[] {
  const citations: Citation[] = [];
  for (const file of ALL_FILES) {
    const lines = readCached(file, cache).split('\n');
    lines.forEach((line, index) => {
      if (!isProse(file, line)) return;
      for (const match of line.matchAll(SYMBOL_HOME)) {
        citations.push({
          file: relative(REPO_ROOT, file),
          line: index + 1,
          symbol: match[1],
          citedPath: match[2].replace(/^\.\//, ''),
        });
      }
    });
  }
  return citations;
}

function resolveCited(citedPath: string): string | null {
  return (
    ALL_FILES.find((file) => {
      const repoRelative = relative(REPO_ROOT, file).replace(/\\/g, '/');
      return repoRelative === citedPath || repoRelative.endsWith(`/${citedPath}`);
    }) ?? null
  );
}

describe('a cited symbol lives where the citation says it does', () => {
  const cache = new Map<string, string>();
  const citations = collectCitations(cache);

  it('finds citations to check, so a broken pattern cannot pass as compliance', () => {
    expect(citations.length).toBeGreaterThan(20);
  });

  it('names a file that exists', () => {
    const unresolved = citations
      .filter((citation) => resolveCited(citation.citedPath) === null)
      .map((citation) => `${citation.file}:${citation.line} — \`${citation.symbol}\` in \`${citation.citedPath}\``);

    expect(unresolved, 'the cited file is gone; move the citation or drop it').toEqual([]);
  });

  it('names a file that mentions the symbol', () => {
    const wrongHome = citations
      .filter((citation) => {
        const target = resolveCited(citation.citedPath);
        return target !== null && !readCached(target, cache).includes(citation.symbol);
      })
      .map(
        (citation) => `${citation.file}:${citation.line} — \`${citation.symbol}\` is not in \`${citation.citedPath}\``,
      );

    expect(wrongHome, 'the symbol moved; update the citation to its new home').toEqual([]);
  });
});
