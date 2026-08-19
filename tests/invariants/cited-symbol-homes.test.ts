// A comment that says which file a symbol lives in must be right about it.
//
// This branch's own root cause, made checkable. Three times here a claim was written in prose, was decidable
// against the tree, and was decided by nobody: `classifyThrownExecOutcome (runtime/ports.ts)` after the type
// moved to `infra/port-types.ts`, the same claim again in a TODO entry, and a doc naming `probeWasDecisive`
// after the predicate was replaced. None of them broke a build. Each survived a full CI gate and several
// self-reviews, because the only reader who could falsify them was a person who happened to look.
//
// The rule is narrow on purpose, and the wider forms below were measured and rejected rather than imagined:
//
//   - **Every backticked path must exist.** Measured repo-wide, and the overwhelming majority of the hits
//     are correct writing: deliberate placeholders (`src/xxx.ts` in an agent brief), and — the important
//     ones — historical citations, where a rationale entry names the path something *used* to have precisely
//     to record that it moved (`docs/design-rationale.md` §9 lists `cli/command-client.ts → dispatch.ts` as a
//     fix). A rule banning those would delete the record of the renames it exists to enforce.
//   - **Every backticked identifier must exist somewhere.** Also measured, and again mostly legitimate: a
//     TODO entry naming a schema it *proposes creating*, `.claude/rules/conventions.md` giving
//     `codexOpSchema` as a naming example, and a fixed-defect writeup naming the primitive that was deleted.
//     Distinguishing those from a stale reference needs the tense of the sentence, which a scanner cannot
//     read.
//   - **A `symbol` (`file.ts:LINE`) citation names the symbol's own line.** Measured across the same
//     `docs/todo/*.md` corpus that supplies most citations below, on citations of the form
//     `` `Symbol` (`path/with/a/separator.ts:LINE[-LINE]`) `` or the `in` spelling, checked for whether
//     `Symbol` appears, word-bounded, on the cited line (or within the cited range). A substantial share of
//     the hits are false positives on writing nobody would call wrong — `` `routeLiveIncumbent` (`…backend-routing.ts:40`) ``
//     cites the specific branch inside that function that does what the sentence describes, not the
//     function's own `export function` line four lines above; `` `WaitStreamEvent` (`…wait.ts:68-77`) ``
//     cites that type's terminal union arm, which by construction never repeats the type's own name; a
//     freshly-corrected `` `states` (`…index.ts:150`) `` still "fails" this form because 150 is the
//     enclosing type's opening line and `states` is a field four lines into its body. The convention this
//     codebase actually uses names the enclosing construct and points at a relevant line inside it — not
//     always the symbol's own token — and there is no syntactic tell that separates that from a stale
//     citation. Enforcing exact- or ranged-line symbol presence would fail correct writing about as often as
//     it would catch a real one, so it is not enforced.
//
// What line citations buy instead — sound because it needs no interpretation, only arithmetic — is the
// bounds check below: a cited line or range must fall inside the file it names. Measured against the same
// corpus, requiring a directory separator in the path (the existing policy, next paragraph): every citation
// resolves to exactly one file and its cited line or range falls inside it — zero unresolved, zero ambiguous,
// zero out of bounds, which is what the second `it` below re-asserts on every run. That is not a coincidence
// of a lenient bound — before the citations this branch corrected, the same check caught every multi-hundred-
// line drift this branch fixed (`docs/todo/store-format-routing.md` twice cited `lifecycle.ts:924`/`:1013`
// for calls that had moved to `:1008`/`:1123`, `docs/todo/jobs-read-contract-schema-first.md` cited a range
// 8 lines past the end of a 267-line file). It is exactly the "narrow but sound" trade the two bullets above
// already made: no claim this test cannot decide by counting.
//
// What is left is the one form with no honest reading other than a live claim: a symbol named *together with*
// the file it lives in. There is no reason to write that pair about a symbol that has moved, and every one
// currently in the tree resolves to a single file that mentions the symbol it names — which is what the first
// `it` below re-asserts on every run. So this starts green and stays cheap.
//
// Deliberately not asserted: how many citations exist. A fixed count was tried in an earlier revision of this
// header and it went stale before this file's own PR landed — the corpus is written concurrently by more than
// one author, correct citations are added routinely, not rarely, and a count is exactly the kind of claim
// this file exists to stop someone writing without a way to check it. `toBeGreaterThan` below exists only as
// a canary against a regex silently matching nothing; it is not a substitute for "the count is N" and does
// not try to be.
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

/**
 * A path-with-directory citation carrying an explicit line number or line range in the same backtick span,
 * e.g. a nested path ending `.ts` followed by a colon and one or two digit groups. Deliberately not anchored
 * to a preceding symbol the way `SYMBOL_HOME` is — the header above measured that anchoring and rejected it.
 * This regex only has to find the citation; what it is checked against (file bounds, not symbol position) is
 * what keeps it sound.
 */
const PATH_LINE_CITATION = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|mjs)):(\d+)(?:-(\d+))?`/g;

type Citation = Readonly<{ file: string; line: number; symbol: string; citedPath: string }>;
type LineCitation = Readonly<{ file: string; line: number; citedPath: string; startLine: number; endLine: number }>;

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

function collectLineCitations(cache: Map<string, string>): LineCitation[] {
  const citations: LineCitation[] = [];
  for (const file of ALL_FILES) {
    const lines = readCached(file, cache).split('\n');
    lines.forEach((line, index) => {
      if (!isProse(file, line)) return;
      for (const match of line.matchAll(PATH_LINE_CITATION)) {
        const startLine = Number(match[2]);
        citations.push({
          file: relative(REPO_ROOT, file),
          line: index + 1,
          citedPath: match[1].replace(/^\.\//, ''),
          startLine,
          endLine: match[3] === undefined ? startLine : Number(match[3]),
        });
      }
    });
  }
  return citations;
}

/**
 * `none`: no file in the scanned tree has this repo-relative suffix. `unique`: exactly one does, and it is
 * safe to check claims against. `ambiguous`: two or more files share the cited suffix (a short citation like
 * `provider-proxy-set/index.ts` could in principle name any of several directories with the same tail), and
 * picking the first by scan order would silently grade the claim against a file the citation may not have
 * meant — so an ambiguous citation is reported, not resolved by guessing.
 */
type Resolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'unique'; file: string }>
  | Readonly<{ kind: 'ambiguous'; files: readonly string[] }>;

function resolveCited(citedPath: string): Resolution {
  const matches = ALL_FILES.filter((file) => {
    const repoRelative = relative(REPO_ROOT, file).replace(/\\/g, '/');
    return repoRelative === citedPath || repoRelative.endsWith(`/${citedPath}`);
  });
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', files: matches.map((file) => relative(REPO_ROOT, file)) };
  return { kind: 'unique', file: matches[0] };
}

/** Word-bounded: a substring test would pass `arm` against `alarm` or `warm` — a real drift a citation like
 *  that exists to catch. Symbols only ever contain `[A-Za-z0-9_]` (the capturing group above), so none of
 *  them need escaping to become a safe literal inside this pattern. */
function mentionsSymbol(text: string, symbol: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${symbol}(?![A-Za-z0-9_])`).test(text);
}

describe('a cited symbol lives where the citation says it does', () => {
  const cache = new Map<string, string>();
  const citations = collectCitations(cache);

  it('finds citations to check, so a broken pattern cannot pass as compliance', () => {
    expect(citations.length).toBeGreaterThan(20);
  });

  it('names a file that exists, and only that file', () => {
    const broken = citations
      .map((citation) => ({ citation, resolution: resolveCited(citation.citedPath) }))
      .filter(({ resolution }) => resolution.kind !== 'unique')
      .map(({ citation, resolution }) =>
        resolution.kind === 'none'
          ? `${citation.file}:${citation.line} — \`${citation.symbol}\` in \`${citation.citedPath}\` (no such file)`
          : `${citation.file}:${citation.line} — \`${citation.symbol}\` in \`${citation.citedPath}\` (ambiguous: matches ${(resolution as Extract<Resolution, { kind: 'ambiguous' }>).files.join(', ')})`,
      );

    expect(broken, 'the cited file is gone or the path no longer names one file; move the citation or drop it').toEqual(
      [],
    );
  });

  it('names a file that mentions the symbol', () => {
    const wrongHome = citations
      .filter((citation) => {
        const resolution = resolveCited(citation.citedPath);
        return resolution.kind === 'unique' && !mentionsSymbol(readCached(resolution.file, cache), citation.symbol);
      })
      .map(
        (citation) => `${citation.file}:${citation.line} — \`${citation.symbol}\` is not in \`${citation.citedPath}\``,
      );

    expect(wrongHome, 'the symbol moved; update the citation to its new home').toEqual([]);
  });
});

describe('a path:line citation points inside the file it names', () => {
  const cache = new Map<string, string>();
  const lineCitations = collectLineCitations(cache);

  it('finds line citations to check, so a broken pattern cannot pass as compliance', () => {
    expect(lineCitations.length).toBeGreaterThan(20);
  });

  it('names an unambiguous file whose cited line or range is inside it', () => {
    const broken = lineCitations
      .map((citation) => ({ citation, resolution: resolveCited(citation.citedPath) }))
      .filter(({ citation, resolution }) => {
        if (resolution.kind === 'none') return true;
        if (resolution.kind === 'ambiguous') return true;
        const totalLines = readCached(resolution.file, cache).split('\n').length;
        return citation.endLine > totalLines || citation.startLine < 1;
      })
      .map(({ citation, resolution }) => {
        const span =
          citation.startLine === citation.endLine
            ? `${citation.startLine}`
            : `${citation.startLine}-${citation.endLine}`;
        if (resolution.kind === 'none')
          return `${citation.file}:${citation.line} — \`${citation.citedPath}:${span}\` (no such file)`;
        if (resolution.kind === 'ambiguous') {
          return `${citation.file}:${citation.line} — \`${citation.citedPath}:${span}\` (ambiguous: matches ${resolution.files.join(', ')})`;
        }
        const totalLines = readCached(resolution.file, cache).split('\n').length;
        return `${citation.file}:${citation.line} — \`${citation.citedPath}:${span}\` is outside the file's ${totalLines} lines`;
      });

    expect(broken, 'the cited line moved past the file it names; update the citation').toEqual([]);
  });
});
