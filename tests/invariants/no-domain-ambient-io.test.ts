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

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCOPED_ROOTS = ['src/kb', 'src/providers', 'src/jobs'] as const;
const EXEMPT_FILES = new Set([
  // Subprocess composition root — its own bootstrap entrypoint.
  'src/providers/claude-appserver/server.ts',
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
  return /from\s+['"]node:fs['"]/u.test(source) || /import\s+['"]node:fs['"]/u.test(source);
}

function importsNodeOs(source: string): boolean {
  return /from\s+['"]node:os['"]/u.test(source) || /import\s+['"]node:os['"]/u.test(source);
}

function importsNodeChildProcess(source: string): boolean {
  return /from\s+['"]node:child_process['"]/u.test(source) || /import\s+['"]node:child_process['"]/u.test(source);
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
      .map((name) => name.trim().split(/\s+as\s+/u)[0]?.trim())
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
});
