// `src/infra/error-format.ts` owns the "read the errno off wherever Node put it" walk: `thrownErrnoCode`
// checks `error.cause` first, then the thrown value itself, because `fetch` hangs `ECONNREFUSED` off
// `.cause` while other rejections carry a `.code` at the top level. Its docstring argues this is the one
// home for that walk; this file is what enforces it.
//
// Three checks, in decreasing order of soundness:
//
//   1. Nobody defines a function or const named `thrownErrnoCode` or its private helper `errnoCode` outside
//      the canonical file — the literal-name duplication a copy/paste produces.
//   2. The two call sites this walk exists for — `backend/status.ts` and `backend/shutdown.ts`, both of
//      which need it for the same reason, a `fetch` rejection that hides `ECONNREFUSED` behind `.cause` —
//      still import and call the canonical function rather than answering the question locally.
//   3. A bounded, best-effort sweep of the rest of `src/`: inside a `catch` block or a function parameter
//      typed exactly `unknown`, either (a) a chain reading `.cause` off that value with a `.code` at its end,
//      paired with a second, independent read of `.code` off the same identifier (direct, or through an `as`
//      cast), or (b) a single-argument helper called once with that value's `.cause` side and once with the
//      bare value, joined by `??` — the shape `thrownErrnoCode` itself is — is precisely the shape
//      `thrownErrnoCode` exists to own, so a file matching either must import that function.
//
// (3) is bounded, not general, and that is a deliberate, measured choice. The value being unwrapped is
// `unknown`, so a real re-implementation narrows it through an `as` cast or a type-guard helper before
// reading `.code`; widening the match to survive every narrowing shape also starts matching unrelated code —
// a domain type with its own `.cause` field (a control directive's abort cause) and its own unrelated
// `.code` field, or a local variable whose name merely contains the substring "cause". Scoping to a single
// `catch`/`unknown`-parameter block (rather than the whole file) was what took the measured hits on this
// repo's own `.cause`-adjacent code from three false positives to zero; the "historical duplicate" and
// "idiomatic inline form" cases below reproduce, respectively, this walk's own past duplicate
// (`git show 3bf6bb95:src/transport/http/backend/shutdown.ts`, around line 146) and an `as`-cast rewrite of
// it, and assert the scoped match still catches both.
// That is the same trade `cited-symbol-homes.test.ts` documents for its own rejected wider forms: sound
// only by staying bounded, and honest about what a text scan cannot decide — a sufficiently indirect
// rewrite (a helper predicate, a differently-named local) can still evade it.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CANONICAL_FILE = 'src/infra/error-format.ts';
const HOME_PATTERNS = ['thrownErrnoCode', 'errnoCode'];
const KNOWN_CONSUMERS = ['src/transport/http/backend/status.ts', 'src/transport/http/backend/shutdown.ts'];

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf-8');
}

describe('thrownErrnoCode single-home invariant', () => {
  const canonical = read(CANONICAL_FILE);

  it.each(HOME_PATTERNS)(`pattern "%s" is defined only in ${CANONICAL_FILE}`, (pattern) => {
    const definesPattern = new RegExp(`function\\s+${pattern}\\b|const\\s+${pattern}\\s*=`);
    expect(definesPattern.test(canonical)).toBe(true);

    for (const consumer of KNOWN_CONSUMERS) {
      expect(definesPattern.test(read(consumer))).toBe(false);
    }
  });

  it.each(KNOWN_CONSUMERS)(
    '%s imports and calls the canonical thrownErrnoCode instead of unwrapping .cause itself',
    (consumer) => {
      const text = read(consumer);
      expect(text).toMatch(/import\s*\{[^}]*\bthrownErrnoCode\b[^}]*\}\s*from\s*['"][^'"]*infra\/error-format\.js['"]/);
      expect(text).toMatch(/\bthrownErrnoCode\(/);
    },
  );
});

/** A brace-balanced block starting at `openBraceIndex` (the index of its own leading `{`). */
function extractBlock(text: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  return text.slice(openBraceIndex);
}

type Scope = Readonly<{ ident: string; body: string }>;

/** Every `catch (ident)` block and every function whose parameter is typed exactly `ident: unknown`, each
 *  with its own brace-balanced body — the two shapes a value with no static shape is read out of. */
function findUnknownScopes(text: string): Scope[] {
  const scopes: Scope[] = [];
  const catchPattern = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*unknown\s*)?\)\s*\{/g;
  for (const match of text.matchAll(catchPattern)) {
    const brace = text.indexOf('{', match.index);
    scopes.push({ ident: match[1], body: extractBlock(text, brace) });
  }
  const paramPattern = /\([^()]*\b([A-Za-z_$][\w$]*)\s*:\s*unknown\b[^()]*\)\s*(?::\s*[^{=]+)?\s*(?:=>)?\s*\{/g;
  for (const match of text.matchAll(paramPattern)) {
    const brace = text.indexOf('{', match.index);
    scopes.push({ ident: match[1], body: extractBlock(text, brace) });
  }
  return scopes;
}

/**
 * True if `scope` walks `.cause` then a top-level `.code` off the same identifier — the shape
 * `thrownErrnoCode` exists to own — through either of two forms:
 *
 *   (a) A direct chain: `.cause` off `ident` (bare, or through an `as` cast) with a `.code` within reach,
 *       plus a second, independent `.code` read off `ident` that is not that same chain's own terminal
 *       `.code`. The two reads are told apart by match *end* index rather than by scanning nearby text for
 *       the word "cause" — the latter also matches a second `??`-branch sitting a few characters after the
 *       first, which is exactly the shape a one-line rewrite takes.
 *   (b) A delegated walk: a single-argument helper called once with `ident`'s `.cause` side and once with
 *       `ident` bare, joined by `??` — the literal shape `thrownErrnoCode` itself is. This proves both halves
 *       on its own; the helper is where `.code` is read; no `.code` text needs to appear in `scope` at all.
 */
function scopeWalksCauseThenTopLevel(scope: Scope): boolean {
  const { ident, body } = scope;
  const identOrCast = `(?:\\(\\s*${ident}\\s+as\\s+[^)]*\\)\\??|\\b${ident}\\b)`;

  const delegatedWalk = new RegExp(
    `([A-Za-z_$][\\w$]*)\\(\\s*(?:${ident}\\s+instanceof\\s+Error\\s*\\?\\s*)?${identOrCast}\\.cause\\b[^()]*\\)\\s*\\?\\?\\s*\\1\\(\\s*${ident}\\s*\\)`,
  );
  if (delegatedWalk.test(body)) return true;

  const causeChain = new RegExp(`${identOrCast}\\.cause\\b[\\s\\S]{0,120}?\\.code\\b`, 'g');
  const chainEnds = new Set([...body.matchAll(causeChain)].map((match) => match.index + match[0].length));
  if (chainEnds.size === 0) return false;

  const codeAccess = new RegExp(`${identOrCast}\\.code\\b`, 'g');
  for (const match of body.matchAll(codeAccess)) {
    if (!chainEnds.has(match.index + match[0].length)) return true;
  }
  return false;
}

function listSourceFiles(dir: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') collected.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test-d.ts')) {
      collected.push(full);
    }
  }
  return collected;
}

describe('no other src/ module walks .cause then a bare .code on the same identifier', () => {
  const sourceFiles = listSourceFiles(join(ROOT, 'src'));

  it('finds source files to scan, so a broken walk cannot pass as compliance', () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it('flags only a file that also imports the canonical thrownErrnoCode', () => {
    const undeclared = sourceFiles
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
      .filter((relativePath) => relativePath !== CANONICAL_FILE)
      .filter((relativePath) => findUnknownScopes(read(relativePath)).some(scopeWalksCauseThenTopLevel))
      .filter((relativePath) => !/\bthrownErrnoCode\b/.test(read(relativePath)));

    expect(
      undeclared,
      'a .cause-then-.code walk outside error-format.ts must import thrownErrnoCode rather than answer this itself',
    ).toEqual([]);
  });

  // Proof that the detector can fail, run directly against the two shapes a green suite was found not to
  // catch. The first test below reproduces `git show 3bf6bb95:src/transport/http/backend/shutdown.ts` around
  // line 146, before it imported `thrownErrnoCode`; the second is the idiomatic one-line `as`-cast rewrite of
  // the same walk. Both must be caught by `scopeWalksCauseThenTopLevel` directly, not merely by "the suite
  // stays green" — a detector that cannot fail is not a detector.
  it("flags this walk's own historical duplicate", () => {
    const body = `{
      const code = nodeErrnoCode(error instanceof Error ? error.cause : undefined) ?? nodeErrnoCode(error);
      if (code === 'ECONNREFUSED') {
        return { ok: false, reason: 'socket_refused', pidLiveness: observed.pidLiveness };
      }
      return { ok: false, reason: 'no_response', detail: code ?? errorMessage(error) };
    }`;

    expect(scopeWalksCauseThenTopLevel({ ident: 'error', body })).toBe(true);
  });

  it('flags the idiomatic inline `as`-cast rewrite of the same walk', () => {
    const body = `{
      const code = (error as NodeJS.ErrnoException).cause?.code ?? (error as NodeJS.ErrnoException).code;
      return code;
    }`;

    expect(scopeWalksCauseThenTopLevel({ ident: 'error', body })).toBe(true);
  });

  it('does not flag a single `.cause` read with no independent top-level `.code`', () => {
    const body = `{
      const code = (error as NodeJS.ErrnoException).cause?.code;
      return code;
    }`;

    expect(scopeWalksCauseThenTopLevel({ ident: 'error', body })).toBe(false);
  });
});
