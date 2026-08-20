import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = process.cwd();
const PROVIDERS_ROOT = join(REPO_ROOT, 'src/providers');

type FaultAuthorityRule = {
  builder: string;
  allowed: Set<string>;
};

const RULES: FaultAuthorityRule[] = [
  {
    builder: 'providerSessionUnavailable',
    allowed: new Set(['src/providers/middleware/session-continuity.ts']),
  },
  {
    builder: 'providerRequestFailed',
    allowed: new Set(['src/providers/claude/provider.ts', 'src/providers/claude/session-kernel.ts']),
  },
];

/** Every canonical `src/...` path that exists, and the runtime import edges between them — used by the
 *  self-checks below. An `allowed` entry naming a builder call that a file merely *contains* is not the
 *  same as that file being reachable from production. */
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(join(REPO_ROOT, 'src'));
const IMPORT_EDGES = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILE_PATHS);
const CANONICAL_FILES = new Set(PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath)));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === '__helpers__') {
        continue;
      }
      walk(fullPath, out);
      continue;
    }

    if (stat.isFile() && entry.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

function toCanonical(filePath: string): string {
  return `src/providers/${relative(PROVIDERS_ROOT, filePath).split('\\').join('/')}`;
}

function isFixtureFile(path: string): boolean {
  return path.includes('/test-fixtures/') || path.includes('/middleware-authority/');
}

function hasBuilderCall(content: string, builder: string): boolean {
  const callPattern = new RegExp(`\\b${builder}\\s*\\(`);
  const definitionPattern = new RegExp(`\\bfunction\\s+${builder}\\s*\\(`);
  return content.split('\n').some((line) => callPattern.test(line) && !definitionPattern.test(line));
}

describe('provider fault producer authority invariants', () => {
  it('pins each fault builder call to the approved production authorities', () => {
    const files = walk(PROVIDERS_ROOT);

    for (const rule of RULES) {
      const matches = files
        .map((filePath) => ({
          path: toCanonical(filePath),
          content: readFileSync(filePath, 'utf-8'),
        }))
        .filter(({ path, content }) => !isFixtureFile(path) && hasBuilderCall(content, rule.builder))
        .map(({ path }) => path)
        .sort();

      expect(matches, `Unexpected producers for ${rule.builder}`).toEqual([...rule.allowed].sort());
    }
  });

  // An allowlist certifies who *may* call a builder, never that anyone does. The check above already confirms
  // each allowed file's text calls the builder, but a file can do that and still be dead. The two checks below
  // catch that shape: an allowed entry naming nothing on disk, or naming a real file nothing in production ever
  // imports.
  it.each(RULES.map((rule) => [rule.builder, rule] as const))(
    '%s: every allowed producer resolves to a real file',
    (_builder, rule) => {
      const missing = [...rule.allowed].filter((entry) => !CANONICAL_FILES.has(entry));
      expect(missing).toEqual([]);
    },
  );

  it.each(RULES.map((rule) => [rule.builder, rule] as const))(
    '%s: every allowed producer is actually imported somewhere in production src/',
    (_builder, rule) => {
      const unexercised = [...rule.allowed].filter(
        (entry) => !IMPORT_EDGES.some((edge) => edge.runtime && edge.target === entry),
      );
      expect(unexercised).toEqual([]);
    },
  );
});
