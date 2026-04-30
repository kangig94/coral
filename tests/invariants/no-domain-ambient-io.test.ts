// Cluster K invariant — domain modules must reach I/O / randomness / env /
// subprocess through Runtime ports. This is the structural complement to the
// per-method ambient-runtime check in architecture-boundary.test.ts; this one
// scans imports of `node:fs`, `node:os`, `node:child_process`, and the
// randomness surface of `node:crypto` (`randomUUID`, `randomBytes`) under
// `src/kb/`, `src/providers/`, and `src/jobs/`. The composition root for the
// claude appserver subprocess (`src/providers/claude-appserver/server.ts`) is
// exempt: it is its own subprocess bootstrap and may import ambient I/O
// directly.
//
// `createHash` from `node:crypto` is pure compute (deterministic, no I/O, no
// randomness) and stays — the invariant does not flag it.
//
// Bare-global timers (`setTimeout`, `setInterval`, `clearTimeout`,
// `clearInterval`) are also forbidden: domain modules must reach the time
// port (`kb.time.setTimeout`, `runtime.time.setInterval`, etc.). Member
// access on `.time.` is allowed; bare identifiers leak ambient timer state
// past the Runtime boundary.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCOPED_ROOTS = ['src/kb', 'src/providers', 'src/jobs', 'src/store'] as const;
const TIMER_SCOPED_ROOTS = [
  'src/kb',
  'src/jobs',
  'src/sessions',
  'src/discuss',
  'src/workflow',
  'src/providers',
] as const;
const EXEMPT_FILES = new Set([
  // Subprocess composition root — its own bootstrap entrypoint.
  'src/providers/claude-appserver/server.ts',
  // store/db.ts bridges the StoragePort to ambient better-sqlite3. The
  // `existsSync` here is a real-fs sanity check that decides whether to use
  // the disk path or fall back to `:memory:` — better-sqlite3 itself uses
  // ambient node:fs, so this check has to query the same surface to stay
  // honest. Documented in the file with an inline rationale.
  'src/store/db.ts',
]);
const TIMER_EXEMPT_FILES = new Set<string>([
  // Local port interface: the `setTimeout` / `clearTimeout` identifiers here
  // are method signatures defining a structural alias for the runtime time
  // port, not runtime calls. The controller receives the port through DI.
  'src/kb/corpus/mutation-lock.ts',
]);

function listSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [join(REPO_ROOT, root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        collected.push(absolute);
      }
    }
  }
  return collected;
}

function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

function canonicalSrcPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function importsNodeFs(source: string): boolean {
  // Match both `node:fs` and `node:fs/promises` (the async surface). Domain
  // code MUST NOT import either; sync I/O goes through `StoragePort` and
  // async file work — when needed at all — should be added to the port.
  return /from\s+['"]node:fs(?:\/promises)?['"]/u.test(source) || /import\s+['"]node:fs(?:\/promises)?['"]/u.test(source);
}

function importsNodeOs(source: string): boolean {
  return /from\s+['"]node:os['"]/u.test(source) || /import\s+['"]node:os['"]/u.test(source);
}

function importsNodeChildProcess(source: string): boolean {
  return /from\s+['"]node:child_process['"]/u.test(source) || /import\s+['"]node:child_process['"]/u.test(source);
}

/**
 * Strips TypeScript line comments, block comments, and string literals from
 * a source so identifier scans never trip on quoted names or commented
 * examples. Backtick strings drop their interpolations as well — for the
 * timer scan we only care about whether the bare identifier appears in
 * executable / declarative code, not inside a template literal payload.
 */
function stripCommentsAndStrings(source: string): string {
  let result = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  result = result.replace(/(^|\n)\s*\/\/[^\n]*/gu, '$1');
  result = result.replace(/'(?:\\.|[^'\\])*'/gu, "''");
  result = result.replace(/"(?:\\.|[^"\\])*"/gu, '""');
  result = result.replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/gu, '``');
  return result;
}

/**
 * Returns the bare-global timer identifiers found in a source file (after
 * stripping comments and string literals). A bare identifier is one that
 * is NOT preceded by `.` — member access (`time.setTimeout`) is allowed.
 */
function findBareTimerIdentifiers(source: string): string[] {
  const cleaned = stripCommentsAndStrings(source);
  const pattern = /(^|[^.\w$])(setTimeout|setInterval|clearTimeout|clearInterval)\b/gu;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    found.push(match[2]);
  }
  return found;
}

/**
 * Detects `import { ... randomUUID ... } from 'node:crypto'` or
 * `import { ... randomBytes ... } from 'node:crypto'`. `createHash` is
 * deliberately NOT flagged — pure compute is allowed.
 */
function importsNodeCryptoRandomness(source: string): boolean {
  const namedImportPattern = /import\s*\{([^}]+)\}\s*from\s*['"]node:crypto['"]/gu;
  let match: RegExpExecArray | null;
  while ((match = namedImportPattern.exec(source)) !== null) {
    const names = match[1]
      .split(',')
      .map((name) =>
        name
          .trim()
          .split(/\s+as\s+/u)[0]
          ?.trim(),
      )
      .filter((name): name is string => Boolean(name));
    if (names.includes('randomUUID') || names.includes('randomBytes')) {
      return true;
    }
  }
  return false;
}

describe('domain modules use Runtime ports for ambient I/O', () => {
  it('no domain file imports node:fs (use runtime.storage)', () => {
    const violations: string[] = [];
    for (const root of SCOPED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = canonicalSrcPath(filePath);
        if (EXEMPT_FILES.has(canonical)) continue;
        if (importsNodeFs(readSource(filePath))) {
          violations.push(canonical);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no domain file imports node:os (use runtime.env / runtime.paths)', () => {
    const violations: string[] = [];
    for (const root of SCOPED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = canonicalSrcPath(filePath);
        if (EXEMPT_FILES.has(canonical)) continue;
        if (importsNodeOs(readSource(filePath))) {
          violations.push(canonical);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no domain file imports node:child_process (use runtime.process)', () => {
    const violations: string[] = [];
    for (const root of SCOPED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = canonicalSrcPath(filePath);
        if (EXEMPT_FILES.has(canonical)) continue;
        if (importsNodeChildProcess(readSource(filePath))) {
          violations.push(canonical);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no domain file imports randomness from node:crypto (use runtime.ids; createHash is allowed)', () => {
    const violations: string[] = [];
    for (const root of SCOPED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = canonicalSrcPath(filePath);
        if (EXEMPT_FILES.has(canonical)) continue;
        if (importsNodeCryptoRandomness(readSource(filePath))) {
          violations.push(canonical);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no domain file uses bare-global setTimeout / setInterval / clearTimeout / clearInterval (use kb.time / runtime.time)', () => {
    const violations: Array<{ file: string; identifiers: string[] }> = [];
    for (const root of TIMER_SCOPED_ROOTS) {
      for (const filePath of listSourceFiles(root)) {
        const canonical = canonicalSrcPath(filePath);
        if (TIMER_EXEMPT_FILES.has(canonical)) continue;
        const identifiers = findBareTimerIdentifiers(readSource(filePath));
        if (identifiers.length > 0) {
          violations.push({ file: canonical, identifiers });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
